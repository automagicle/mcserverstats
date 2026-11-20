import { signedIn } from './auth.js';
import { POLL_SECONDS } from './poll.js';
import { chatPlayers, ingestChat, playerChat, readChat, searchChat } from './chat.js';
import { combatData, combatLog } from './combat.js';
import { chatSeason, clampRange, seasonFor } from './seasons.js';
import { gearFor, gearStyles, ingestGear } from './gear.js';
import { advancementsFor, ingestAdvancements } from './advancements.js';
import { ingestOnline } from './online.js';
import { serveItem, serveSkin, serveTexture } from './mcassets.js';
import { connectLink, playerFor, sendWebChat, webChatMe } from './link.js';
import { ADMIN_SENDER, readWhispers } from './whisper.js';
import { canonName, canonUuid, marks, playerGroup } from './aliases.js';
import { hiddenSessions, hourlyWithoutHidden, notHidden, withoutHidden } from './hidden.js';
import { json, UUID_RE } from './util.js';
import { adminAction, adminState, isAdmin, me } from './admin.js';
import { cached } from './cache.js';
import { presence } from './presence.js';
import { teamRows } from './teams.js';
import { analytics, recordHit } from './analytics.js';

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
  const { results } = await db.prepare('SELECT ign, name, team, egg FROM roster WHERE season = ? ORDER BY team, ign COLLATE NOCASE')
    .bind(season.n).all();
  return results;
}

// The season's teams in their order (src/teams.js); [] before that table exists.
export const teams = (db, season) => (season.n ? teamRows(db, season.n) : []);

// Players' earlier teams (migrations/0017_team_history.sql): [{ ign, until, team }], oldest first.
export async function teamHistory(db, season) {
  if (!season.n) return [];
  try {
    return (await db.prepare('SELECT ign, until, team FROM team_history WHERE season = ? ORDER BY ign, until').bind(season.n).all()).results;
  } catch {
    return [];
  }
}

// Other accounts' names and the player each belongs to (src/aliases.js), so the page can give them the same team.
async function aliases(db) {
  return (await db.prepare('SELECT alias, name FROM player_aliases').all()).results;
}

