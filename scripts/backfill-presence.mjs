// Fills in, after the fact, players the server-list ping left out of the minute-by-minute checks, using
// the join and leave messages in the chat log.
//
// Each check stored how many players the server reported ("online") and how many of them it named
// ("listed"); only the named ones got playtime. Where the count is higher than the names, this works out
// who the missing players were:
//   1. From the chat log's joins, leaves and "Server started/stopped" messages, when each player was on
//      (a shutdown or restart ends everyone's stay; a stay with no leave runs to the next of those).
//   2. For every check that counted more players than it has sessions for, the players the chat log
//      says were on but who have no session at that minute are the candidates.
//   3. It fills in at most as many as the count was short by, so the history still matches the player
//      counts recorded at the time: never more players at a minute than the server reported. When there
//      are more candidates than missing players, the ones filled in the minute before come first (people
//      stay on), then whoever joined earliest.
//   4. The filled minutes are joined onto the player's sessions the same way the live check joins them
//      (gaps of up to 3.5 minutes), and the check's "listed" count goes up by the players filled in.
// Stays are worked out by name, ignoring case (and merged accounts, player_aliases, count as one person):
// the mod's join and leave messages can carry different UUIDs for one name (a player who logs in as both
// "Name" and "name" has two accounts on an offline-mode server), and someone already counted under any of
// their names at a minute isn't filled in again. A filled-in minute goes to the account with exactly the
// name the join message showed; on an offline-mode server (checked against known players first) a name
// with no account yet gets the UUID the server gives it.
// Hidden players are never filled in. Checks from the last 10 minutes are left to the live check.
//
// It only changes playtime records (sessions, players, snapshots.listed); the per-hour player counts the
// charts' totals use are already right. Running it again changes nothing more.
//
//   node scripts/backfill-presence.mjs                   dry run on the live database: what it would do
//   node scripts/backfill-presence.mjs --apply           do it (first saves an undo file, *-backup.sql)
//   add --local to use the local development database instead
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const where = args.includes('--local') ? '--local' : '--remote';
const apply = args.includes('--apply');
const SESSION_GAP = 210; // as in src/poll.js
const SETTLE = 600;

