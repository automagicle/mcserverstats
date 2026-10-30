import { json, UUID_RE } from './util.js';

const KINDS = new Set(['chat', 'emote', 'say', 'join', 'leave', 'death', 'advancement', 'server', 'system']);
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_BODY = 512 * 1024;
const MAX_EVENTS = 200;
const MAX_TEXT = 1000;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_AGE_MS = 60 * 86400_000; // older messages (e.g. saved during a very long outage) are skipped

// Constant-time comparison; hashing first makes both sides the same length.
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// Control characters and leftover § color codes out; newlines stay.
const clean = (s, max) => s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]|§[0-9a-fk-or]/gi, '').trim().slice(0, max);

// The styled name: up to 8 pieces of text, each with an optional color. Anything else is dropped.
function cleanDisplay(d) {
  if (!Array.isArray(d) || !d.length || d.length > 8) return null;
  const out = [];
  for (const p of d) {
    if (!p || typeof p.t !== 'string') return null;
    const t = p.t.replace(/[\u0000-\u001f\u007f]|§[0-9a-fk-or]/gi, '').slice(0, 64);
    if (!t) continue;
    out.push(typeof p.c === 'string' && COLOR_RE.test(p.c) ? { t, c: p.c.toLowerCase() } : { t });
  }
  return out.length ? JSON.stringify(out) : null;
}

// The whole message as the game shows it: up to 32 pieces of text, each with an optional color
// and the name of the player it names (p), so the page can color and link every name in it.
const PLAYER_RE = /^[A-Za-z0-9_.-]{1,32}$/;
function cleanRich(d) {
  if (!Array.isArray(d) || !d.length || d.length > 32) return null;
  const out = [];
  for (const p of d) {
    if (!p || typeof p.t !== 'string') return null;
    const t = p.t.replace(/[\u0000-\u0009\u000b-\u001f\u007f]|§[0-9a-fk-or]/gi, '').slice(0, 300);
    if (!t) continue;
    const piece = { t };
    if (typeof p.c === 'string' && COLOR_RE.test(p.c)) piece.c = p.c.toLowerCase();
    if (typeof p.p === 'string' && PLAYER_RE.test(p.p)) piece.p = p.p;
    out.push(piece);
  }
  return out.length ? JSON.stringify(out) : null;
}

// POST /api/ingest/chat from the server mod: { events: [{ id, ts, kind, uuid?, name?, display?, rich?, text }] }.
// Cloudflare Access only lets it through with the service token; the bearer token is checked here too.
export async function ingestChat(request, env) {
  const secret = env.CHAT_INGEST_TOKEN || '';
  if (secret.length < 32) return json({ error: 'chat ingest is not set up (no CHAT_INGEST_TOKEN secret)' }, 503);
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ') || !(await sameSecret(auth.slice(7), secret))) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (Number(request.headers.get('Content-Length')) > MAX_BODY) return json({ error: 'too large' }, 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too large' }, 413);
  let events;
  try {
    events = JSON.parse(raw).events;
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  if (!Array.isArray(events) || events.length > MAX_EVENTS) {
    return json({ error: `expected { events: [...] } with at most ${MAX_EVENTS} events` }, 400);
  }

  const now = Date.now();
  const rows = [];
  for (const e of events) {
    const valid = e && typeof e === 'object'
      && typeof e.id === 'string' && ID_RE.test(e.id)
      && Number.isSafeInteger(e.ts) && e.ts > now - MAX_AGE_MS && e.ts < now + 5 * 60_000
      && KINDS.has(e.kind)
      && typeof e.text === 'string'
      && (e.uuid == null || (typeof e.uuid === 'string' && UUID_RE.test(e.uuid)))
      && (e.name == null || typeof e.name === 'string');
    if (!valid) continue;
    const text = clean(e.text, MAX_TEXT);
    if (!text) continue;
    rows.push([e.id, e.ts, e.kind, e.uuid ? e.uuid.toLowerCase() : null, e.name ? clean(e.name, 40) || null : null, text, cleanDisplay(e.display), cleanRich(e.rich)]);
  }

  if (rows.length) {
    // Server messages name a player without a UUID sometimes; fill it in from the players we know.
    const stmt = env.DB.prepare(
      `INSERT OR IGNORE INTO chat (event_id, ts_ms, kind, uuid, name, text, display, rich)
       VALUES (?1, ?2, ?3, COALESCE(?4, (SELECT uuid FROM players WHERE name = ?5 COLLATE NOCASE ORDER BY first_seen DESC LIMIT 1)), ?5, ?6, ?7, ?8)`
    );
    await env.DB.batch(rows.map((r) => stmt.bind(...r)));
  }
  return json({ accepted: rows.length, skipped: events.length - rows.length });
}