export async function handleApi(request, env, url) {
  // The server mod posts chat here; it authenticates with its own token, not a login.
  if (url.pathname === '/api/ingest/chat') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    return ingestChat(request, env);
  }
  if (url.pathname === '/api/ingest/gear') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    return ingestGear(request, env);
  }
  if (url.pathname === '/api/ingest/online') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    return ingestOnline(request, env);
  }
  if (url.pathname === '/api/ingest/advancements') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    return ingestAdvancements(request, env);
  }

  // The server mod's WebSocket, which carries chat sent from the dashboard into the game.
  if (url.pathname === '/api/ingest/link') return connectLink(request, env);

  const who = await signedIn(request, env, url);
  if (!who) return json({ error: 'unauthorized' }, 401);

  // Chat from the dashboard, for players whose login email is on the roster.
  if (url.pathname === '/api/chat/send') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    return sendWebChat(request, env, url, who);
  }
  if (url.pathname === '/api/me') return me(env, who);
  // Website analytics (src/analytics.js): the page reports views, and admins read them.
  if (url.pathname === '/api/hit') return recordHit(request, env, who);
  if (url.pathname === '/api/admin/analytics') return analytics(env, url, who);
  // Who's online, pushed over a WebSocket as players join and leave (src/presence.js).
  // The page says who's signed in, so whispers reach them and the server knows they're on the website.
  if (url.pathname === '/api/live') {
    const player = await playerFor(env, who.email).catch(() => null);
    const watch = new Request('https://presence/watch', request);
    watch.headers.set('X-Viewer', JSON.stringify(player?.admin ? { admin: true } : player?.ign ? { ign: player.ign } : {}));
    return presence(env).fetch(watch);
  }
  // The admin page: only the emails in the ADMIN_EMAIL secret.
  if (url.pathname === '/api/admin') {
    if (!isAdmin(env, who)) return json({ error: 'forbidden' }, 403);
    const season = seasonFor(env, url);
    if (!season) return json({ error: 'bad season' }, 400);
    if (request.method === 'POST') return adminAction(request, env, url, season);
    if (request.method === 'GET') return adminState(env, season);
    return json({ error: 'method not allowed' }, 405);
  }
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  if (url.pathname === '/api/chat/me') return webChatMe(env, who);
  // Your own whispers (src/whisper.js).
  if (url.pathname === '/api/chat/whispers') {
    const season = seasonFor(env, url);
    if (!season) return json({ error: 'bad season' }, 400);
    const player = await playerFor(env, who.email);
    return readWhispers(env, url, player?.admin ? ADMIN_SENDER : player?.ign ?? null, season);
  }

  // Game textures and skins, for the 3D player model.
  if (url.pathname.startsWith('/api/mc/item/')) return serveItem(env, url.pathname.slice(13));
  if (url.pathname.startsWith('/api/mc/')) return serveTexture(env, url.pathname.slice(8));
  const skin = url.pathname.match(/^\/api\/skin\/([^/]+)$/);
  if (skin) return serveSkin(env, decodeURIComponent(skin[1]), (url.searchParams.get('uuid') || '').replace(/-/g, '').toLowerCase());

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
        `SELECT ${canonUuid('p.name', 'p.uuid')} AS uuid, ${canonName('p.name')} AS name, MAX(s.start_ts, ?2) AS start_ts FROM sessions s JOIN players p ON p.uuid = s.uuid
         WHERE s.end_ts = ?1 AND ${notHidden('p.name')} ORDER BY s.start_ts`
      ).bind(last.ts, lo).all();
      online = results;
      const hidden = await hiddenSessions(db, last.ts, last.ts);
      last.listed = withoutHidden(hidden, last.ts, last.listed);
      last.online = withoutHidden(hidden, last.ts, last.online);
    }
    // "Seen this season" and the peak read every session and hour of the season, so they're kept for
    // a few minutes (src/cache.js); the current hour's peak is always read fresh. From the start of
    // tracking, "seen" is everyone first seen before it ended; later seasons count who has a session in them.
    const hourNow = Math.floor(Date.now() / 3600_000) * 3600;
    const slow = await cached(db, `status:${season.n ?? 'all'}:${hourNow}`, 300, async () => {
      const totals = lo === 0
        ? await db.prepare(`SELECT COUNT(DISTINCT lower(${canonName('p.name')})) AS players FROM players p WHERE first_seen < ? AND ${notHidden('p.name')}`).bind(hi).first()
        : await db.prepare(
          `SELECT COUNT(DISTINCT lower(${canonName('p.name')})) AS players FROM sessions s JOIN players p ON p.uuid = s.uuid
           WHERE s.end_ts >= ? AND s.start_ts < ? AND ${notHidden('p.name')}`
        ).bind(lo, hi).first();
      const done = await hourlyWithoutHidden(db, await db.prepare(
        'SELECT hour_ts, samples, up_samples, online_sum, peak FROM hourly WHERE hour_ts > ? AND hour_ts < ? ORDER BY hour_ts'
      ).bind(lo - 3600, Math.min(hi, hourNow)).raw());
      return { players: totals?.players ?? 0, peak: done.reduce((n, r) => Math.max(n, r[4]), 0) };
    });
    const totals = { players: slow.players };
    const first = await db.prepare('SELECT MIN(ts) AS ts FROM snapshots WHERE ts >= ? AND ts < ?').bind(lo, hi).first();
    const nowRows = hi > hourNow ? await hourlyWithoutHidden(db, await db.prepare(
      'SELECT hour_ts, samples, up_samples, online_sum, peak FROM hourly WHERE hour_ts >= ? AND hour_ts < ?'
    ).bind(Math.max(hourNow, lo - 3600), hi).raw()) : [];
    const peak = { n: nowRows.reduce((n, r) => Math.max(n, r[4]), slow.peak) };
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

  if (path === '/api/roster') {
    return json({
      players: await roster(env.DB, season), aliases: await aliases(env.DB), teams: await teams(env.DB, season),
      history: await teamHistory(env.DB, season),
    });
  }

  if (path === '/api/leaderboard') {
    const [from, to] = clampRange(season, ...range(url, 36500));
    if (from >= to) return json({ from, to, players: [] });
    const { results } = await db.prepare(
      `SELECT ${canonUuid('p.name', 'p.uuid')} AS uuid, ${canonName('p.name')} AS name, MIN(p.first_seen) AS first_seen,
              SUM(MIN(s.end_ts + ?3, ?2) - MAX(s.start_ts, ?1)) AS secs,
              COUNT(*) AS sessions,
              MIN(MAX(s.end_ts), ?2 - ?3) AS last_seen
       FROM sessions s JOIN players p ON p.uuid = s.uuid
       WHERE s.end_ts > ?1 - ?3 AND s.start_ts < ?2 AND ${notHidden('p.name')}
       GROUP BY lower(${canonName('p.name')}) ORDER BY secs DESC`
    ).bind(from, to, POLL_SECONDS).all();
    return json({ from, to, players: results });
  }

  if (path === '/api/snapshots') {
    // Minute-level data is only offered for short ranges to keep database reads low.
    const [from, to] = clampRange(season, ...range(url, 1, 8));
    const rows = await db.prepare('SELECT ts, up, online FROM snapshots WHERE ts >= ? AND ts < ? AND ts <= ? ORDER BY ts')
      .bind(from, hi, to).raw();
    const hidden = rows.length ? await hiddenSessions(db, rows[0][0], rows[rows.length - 1][0]) : [];
    if (hidden.length) for (const r of rows) r[2] = withoutHidden(hidden, r[0], r[2]);
    return json({ from, to, cols: ['ts', 'up', 'online'], rows });
  }

  if (path === '/api/hourly') {
    const [reqFrom, reqTo] = range(url, 371, 800);
    // An hour that a season starts partway through still belongs to it.
    const from = Math.max(reqFrom, Math.floor(lo / 3600) * 3600);
    const to = Math.min(reqTo, hi - 1);
    const rows = await hourlyWithoutHidden(db, await db.prepare(
      'SELECT hour_ts, samples, up_samples, online_sum, peak FROM hourly WHERE hour_ts >= ? AND hour_ts <= ? ORDER BY hour_ts'
    ).bind(from, to).raw());
    return json({ from, to, cols: ['hour_ts', 'samples', 'up_samples', 'online_sum', 'peak'], rows });
  }

  if (path === '/api/sessions') {
    // Everyone's sessions overlapping a window, for "who was online" lookups.
    const [from, to] = clampRange(season, ...range(url, 1, 120));
    const rows = await db.prepare(
      `SELECT ${canonUuid('p.name', 'p.uuid')}, ${canonName('p.name')}, MAX(s.start_ts, ?4), MIN(s.end_ts, ?5 - ?3) FROM sessions s JOIN players p ON p.uuid = s.uuid
       WHERE s.end_ts > ?1 - ?3 AND s.start_ts < ?2 AND ${notHidden('p.name')} ORDER BY s.start_ts`
    ).bind(from, to, POLL_SECONDS, lo, hi).raw();
    return json({ from, to, poll_seconds: POLL_SECONDS, cols: ['uuid', 'name', 'start_ts', 'end_ts'], rows });
  }

  // The chat log starts over at each chat reset (CHAT_RESETS); what came before stays in the database.
  const chat = chatSeason(env, season);
  if (path === '/api/chat') return readChat(env, url, chat);
  if (path === '/api/chat/search') return searchChat(env, url, chat);
  if (path === '/api/chat/players') return chatPlayers(env, chat);
  if (path === '/api/chat/player') return playerChat(env, url, chat);
  if (path === '/api/advancements') return advancementsFor(env, url, season);
  if (path === '/api/combat') return combatData(env, url, season);
  if (path === '/api/combat/log') return combatLog(env, url, season);

  const m = path.match(/^\/api\/player\/([^/]+)$/);
  if (m) {
    const uuid = decodeURIComponent(m[1]);
    if (!UUID_RE.test(uuid)) return json({ error: 'bad uuid' }, 400);
    // all of their accounts (src/aliases.js), shown as the main one
    const group = await playerGroup(db, { uuid: uuid.toLowerCase() });
    const hidden = group && await db.prepare('SELECT 1 FROM hidden_players WHERE name = ?').bind(group.name).first();
    if (!group || hidden) return json({ error: 'not found' }, 404);
    const player = { uuid: group.uuid, name: group.name, first_seen: group.first_seen };
    const sessions = await db.prepare(
      `SELECT MAX(start_ts, ?1), MIN(end_ts, ?2 - ?3) FROM sessions
       WHERE uuid IN (${marks(group.uuids)}) AND end_ts > ?1 - ?3 AND start_ts < ?2 ORDER BY start_ts`
    ).bind(lo, hi, POLL_SECONDS, ...group.uuids).raw();
    // first seen this season (null if they haven't played in it)
    player.first_seen = season.n ? (sessions[0]?.[0] ?? null) : player.first_seen;
    // what they last wore and carried (not limited to the season: it's their latest)
    const gear = await gearFor(db, group.names);
    // their named weapons and tools as the game styles them, from the chat log
    if (gear) gear.styles = await gearStyles(db, gear, group.names).catch(() => ({}));
    return json({ player, poll_seconds: POLL_SECONDS, sessions, gear });
  }

  return json({ error: 'not found' }, 404);
}
