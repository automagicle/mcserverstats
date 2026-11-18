// Fills in minutes the once-a-minute check couldn't record (the database refusing writes, say, or the
// status API and the server mod both unreachable), from the chat log's joins, leaves and server
// starts/stops. The server mod keeps chat it couldn't send and sends it later, so those events arrive
// after the outage even though the checks for it are gone.
//
// A gap is two recorded checks more than GAP_MIN apart. It's filled only once the chat log has caught
// up past its end (the mod sends its queue in order, so a later line means the gap's lines are in),
// and at least SETTLE seconds after it ended. For each missing minute it adds a check: whether the
// server was up, and everyone on then, starting from who was on at the check before the gap. Players'
// sessions are extended, joined across the gap or added, and the hourly figures recomputed.
// Once filled, a gap is gone, so running this again changes nothing.
import { POLL_SECONDS } from './poll.js';
import { clearCache } from './cache.js';

const LOOKBACK = 2 * 86400; // how far back to look for gaps (each run reads this many minutes of checks)
const GAP_MIN = 3 * POLL_SECONDS; // at least two missing checks
const SETTLE = 15 * 60;
const SESSION_GAP = 210; // as in poll.js: absent this long or less still counts as one session
const ROWS_PER_INSERT = 20; // D1 allows 100 bound values per statement

export async function fillGaps(env, nowSeconds, { lookback = LOOKBACK } = {}) {
  const db = env.DB;
  const snaps = await db.prepare('SELECT ts, up, max FROM snapshots WHERE ts > ? ORDER BY ts').bind(nowSeconds - lookback).raw();
  const gaps = [];
  for (let i = 1; i < snaps.length; i++) {
    if (snaps[i][0] - snaps[i - 1][0] >= GAP_MIN) gaps.push([snaps[i - 1], snaps[i]]);
  }
  const report = [];
  for (const [[a, upA, maxA], [b]] of gaps) {
    if (nowSeconds - b < SETTLE) { report.push({ from: a, to: b, filled: false, why: 'too recent' }); continue; }
    const caughtUp = await db.prepare('SELECT 1 FROM chat WHERE ts_ms > ? LIMIT 1').bind(b * 1000).first();
    if (!caughtUp) { report.push({ from: a, to: b, filled: false, why: 'chat not caught up yet' }); continue; }
    report.push({ from: a, to: b, filled: true, ...(await fillGap(db, a, b, upA, maxA)) });
  }
  const filled = report.filter((g) => g.filled);
  if (filled.length) await clearCache(db);
  if (filled.length) console.log(`filled ${filled.length} gap(s):`, JSON.stringify(filled));
  return report;
}