function query(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mcstats', where, '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  const at = out.indexOf('[\n');
  return JSON.parse(out.slice(at >= 0 ? at : out.indexOf('[')))[0].results;
}
const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const fmt = (t) => new Date(t * 1000).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// The UUID an offline-mode server gives a name.
function offlineUuid(name) {
  const h = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const now = Math.floor(Date.now() / 1000);
const cutoff = now - SETTLE;
console.log(`Reading the ${where.slice(2)} database…`);
const hidden = new Set(query('SELECT name FROM hidden_players').map((r) => r.name.toLowerCase()));
const aliasOf = new Map(query('SELECT alias, name FROM player_aliases').map((r) => [r.alias.toLowerCase(), r.name.toLowerCase()]));
const person = (name) => { const n = String(name || '').toLowerCase(); return aliasOf.get(n) || n; };
const players = query('SELECT uuid, name, first_seen FROM players');
const sessions = query('SELECT id, uuid, start_ts, end_ts FROM sessions');
const events = query("SELECT id, ts_ms, kind, uuid, name, text FROM chat WHERE kind IN ('join', 'leave', 'server') ORDER BY ts_ms, id");
const minutes = query(`SELECT ts, online, listed FROM snapshots WHERE up = 1 AND online > listed AND ts <= ${cutoff} ORDER BY ts`);

// ---- names and UUIDs ----
const known = new Map(players.map((p) => [p.uuid, p]));
const exact = new Map(); // exact name -> uuid (the ping's accounts, newest last)
const loose = new Map(); // lowercased name -> uuid
for (const p of [...players].sort((a, b) => a.first_seen - b.first_seen)) {
  exact.set(p.name, p.uuid);
  loose.set(p.name.toLowerCase(), p.uuid);
}
const offlineMatches = players.filter((p) => offlineUuid(p.name) === p.uuid).length;
const offlineMode = players.length > 0 && offlineMatches / players.length >= 0.9;
console.log(`Offline-mode UUIDs: ${offlineMatches} of ${players.length} known players match, so ${offlineMode ? 'names with no account get the server\'s UUID' : 'names with no account are skipped'}.`);
// the account to give a filled-in minute, for the name a join message showed
// (the ping's account with exactly that name; else the UUID the mod most often logged for that exact name;
// else, on an offline-mode server, the one the server gives that name)
const modIds = new Map(); // exact name -> Map(uuid -> times)
for (const e of events) {
  if (!e.uuid || !e.name) continue;
  if (!modIds.has(e.name)) modIds.set(e.name, new Map());
  const m = modIds.get(e.name);
  m.set(e.uuid.toLowerCase(), (m.get(e.uuid.toLowerCase()) || 0) + 1);
}
const modId = (name) => [...(modIds.get(name) || new Map())].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
const accountFor = (name) => exact.get(name) || modId(name) || (offlineMode ? offlineUuid(name) : null) || null;
const nameOf = new Map(players.map((p) => [p.uuid, p.name]));

// ---- 1. who was on, from the chat log (by person: name ignoring case, merged accounts as one) ----
const stays = []; // { who, name, uuid, a, b }
const open = new Map(); // who -> { name, uuid, a }
const note = { joins: 0, leaves: 0, restarts: 0, repeatJoin: 0, leaveWithoutJoin: 0, unknownName: 0, endedByRestart: 0, stillOn: 0 };
const close = (who, to) => {
  const o = open.get(who);
  stays.push({ who, name: o.name, uuid: o.uuid, a: o.a, b: to });
  open.delete(who);
};
for (const e of events) {
  const t = Math.floor(e.ts_ms / 1000);
  if (e.kind === 'server') {
    note.restarts++;
    for (const who of [...open.keys()]) { close(who, t); note.endedByRestart++; }
    continue;
  }
  if (!e.name) { note.unknownName++; continue; }
  const who = person(e.name);
  if (e.kind === 'join') {
    note.joins++;
    if (open.has(who)) { note.repeatJoin++; continue; } // a missed leave: still on since the first join
    const uuid = accountFor(e.name);
    if (!uuid) { note.unknownName++; continue; }
    if (!nameOf.has(uuid)) nameOf.set(uuid, e.name);
    open.set(who, { name: e.name, uuid, a: t });
  } else {
    note.leaves++;
    if (open.has(who)) close(who, t);
    else note.leaveWithoutJoin++; // joined before the chat log began (or the join wasn't logged): unknown start, skipped
  }
}
for (const who of [...open.keys()]) { close(who, now); note.stillOn++; }

// ---- 2 and 3. fill in the missing players, never past the count ----
const sessionsOf = new Map();
for (const s of sessions) {
  if (!sessionsOf.has(s.uuid)) sessionsOf.set(s.uuid, []);
  sessionsOf.get(s.uuid).push(s);
}
const stayList = stays;
const add = new Map(); // uuid -> [minute ts]
const listedUp = new Map(); // minute ts -> players filled in
let short = 0, filled = 0, unexplained = 0, extraCandidates = 0, prev = new Set(), prevTs = null;
const byDay = new Map();
for (const m of minutes) {
  const coveredRows = sessions.filter((s) => s.start_ts <= m.ts && m.ts <= s.end_ts);
  const covered = new Set(coveredRows.map((s) => s.uuid));
  const coveredPeople = new Set(coveredRows.map((s) => person(nameOf.get(s.uuid))));
  const missing = m.online - covered.size;
  if (missing <= 0) { prev = new Set(); prevTs = m.ts; continue; }
  short += missing;
  const cands = new Map();
  for (const s of stayList) {
    if (s.a > m.ts || m.ts > s.b || covered.has(s.uuid) || coveredPeople.has(s.who)) continue;
    if (hidden.has(s.name.toLowerCase()) || hidden.has(s.who)) continue;
    if (!cands.has(s.uuid) || s.a < cands.get(s.uuid)) cands.set(s.uuid, s.a);
  }
  const keep = prevTs === m.ts - 60 ? prev : new Set();
  const order = [...cands].sort((x, y) => (keep.has(y[0]) - keep.has(x[0])) || x[1] - y[1]).map(([u]) => u);
  const chosen = order.slice(0, missing);
  extraCandidates += Math.max(0, order.length - missing);
  unexplained += missing - chosen.length;
  for (const u of chosen) {
    if (!add.has(u)) add.set(u, []);
    add.get(u).push(m.ts);
  }
  if (chosen.length) listedUp.set(m.ts, chosen.length);
  filled += chosen.length;
  const day = fmt(m.ts).split(',')[0];
  const d = byDay.get(day) || [0, 0];
  d[0] += missing; d[1] += chosen.length;
  byDay.set(day, d);
  prev = new Set(chosen);
  prevTs = m.ts;
}

// ---- 4. sessions ----
// Filled minutes join onto the player's sessions the way the live check joins them (a gap of up to
// 3.5 minutes is still one session, counted as played). A gap is only bridged if the count at every
// check inside it has room for them too (or there was no check then); otherwise the session stays split,
// so no minute ends up with more players named than the server reported.
const extra = new Map(listedUp); // minute -> players this run adds there
const steps = (from, to) => { const out = []; for (let t = from + 60; t < to; t += 60) out.push(t); return out; };
const plans = [];
const gapMinutes = new Set();
for (const [uuid, pts] of add) {
  const items = [
    ...(sessionsOf.get(uuid) || []).map((s) => ({ a: s.start_ts, b: s.end_ts, rows: [s], fresh: false })),
    ...pts.map((p) => ({ a: p, b: p, rows: [], fresh: true })),
  ].sort((x, y) => x.a - y.a || x.b - y.b);
  plans.push({ uuid, pts, items });
  for (let i = 1; i < items.length; i++) {
    const end = Math.max(...items.slice(0, i).map((x) => x.b));
    const d = items[i].a - end;
    if (d > 60 && d <= SESSION_GAP && (items[i].fresh || items[i - 1].fresh)) for (const t of steps(end, items[i].a)) gapMinutes.add(t);
  }
}
const snap = new Map(gapMinutes.size ? query(`SELECT ts, up, online FROM snapshots WHERE ts IN (${[...gapMinutes].join(',')})`).map((r) => [r.ts, r]) : []);
const namedAt = (ts) => sessions.filter((x) => x.start_ts <= ts && ts <= x.end_ts).length + (extra.get(ts) || 0);
let bridged = 0, splits = 0;
const sql = [], undo = [];
const finalRows = new Map(sessions.map((x) => [x.id, { ...x }])); // what the sessions will be, to check
const insertedRows = [];
const changedSpans = [];
let updated = 0, merged = 0, inserted = 0, newPlayers = 0;
for (const { uuid, pts, items } of plans) {
  const groups = [];
  for (const it of items) {
    const g = groups[groups.length - 1];
    let join = false;
    if (g) {
      const d = it.a - g.b;
      if (d <= 60) join = true;
      else if (d <= SESSION_GAP) {
        if (!g.fresh && !it.fresh) join = true; // two old sessions: as they were
        else {
          const inside = steps(g.b, it.a);
          join = inside.every((t) => { const m = snap.get(t); return !m || (m.up && namedAt(t) < m.online); });
          if (join) {
            bridged++;
            for (const t of inside) if (snap.has(t)) extra.set(t, (extra.get(t) || 0) + 1);
          } else splits++;
        }
      }
    }
    if (join) {
      g.b = Math.max(g.b, it.b);
      g.rows.push(...it.rows);
      g.fresh ||= it.fresh;
    } else groups.push({ ...it, rows: [...it.rows] });
  }
  for (const g of groups) {
    if (!g.fresh) continue;
    changedSpans.push([g.a, g.b]);
    if (g.rows.length) {
      const [keep, ...rest] = [...g.rows].sort((x, y) => x.id - y.id);
      // MIN/MAX against the stored values, so a session the live check extends meanwhile keeps that
      sql.push(`UPDATE sessions SET start_ts = MIN(start_ts, ${g.a}), end_ts = MAX(end_ts, ${g.b}) WHERE id = ${keep.id};`);
      undo.push(`UPDATE sessions SET start_ts = ${keep.start_ts}, end_ts = CASE WHEN end_ts = ${g.b} THEN ${keep.end_ts} ELSE end_ts END WHERE id = ${keep.id};`);
      finalRows.set(keep.id, { ...keep, start_ts: Math.min(keep.start_ts, g.a), end_ts: Math.max(keep.end_ts, g.b) });
      updated++;
      for (const r of rest) {
        sql.push(`DELETE FROM sessions WHERE id = ${r.id};`);
        undo.push(`INSERT INTO sessions (id, uuid, start_ts, end_ts) VALUES (${r.id}, ${q(r.uuid)}, ${r.start_ts}, ${r.end_ts});`);
        finalRows.delete(r.id);
        merged++;
      }
    } else {
      sql.push(`INSERT INTO sessions (uuid, start_ts, end_ts) VALUES (${q(uuid)}, ${g.a}, ${g.b});`);
      undo.push(`DELETE FROM sessions WHERE uuid = ${q(uuid)} AND start_ts = ${g.a} AND end_ts = ${g.b};`);
      insertedRows.push({ uuid, start_ts: g.a, end_ts: g.b });
      inserted++;
    }
  }
  if (!known.has(uuid)) {
    sql.push(`INSERT OR IGNORE INTO players (uuid, name, first_seen) VALUES (${q(uuid)}, ${q(nameOf.get(uuid) || 'unknown')}, ${pts[0]});`);
    undo.push(`DELETE FROM players WHERE uuid = ${q(uuid)} AND NOT EXISTS (SELECT 1 FROM sessions WHERE uuid = ${q(uuid)});`);
    newPlayers++;
  }
}
for (const [ts, n] of extra) {
  sql.push(`UPDATE snapshots SET listed = MIN(online, listed + ${n}) WHERE ts = ${ts};`);
  undo.push(`UPDATE snapshots SET listed = MAX(0, listed - ${n}) WHERE ts = ${ts};`);
}

// ---- check: at every check the changed sessions touch, never more players named than were counted ----
let overBefore = 0, overAfter = 0, checked = 0;
if (changedSpans.length) {
  const cond = changedSpans.map(([a, b]) => `(ts >= ${a} AND ts <= ${b})`).join(' OR ');
  const final = [...finalRows.values(), ...insertedRows];
  for (const m of query(`SELECT ts, up, online FROM snapshots WHERE ${cond}`)) {
    checked++;
    const before = sessions.filter((x) => x.start_ts <= m.ts && m.ts <= x.end_ts).length;
    const after = final.filter((x) => x.start_ts <= m.ts && m.ts <= x.end_ts).length;
    if (before > m.online) overBefore++;
    if (after > m.online) overAfter++;
  }
}

// ---- report ----
console.log(`\nChat log: ${note.joins} joins, ${note.leaves} leaves, ${note.restarts} server starts/stops, ${stayList.length} stays.`);
console.log(`  ${note.repeatJoin} repeat joins (missed leave), ${note.leaveWithoutJoin} leaves with no join, ${note.unknownName} events with no usable name,`);
console.log(`  ${note.endedByRestart} stays ended by a server start/stop, ${note.stillOn} still open now.`);
console.log(`\nChecks that counted more players than they named: ${minutes.length}, short ${short} player-minutes in all.`);
console.log(`  Filled in from the chat log: ${filled} player-minutes (${short ? Math.round((filled / short) * 100) : 0}%).`);
console.log(`  Left as they are (the chat log has nobody else on then): ${unexplained}.`);
console.log(`  Times there were more candidates than missing players (the count kept it to the count): ${extraCandidates}.`);
console.log('\nBy day (short / filled):');
for (const [d, [s, f]] of byDay) console.log(`  ${d.padEnd(8)} ${String(s).padStart(4)} / ${String(f).padStart(4)}`);
console.log('\nBy player (minutes added):');
for (const [u, pts] of [...add].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${(nameOf.get(u) || u).padEnd(18)} ${String(pts.length).padStart(4)}  ${fmt(pts[0])} – ${fmt(pts[pts.length - 1])}${known.has(u) ? '' : '  (new player record)'}`);
}
console.log(`\nChanges: ${updated} sessions extended, ${merged} merged into them, ${inserted} new sessions, ${newPlayers} new players, ${extra.size} checks' listed counts.`);
console.log(`  Gaps of up to 3.5 min bridged: ${bridged}; left split because the count had no room: ${splits}.`);
console.log(`Check: of ${checked} checks the changed sessions touch, ${overAfter} would name more players than were counted (${overBefore} already did).`);
if (overAfter > overBefore) {
  console.log('Stopping: that would make the history disagree with the recorded counts.');
  process.exit(1);
}

if (!sql.length) {
  console.log('Nothing to change.');
} else if (!apply) {
  console.log('\nDry run: nothing was changed. Run again with --apply to make these changes.');
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const undoFile = `presence-undo-${stamp}-backup.sql`;
  const doFile = `.wrangler/backfill-presence-${stamp}.sql`;
  writeFileSync(undoFile, `-- Undoes backfill-presence (${stamp}): npx wrangler d1 execute mcstats ${where} --file ${undoFile}\n${undo.reverse().join('\n')}\n`);
  writeFileSync(doFile, `${sql.join('\n')}\n`);
  console.log(`\nSaved the undo file: ${undoFile}`);
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'mcstats', where, '--yes', '--file', doFile], { stdio: 'inherit' });
  console.log('Done.');
}
