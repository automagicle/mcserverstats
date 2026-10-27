export const POLL_SECONDS = 60;

// A player missing for up to this long (e.g. a failed check or two) keeps the same session.
const SESSION_GAP = 210;

const ADDRESS_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export async function poll(env, nowSeconds) {
  const address = (env.MC_SERVER || '').trim();
  if (!ADDRESS_RE.test(address)) {
    console.error('MC_SERVER secret is missing or not a host[:port]');
    return;
  }

  const ts = Math.floor(nowSeconds / POLL_SECONDS) * POLL_SECONDS;

  let data;
  try {
    const res = await fetch(`https://api.mcstatus.io/v2/status/java/${address}`, {
      headers: { 'User-Agent': 'mcserverstats (personal stats tracker)' },
    });
    if (!res.ok) throw new Error(`mcstatus.io responded ${res.status}`);
    data = await res.json();
  } catch (err) {
    // An API failure is not the server being offline, so record nothing.
    console.error('status check failed:', err.message);
    return;
  }

  const up = data.online === true;
  const seen = new Map();
  if (up) {
    for (const p of data.players?.list ?? []) {
      if (p.uuid && p.uuid !== NIL_UUID && !seen.has(p.uuid)) {
        seen.set(p.uuid, p.name_clean || p.name_raw || 'unknown');
      }
    }
  }
  const online = up ? (data.players?.online ?? seen.size) : 0;
  const max = up ? (data.players?.max ?? null) : null;

  const db = env.DB;
  const [dup, open] = await db.batch([
    db.prepare('SELECT 1 FROM snapshots WHERE ts = ?').bind(ts),
    db.prepare('SELECT id, uuid FROM sessions WHERE end_ts >= ?').bind(ts - SESSION_GAP),
  ]);
  if (dup.results.length) return; // this minute was already recorded

  const openByUuid = new Map(open.results.map((r) => [r.uuid, r.id]));
  const hourTs = Math.floor(ts / 3600) * 3600;

  const stmts = [
    db.prepare('INSERT INTO snapshots (ts, up, online, max, listed) VALUES (?, ?, ?, ?, ?)')
      .bind(ts, up ? 1 : 0, online, max, seen.size),
    db.prepare(
      `INSERT INTO hourly (hour_ts, samples, up_samples, online_sum, peak) VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(hour_ts) DO UPDATE SET
         samples = samples + 1,
         up_samples = up_samples + excluded.up_samples,
         online_sum = online_sum + excluded.online_sum,
         peak = max(peak, excluded.peak)`
    ).bind(hourTs, up ? 1 : 0, online, online),
  ];

  for (const [uuid, name] of seen) {
    const id = openByUuid.get(uuid);
    if (id !== undefined) {
      stmts.push(db.prepare('UPDATE sessions SET end_ts = ? WHERE id = ?').bind(ts, id));
    } else {
      stmts.push(
        db.prepare('INSERT INTO sessions (uuid, start_ts, end_ts) VALUES (?, ?, ?)').bind(uuid, ts, ts),
        db.prepare(
          `INSERT INTO players (uuid, name, first_seen) VALUES (?, ?, ?)
           ON CONFLICT(uuid) DO UPDATE SET name = excluded.name`
        ).bind(uuid, name, ts)
      );
    }
  }

  await db.batch(stmts);
}