async function fillGap(db, a, b, upA, maxA) {
  const [players, hidden, openA, startB, events] = await db.batch([
    db.prepare('SELECT uuid, name FROM players'),
    db.prepare('SELECT name FROM hidden_players'),
    db.prepare('SELECT s.id, s.uuid, p.name FROM sessions s JOIN players p ON p.uuid = s.uuid WHERE s.end_ts = ? AND s.start_ts <= ?').bind(a, a),
    db.prepare('SELECT id, uuid, end_ts FROM sessions WHERE start_ts = ?').bind(b),
    db.prepare(
      `SELECT ts_ms, kind, uuid, name, text FROM chat
       WHERE kind IN ('join', 'leave', 'server') AND ts_ms > ? AND ts_ms <= ? ORDER BY ts_ms, id`
    ).bind(a * 1000, b * 1000),
  ]);
  const skip = new Set(hidden.results.map((r) => r.name.toLowerCase()));
  const known = new Set(players.results.map((p) => p.uuid));
  const exact = new Map(players.results.map((p) => [p.name, p.uuid]));
  // The account a joining name is: the player with exactly that name (an offline-mode server gives
  // "Name" and "name" different accounts), else the UUID the mod logged with the join.
  const accountFor = (e) => exact.get(e.name) || (typeof e.uuid === 'string' && e.uuid ? e.uuid.toLowerCase() : null);

  // who's on, by lowercased name -> { uuid, name }
  const on = new Map();
  for (const s of openA.results) if (!skip.has(s.name.toLowerCase())) on.set(s.name.toLowerCase(), { uuid: s.uuid, name: s.name });
  let up = upA === 1;

  const minutes = [];
  const runs = new Map(); // uuid -> [[from, to], …] minutes on, in order
  const names = new Map(); // uuid -> name, for new players
  let i = 0;
  const ev = events.results;
  for (let t = a + POLL_SECONDS; t < b; t += POLL_SECONDS) {
    for (; i < ev.length && ev[i].ts_ms <= t * 1000; i++) {
      const e = ev[i];
      if (e.kind === 'server') {
        on.clear(); // a start or a stop: nobody carries over
        up = !/stopp/i.test(e.text);
        continue;
      }
      if (!e.name || skip.has(e.name.toLowerCase())) continue;
      const key = e.name.toLowerCase();
      if (e.kind === 'leave') on.delete(key);
      else if (!on.has(key)) {
        const uuid = accountFor(e);
        if (uuid) {
          on.set(key, { uuid, name: e.name });
          names.set(uuid, e.name);
          up = true; // someone joined, so it's running
        }
      }
    }
    const n = up ? on.size : 0;
    minutes.push([t, up ? 1 : 0, n, maxA, n]);
    if (!up) continue;
    for (const { uuid } of on.values()) {
      const r = runs.get(uuid) || [];
      const last = r[r.length - 1];
      if (last && t - last[1] <= SESSION_GAP) last[1] = t;
      else r.push([t, t]);
      runs.set(uuid, r);
    }
  }

  const stmts = [];
  for (let k = 0; k < minutes.length; k += ROWS_PER_INSERT) {
    const rows = minutes.slice(k, k + ROWS_PER_INSERT);
    stmts.push(db.prepare(`INSERT OR IGNORE INTO snapshots (ts, up, online, max, listed) VALUES ${rows.map(() => '(?, ?, ?, ?, ?)').join(', ')}`)
      .bind(...rows.flat()));
  }

  // sessions: carry the one open at the gap's start, join it to one starting right after, or add one
  const before = new Map(openA.results.map((s) => [s.uuid, s.id]));
  const after = new Map(startB.results.map((s) => [s.uuid, s]));
  let extended = 0, joined = 0, added = 0, newPlayers = 0;
  for (const [uuid, list] of runs) {
    for (let k = 0; k < list.length; k++) {
      const [from, to] = list[k];
      const fromA = k === 0 && before.has(uuid) && from - a <= SESSION_GAP;
      const toB = k === list.length - 1 && after.has(uuid) && b - to <= SESSION_GAP;
      if (fromA && toB) {
        const next = after.get(uuid);
        stmts.push(db.prepare('UPDATE sessions SET end_ts = ? WHERE id = ?').bind(next.end_ts, before.get(uuid)),
          db.prepare('DELETE FROM sessions WHERE id = ?').bind(next.id));
        joined++;
      } else if (fromA) {
        stmts.push(db.prepare('UPDATE sessions SET end_ts = ? WHERE id = ?').bind(to, before.get(uuid)));
        extended++;
      } else if (toB) {
        stmts.push(db.prepare('UPDATE sessions SET start_ts = ? WHERE id = ?').bind(from, after.get(uuid).id));
        extended++;
      } else {
        stmts.push(db.prepare('INSERT INTO sessions (uuid, start_ts, end_ts) VALUES (?, ?, ?)').bind(uuid, from, to));
        added++;
      }
    }
    if (!known.has(uuid)) {
      stmts.push(db.prepare('INSERT OR IGNORE INTO players (uuid, name, first_seen) VALUES (?, ?, ?)').bind(uuid, names.get(uuid), list[0][0]));
      known.add(uuid);
      newPlayers++;
    }
  }

  // the hours it touched, worked out again from their checks
  const hours = new Set(minutes.map(([t]) => t - (t % 3600)));
  for (const h of hours) {
    stmts.push(db.prepare(
      `INSERT INTO hourly (hour_ts, samples, up_samples, online_sum, peak)
       SELECT ?1, COUNT(*), SUM(up), SUM(online), MAX(online) FROM snapshots WHERE ts >= ?1 AND ts < ?1 + 3600
       ON CONFLICT(hour_ts) DO UPDATE SET
         samples = excluded.samples, up_samples = excluded.up_samples,
         online_sum = excluded.online_sum, peak = excluded.peak`
    ).bind(h));
  }
  await db.batch(stmts);
  return { minutes: minutes.length, events: ev.length, peak: Math.max(0, ...minutes.map((m) => m[2])), extended, joined, added, newPlayers };
}
