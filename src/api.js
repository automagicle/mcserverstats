import { isAuthorized } from './auth.js';
import { POLL_SECONDS } from './poll.js';
import { ingestChat, readChat } from './chat.js';
import { json, UUID_RE } from './util.js';

const DAY = 86400;

function range(url, defaultDays, maxDays) {
  const now = Math.floor(Date.now() / 1000);
  let to = Number(url.searchParams.get('to')) || now;
  let from = Number(url.searchParams.get('from')) || to - defaultDays * DAY;
  if (maxDays && to - from > maxDays * DAY) from = to - maxDays * DAY;
  return [Math.floor(from), Math.floor(to)];
}

export async function handleApi(request, env, url) {
  // The server mod posts chat here; it authenticates with its own token, not a login.
  if (url.pathname === '/api/ingest/chat') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    return ingestChat(request, env);
  }

  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  if (!(await isAuthorized(request, env, url))) return json({ error: 'unauthorized' }, 401);

  const db = env.DB;
  const path = url.pathname;

  if (path === '/api/status') {
    const last = await db.prepare('SELECT ts, up, online, max, listed FROM snapshots ORDER BY ts DESC LIMIT 1').first();
    let online = [];
    if (last) {
      const { results } = await db.prepare(
        `SELECT p.uuid, p.name, s.start_ts FROM sessions s JOIN players p ON p.uuid = s.uuid
         WHERE s.end_ts = ? ORDER BY s.start_ts`
      ).bind(last.ts).all();
      online = results;
    }
    const totals = await db.prepare('SELECT COUNT(*) AS players FROM players').first();
    const first = await db.prepare('SELECT MIN(ts) AS ts FROM snapshots').first();
    return json({
      tz: env.TZ_NAME || 'America/Los_Angeles',
      poll_seconds: POLL_SECONDS,
      now: Math.floor(Date.now() / 1000),
      last,
      online,
      players_total: totals.players,
      data_start: first?.ts ?? null,
    });
  }

  if (path === '/api/leaderboard') {
    const [from, to] = range(url, 36500);
    const { results } = await db.prepare(
      `SELECT p.uuid, p.name, p.first_seen,
              SUM(MIN(s.end_ts + ?3, ?2) - MAX(s.start_ts, ?1)) AS secs,
              COUNT(*) AS sessions,
              MAX(s.end_ts) AS last_seen
       FROM sessions s JOIN players p ON p.uuid = s.uuid
       WHERE s.end_ts + ?3 > ?1 AND s.start_ts < ?2
       GROUP BY s.uuid ORDER BY secs DESC`
    ).bind(from, to, POLL_SECONDS).all();
    return json({ from, to, players: results });
  }

  if (path === '/api/snapshots') {
    // Minute-level data is only offered for short ranges to keep database reads low.
    const [from, to] = range(url, 1, 8);
    const rows = await db.prepare('SELECT ts, up, online FROM snapshots WHERE ts >= ? AND ts <= ? ORDER BY ts')
      .bind(from, to).raw();
    return json({ from, to, cols: ['ts', 'up', 'online'], rows });
  }

  if (path === '/api/hourly') {
    const [from, to] = range(url, 371, 800);
    const rows = await db.prepare(
      'SELECT hour_ts, samples, up_samples, online_sum, peak FROM hourly WHERE hour_ts >= ? AND hour_ts <= ? ORDER BY hour_ts'
    ).bind(from, to).raw();
    return json({ from, to, cols: ['hour_ts', 'samples', 'up_samples', 'online_sum', 'peak'], rows });
  }

  if (path === '/api/sessions') {
    // Everyone's sessions overlapping a window, for "who was online" lookups.
    const [from, to] = range(url, 1, 120);
    const rows = await db.prepare(
      `SELECT s.uuid, p.name, s.start_ts, s.end_ts FROM sessions s JOIN players p ON p.uuid = s.uuid
       WHERE s.end_ts + ?3 > ?1 AND s.start_ts < ?2 ORDER BY s.start_ts`
    ).bind(from, to, POLL_SECONDS).raw();
    return json({ from, to, poll_seconds: POLL_SECONDS, cols: ['uuid', 'name', 'start_ts', 'end_ts'], rows });
  }

  if (path === '/api/chat') return readChat(env, url);

  const m = path.match(/^\/api\/player\/([^/]+)$/);
  if (m) {
    const uuid = decodeURIComponent(m[1]);
    if (!UUID_RE.test(uuid)) return json({ error: 'bad uuid' }, 400);
    const player = await db.prepare('SELECT uuid, name, first_seen FROM players WHERE uuid = ?').bind(uuid).first();
    if (!player) return json({ error: 'not found' }, 404);
    const sessions = await db.prepare('SELECT start_ts, end_ts FROM sessions WHERE uuid = ? ORDER BY start_ts')
      .bind(uuid).raw();
    return json({ player, poll_seconds: POLL_SECONDS, sessions });
  }

  return json({ error: 'not found' }, 404);
}
