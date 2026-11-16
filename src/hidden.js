// Hidden players (the hidden_players table): left out of the Activity and Combat pages as if they
// had never been on. poll.js stops recording them; this takes what was already recorded for them
// back out of the numbers when they're read. The chat log is not affected.

// SQL condition: the player named by `col` isn't hidden. (hp.name comes first so its NOCASE applies.)
export const notHidden = (col) => `NOT EXISTS (SELECT 1 FROM hidden_players hp WHERE hp.name = ${col})`;

// Hidden players' sessions touching [from, to], as [start_ts, end_ts] pairs.
export async function hiddenSessions(db, from, to) {
  return db.prepare(
    `SELECT s.start_ts, s.end_ts FROM hidden_players hp
     CROSS JOIN players p ON hp.name = p.name
     CROSS JOIN sessions s ON s.uuid = p.uuid
     WHERE s.end_ts >= ?1 AND s.start_ts <= ?2`
  ).bind(from, to).raw();
}

const covering = (sessions, ts) => sessions.reduce((n, [a, b]) => n + (a <= ts && ts <= b ? 1 : 0), 0);

// A check's player count without the hidden players who were on at that minute.
export const withoutHidden = (sessions, ts, online) => (sessions.length ? Math.max(0, online - covering(sessions, ts)) : online);

// Hourly rows [hour_ts, samples, up_samples, online_sum, peak] with hidden players taken out: the
// hours they were on in are worked out again from the minute-by-minute checks.
export async function hourlyWithoutHidden(db, rows) {
  if (!rows.length) return rows;
  const first = rows[0][0], last = rows[rows.length - 1][0] + 3600;
  const sessions = await hiddenSessions(db, first, last);
  if (!sessions.length) return rows;
  // the stretches of whole hours they were on in, merged
  const spans = [];
  for (const [a, b] of sessions.map(([a, b]) => [Math.max(first, a - (a % 3600)), Math.min(last, b - (b % 3600) + 3600)]).sort((x, y) => x[0] - y[0])) {
    if (spans.length && a <= spans[spans.length - 1][1]) spans[spans.length - 1][1] = Math.max(spans[spans.length - 1][1], b);
    else spans.push([a, b]);
  }
  // a query takes about 40 of them at a time
  const stmts = [];
  for (let i = 0; i < spans.length; i += 40) {
    const use = spans.slice(i, i + 40);
    stmts.push(db.prepare(
      `SELECT ts, online FROM snapshots WHERE ${use.map(() => '(ts >= ? AND ts < ?)').join(' OR ')}`
    ).bind(...use.flat()));
  }
  const snaps = (await db.batch(stmts)).flatMap((r) => r.results.map((x) => [x.ts, x.online]));
  const fixed = new Map(); // hour -> [online_sum, peak]
  for (const [ts, online] of snaps) {
    const hour = ts - (ts % 3600);
    const n = withoutHidden(sessions, ts, online);
    const f = fixed.get(hour) || [0, 0];
    f[0] += n;
    f[1] = Math.max(f[1], n);
    fixed.set(hour, f);
  }
  return rows.map((r) => {
    if (fixed.has(r[0])) return [r[0], r[1], r[2], ...fixed.get(r[0])];
    // no minute-by-minute checks kept for this hour: take their minutes off, and one off the peak
    // for each of them who was on all hour
    let minutes = 0, allHour = 0;
    for (const [a, b] of sessions) {
      const over = Math.min(b + 60, r[0] + 3600) - Math.max(a, r[0]);
      if (over > 0) minutes += over / 60;
      if (over >= 3600) allHour++;
    }
    return minutes ? [r[0], r[1], r[2], Math.max(0, Math.round(r[3] - minutes)), Math.max(0, r[4] - allHour)] : r;
  });
}
