import { isAuthorized } from './auth.js';
import { POLL_SECONDS } from './poll.js';
import { chatPlayers, ingestChat, playerChat, readChat, searchChat } from './chat.js';
import { clampRange, seasonFor } from './seasons.js';
import { json, UUID_RE } from './util.js';

const DAY = 86400;

function range(url, defaultDays, maxDays) {
  const now = Math.floor(Date.now() / 1000);
  let to = Number(url.searchParams.get('to')) || now;
  let from = Number(url.searchParams.get('from')) || to - defaultDays * DAY;
  if (maxDays && to - from > maxDays * DAY) from = to - maxDays * DAY;
  return [Math.floor(from), Math.floor(to)];
}

// Each season's teams and players' real names, from the roster table (filled by npm run roster:remote,
// so the names stay out of this public repository).
async function roster(db, season) {
  if (!season.n) return [];
  const { results } = await db.prepare('SELECT ign, name, team FROM roster WHERE season = ? ORDER BY team, ign COLLATE NOCASE')
    .bind(season.n).all();
  return results;
}

export async function handleApi(request, env, url) {
  // The server mod posts chat here; it authenticates with its own token, not a login.
  if (url.pathname === '/api/ingest/chat') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    return ingestChat(request, env);
  }

  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  if (!(await isAuthorized(request, env, url))) return json({ error: 'unauthorized' }, 401);

  // Everything below is limited to one season's time span when ?season=N is given.
  const season = seasonFor(env, url);
  if (!season) return json({ error: 'bad season' }, 400);
  const { lo, hi } = season;

  const db = env.DB;
  const path = url.pathname;

  if (path === '/api/status') {
    const last = await db.prepare(
      'SELECT ts, up, online, max, listed FROM snapshots WHERE ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 1'
    ).bind(lo, hi).first();
    let online = [];
    if (last) {
      const { results } = await db.prepare(
        `SELECT p.uuid, p.name, MAX(s.start_ts, ?2) AS start_ts FROM sessions s JOIN players p ON p.uuid = s.uuid
         WHERE s.end_ts = ?1 ORDER BY s.start_ts`
      ).bind(last.ts, lo).all();
      online = results;
    }
    // From the start of tracking, "seen this season" is everyone first seen before it ended (cheap);
    // later seasons count who has a session in them.
    const totals = lo === 0
      ? await db.prepare('SELECT COUNT(*) AS players FROM players WHERE first_seen < ?').bind(hi).first()
      : await db.prepare('SELECT COUNT(DISTINCT uuid) AS players FROM sessions WHERE end_ts >= ? AND start_ts < ?').bind(lo, hi).first();
    const first = await db.prepare('SELECT MIN(ts) AS ts FROM snapshots WHERE ts >= ? AND ts < ?').bind(lo, hi).first();
    const peak = await db.prepare('SELECT MAX(peak) AS n FROM hourly WHERE hour_ts > ? AND hour_ts < ?').bind(lo - 3600, hi).first();
    // The mod logs "Server stopped" when the server shuts down (it sleeps while nobody's on).
    const serverEvent = await db.prepare(
      "SELECT ts_ms AS ts, text FROM chat WHERE kind = 'server' AND ts_ms >= ? AND ts_ms < ? ORDER BY ts_ms DESC LIMIT 1"
    ).bind(lo * 1000, hi * 1000).first();
    return json({
      tz: env.TZ_NAME || 'America/Los_Angeles',
      poll_seconds: POLL_SECONDS,
      now: Math.floor(Date.now() / 1000),
      last: last ?? null,
      online,
      players_total: totals?.players ?? 0,
      data_start: first?.ts ?? null,
      peak_ever: peak?.n ?? 0,
      server_event: serverEvent ?? null,
      season: season.info,
    });
  }

  if (path === '/api/roster') return json({ players: await roster(env.DB, season) });

  if (path === '/api/leaderboard') {
    const [from, to] = clampRange(season, ...range(url, 36500));
    if (from >= to) return json({ from, to, players: [] });
    const { results } = await db.prepare(
      `SELECT p.uuid, p.name, p.first_seen,
              SUM(MIN(s.end_ts + ?3, ?2) - MAX(s.start_ts, ?1)) AS secs,
              COUNT(*) AS sessions,
              MIN(MAX(s.end_ts), ?2 - ?3) AS last_seen
       FROM sessions s JOIN players p ON p.uuid = s.uuid
       WHERE s.end_ts + ?3 > ?1 AND s.start_ts < ?2
       GROUP BY s.uuid ORDER BY secs DESC`
    ).bind(from, to, POLL_SECONDS).all();
    return json({ from, to, players: results });
  }

  if (path === '/api/snapshots') {
    // Minute-level data is only offered for short ranges to keep database reads low.
    const [from, to] = clampRange(season, ...range(url, 1, 8));
    const rows = await db.prepare('SELECT ts, up, online FROM snapshots WHERE ts >= ? AND ts < ? AND ts <= ? ORDER BY ts')
      .bind(from, hi, to).raw();
    return json({ from, to, cols: ['ts', 'up', 'online'], rows });
  }

  if (path === '/api/hourly') {
    const [reqFrom, reqTo] = range(url, 371, 800);
    // An hour that a season starts partway through still belongs to it.
    const from = Math.max(reqFrom, Math.floor(lo / 3600) * 3600);
    const to = Math.min(reqTo, hi - 1);
    const rows = await db.prepare(
      'SELECT hour_ts, samples, up_samples, online_sum, peak FROM hourly WHERE hour_ts >= ? AND hour_ts <= ? ORDER BY hour_ts'
    ).bind(from, to).raw();
    return json({ from, to, cols: ['hour_ts', 'samples', 'up_samples', 'online_sum', 'peak'], rows });
  }

  if (path === '/api/sessions') {
    // Everyone's sessions overlapping a window, for "who was online" lookups.
    const [from, to] = clampRange(season, ...range(url, 1, 120));
    const rows = await db.prepare(
      `SELECT s.uuid, p.name, MAX(s.start_ts, ?4), MIN(s.end_ts, ?5 - ?3) FROM sessions s JOIN players p ON p.uuid = s.uuid
       WHERE s.end_ts + ?3 > ?1 AND s.start_ts < ?2 ORDER BY s.start_ts`
    ).bind(from, to, POLL_SECONDS, lo, hi).raw();
    return json({ from, to, poll_seconds: POLL_SECONDS, cols: ['uuid', 'name', 'start_ts', 'end_ts'], rows });
  }

  if (path === '/api/chat') return readChat(env, url, season);
  if (path === '/api/chat/search') return searchChat(env, url, season);
  if (path === '/api/chat/players') return chatPlayers(env, season);
  if (path === '/api/chat/player') return playerChat(env, url, season);

  const m = path.match(/^\/api\/player\/([^/]+)$/);
  if (m) {
    const uuid = decodeURIComponent(m[1]);
    if (!UUID_RE.test(uuid)) return json({ error: 'bad uuid' }, 400);
    const player = await db.prepare('SELECT uuid, name, first_seen FROM players WHERE uuid = ?').bind(uuid).first();
    if (!player) return json({ error: 'not found' }, 404);
    const sessions = await db.prepare(
      `SELECT MAX(start_ts, ?2), MIN(end_ts, ?3 - ?4) FROM sessions
       WHERE uuid = ?1 AND end_ts + ?4 > ?2 AND start_ts < ?3 ORDER BY start_ts`
    ).bind(uuid, lo, hi, POLL_SECONDS).raw();
    // first seen this season (null if they haven't played in it)
    player.first_seen = season.n ? (sessions[0]?.[0] ?? null) : player.first_seen;
    return json({ player, poll_seconds: POLL_SECONDS, sessions });
  }

  return json({ error: 'not found' }, 404);
}