const COLS = 'id, ts_ms AS ts, kind, uuid, name, text, display, rich';
const withDisplay = (rows) => rows.map((r) => ({
  ...r, display: r.display ? JSON.parse(r.display) : null, rich: r.rich ? JSON.parse(r.rich) : null,
}));
const TALK = "('chat', 'say', 'emote')"; // what counts as a message someone sent
const BIG = Number.MAX_SAFE_INTEGER;

// GET /api/chat — messages in time order, `limit` at a time:
//   (nothing)         the latest
//   before=TS:ID      older than a message      after=TS:ID   newer than a message
//   at=TS             up to and just after a moment (unix ms)
//   since_id=ID       stored after that id (live updates), whatever their time; add unread_since=ID for a count
export async function readChat(env, url) {
  const q = url.searchParams;
  const db = env.DB;
  const limit = Math.min(200, Math.max(1, Math.floor(Number(q.get('limit'))) || 100));
  const cursor = (v) => {
    const m = /^(\d+):(\d+)$/.exec(v || '');
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const older = (ts, id, n) => db.prepare(
    `SELECT ${COLS} FROM chat WHERE ts_ms < ?1 OR (ts_ms = ?1 AND id < ?2) ORDER BY ts_ms DESC, id DESC LIMIT ?3`
  ).bind(ts, id, n + 1);
  const newer = (ts, id, n) => db.prepare(
    `SELECT ${COLS} FROM chat WHERE ts_ms > ?1 OR (ts_ms = ?1 AND id > ?2) ORDER BY ts_ms, id LIMIT ?3`
  ).bind(ts, id, n + 1);
  const maxId = db.prepare('SELECT MAX(id) AS id FROM chat');

  if (q.has('since_id')) {
    const since = Math.max(0, Math.floor(Number(q.get('since_id'))) || 0);
    const [rows, max] = await db.batch([
      db.prepare(`SELECT ${COLS} FROM chat WHERE id > ? ORDER BY id LIMIT ?`).bind(since, limit + 1),
      maxId,
    ]);
    const messages = withDisplay(rows.results.slice(0, limit)).sort((a, b) => a.ts - b.ts || a.id - b.id);
    const body = { messages, more_after: rows.results.length > limit, max_id: max.results[0].id ?? 0 };
    // unread_since=ID: how many messages worth reading (chat, deaths, advancements; not joins or leaves) came after it, up to 1000
    if (q.has('unread_since')) {
      const seen = Math.max(0, Math.floor(Number(q.get('unread_since'))) || 0);
      body.unread = (await db.prepare(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM chat WHERE id > ? AND kind IN ('chat', 'say', 'emote', 'death', 'advancement') LIMIT 1000)`
      ).bind(seen).first()).n;
    }
    return json(body);
  }

  let back = null, fwd = null;
  if (q.has('before')) {
    const c = cursor(q.get('before'));
    if (!c) return json({ error: 'bad cursor' }, 400);
    back = older(c[0], c[1], limit);
  } else if (q.has('after')) {
    const c = cursor(q.get('after'));
    if (!c) return json({ error: 'bad cursor' }, 400);
    fwd = newer(c[0], c[1], limit);
  } else if (q.has('at')) {
    const at = Math.floor(Number(q.get('at')));
    if (!Number.isSafeInteger(at)) return json({ error: 'bad time' }, 400);
    back = older(at, BIG, limit);
    fwd = newer(at, BIG, Math.ceil(limit / 2));
  } else {
    back = older(BIG, BIG, limit);
  }

  const res = await db.batch([back, fwd, maxId].filter(Boolean));
  const max = res.pop().results[0].id ?? 0;
  const b = back ? res.shift().results : [];
  const f = fwd ? res.shift().results : [];
  const bn = back && !q.has('after') ? limit : 0;
  const fn = q.has('after') ? limit : Math.ceil(limit / 2);
  return json({
    messages: withDisplay([...b.slice(0, bn).reverse(), ...f.slice(0, fn)]),
    more_before: b.length > bn,
    // "after" isn't asked for when loading the latest, so nothing newer is assumed.
    more_after: fwd ? f.length > fn : false,
    max_id: max,
  });
}

const SEARCH_KINDS = {
  chat: "kind IN ('chat', 'say', 'emote')",
  death: "kind = 'death'",
  advancement: "kind = 'advancement'",
  joins: "kind IN ('join', 'leave')",
};
const likeArg = (s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// GET /api/chat/search — newest first, `limit` at a time:
//   q=TEXT      words to find; in=all (text or name, the default) | text | name
//   from=UUID   only messages from (or about) this player
//   kind=chat | death | advancement | joins
//   before=TS:ID  the next page
export async function searchChat(env, url) {
  const q = url.searchParams;
  const limit = Math.min(50, Math.max(1, Math.floor(Number(q.get('limit'))) || 30));
  const text = (q.get('q') || '').trim().slice(0, 100);
  const where = [], args = [];
  if (text) {
    const field = q.get('in');
    if (field === 'text') where.push("text LIKE ? ESCAPE '\\'");
    else if (field === 'name') where.push("name LIKE ? ESCAPE '\\'");
    else { where.push("(text LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')"); args.push(likeArg(text)); }
    args.push(likeArg(text));
  }
  const from = q.get('from');
  if (from) {
    if (!UUID_RE.test(from)) return json({ error: 'bad uuid' }, 400);
    where.push('uuid = ?');
    args.push(from.toLowerCase());
  }
  const kind = q.get('kind');
  if (kind && SEARCH_KINDS[kind]) where.push(SEARCH_KINDS[kind]);
  if (!where.length) return json({ error: 'nothing to search for' }, 400);
  const before = /^(\d+):(\d+)$/.exec(q.get('before') || '');
  if (before) {
    where.push('(ts_ms < ? OR (ts_ms = ? AND id < ?))');
    args.push(Number(before[1]), Number(before[1]), Number(before[2]));
  }
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} FROM chat WHERE ${where.join(' AND ')} ORDER BY ts_ms DESC, id DESC LIMIT ?`
  ).bind(...args, limit + 1).all();
  return json({ results: withDisplay(results.slice(0, limit)), more: results.length > limit });
}

// GET /api/chat/players — everyone, with how many messages they've sent, for the search filter.
export async function chatPlayers(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.uuid, p.name, COUNT(c.id) AS n FROM players p
     LEFT JOIN chat c ON c.uuid = p.uuid AND c.kind IN ${TALK}
     GROUP BY p.uuid ORDER BY n DESC, p.name COLLATE NOCASE`
  ).all();
  return json({ players: results });
}

// GET /api/chat/player?uuid=… (or name=…) — one player's chat at a glance:
//   their name as chat last showed it, messages sent (all time and since today=UNIX_SECONDS),
//   and with events=1 their messages, deaths and advancements: [id, ts, kind, text] in time order.
export async function playerChat(env, url) {
  const q = url.searchParams;
  const db = env.DB;
  let uuid = q.get('uuid');
  let name = null;
  if (uuid) {
    if (!UUID_RE.test(uuid)) return json({ error: 'bad uuid' }, 400);
    uuid = uuid.toLowerCase();
  } else {
    const row = await db.prepare('SELECT uuid FROM players WHERE name = ? COLLATE NOCASE ORDER BY first_seen DESC LIMIT 1')
      .bind(q.get('name') || '').first();
    if (!row) return json({ error: 'not found' }, 404);
    uuid = row.uuid;
  }
  const today = Math.floor(Number(q.get('today')) || 0) * 1000;
  const stmts = [
    db.prepare('SELECT name FROM players WHERE uuid = ?').bind(uuid),
    db.prepare('SELECT display FROM chat WHERE uuid = ? AND display IS NOT NULL ORDER BY ts_ms DESC LIMIT 1').bind(uuid),
    db.prepare(`SELECT COUNT(*) AS total, SUM(ts_ms >= ?) AS today FROM chat WHERE uuid = ? AND kind IN ${TALK}`).bind(today, uuid),
    db.prepare('SELECT MIN(ts_ms) AS ts FROM chat'),
  ];
  if (q.get('events') === '1') {
    stmts.push(db.prepare(
      `SELECT id, ts_ms, kind, substr(text, 1, 200) FROM chat
       WHERE uuid = ? AND kind IN ('chat', 'say', 'emote', 'death', 'advancement') ORDER BY ts_ms DESC LIMIT 20000`
    ).bind(uuid));
  }
  const [p, d, counts, first, events] = await db.batch(stmts);
  name = p.results[0]?.name ?? null;
  if (!name) return json({ error: 'not found' }, 404);
  const body = {
    uuid,
    name,
    display: d.results[0] ? JSON.parse(d.results[0].display) : null,
    total: counts.results[0].total,
    today: counts.results[0].today ?? 0,
    data_start: first.results[0].ts,
  };
  if (events) body.events = events.results.map((r) => Object.values(r)).reverse();
  return json(body);
}
