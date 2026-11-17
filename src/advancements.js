// Advancements, reported by the server mod (POST /api/ingest/advancements) for the tree on each
// player's page: the tree as the game lays it out, and each player's progress in it.
// Only the fields the dashboard uses are kept; everything is re-checked here.

import { marks, playerGroup } from './aliases.js';
import { sameSecret } from './chat.js';
import { json, UUID_RE } from './util.js';

const MAX_BODY = 1024 * 1024;
const MAX_PLAYERS = 100;
const MAX_NODES = 800;
const MAX_CRITERIA = 120;
const ID_RE = /^[a-z0-9_.:/-]{1,96}$/;
const NAME_RE = /^[A-Za-z0-9_.]{1,20}$/;
const FRAMES = new Set(['task', 'goal', 'challenge']);

const clean = (s, max) => String(s).replace(/[\u0000-\u001f\u007f]|§[0-9a-fk-or]/gi, '').trim().slice(0, max);
const isId = (v) => typeof v === 'string' && ID_RE.test(v);

// [{ id, parent?, title, desc, icon: { id, model?, glint? }, frame, x, y, hidden?, bg?, of }]
function cleanTree(list) {
  if (!Array.isArray(list) || list.length > MAX_NODES) return null;
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object' || !isId(a.id) || !isId(a.icon?.id)) continue;
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || Math.abs(a.x) > 500 || Math.abs(a.y) > 500) continue;
    const node = {
      id: a.id,
      title: clean(a.title ?? '', 80) || a.id,
      desc: clean(a.desc ?? '', 300),
      icon: { id: a.icon.id },
      frame: FRAMES.has(a.frame) ? a.frame : 'task',
      x: Math.round(a.x * 100) / 100,
      y: Math.round(a.y * 100) / 100,
    };
    if (isId(a.parent)) node.parent = a.parent;
    if (isId(a.icon.model)) node.icon.model = a.icon.model;
    if (a.icon.glint === true) node.icon.glint = true;
    if (a.hidden === true) node.hidden = true;
    if (isId(a.bg)) node.bg = a.bg;
    if (Number.isInteger(a.of) && a.of > 0 && a.of < 1000) node.of = a.of;
    out.push(node);
  }
  return out;
}

// { done: { id: unix seconds }, part: { id: { n, of, got: [criteria] } } }
function cleanProgress(p) {
  const done = {}, part = {};
  let n = 0;
  for (const [id, at] of Object.entries(p.done && typeof p.done === 'object' ? p.done : {})) {
    if (++n > MAX_NODES) break;
    if (isId(id) && Number.isSafeInteger(at) && at >= 0 && at < 1e11) done[id] = at;
  }
  n = 0;
  for (const [id, v] of Object.entries(p.part && typeof p.part === 'object' ? p.part : {})) {
    if (++n > MAX_NODES) break;
    if (!isId(id) || !v || typeof v !== 'object') continue;
    const small = (x) => Number.isInteger(x) && x >= 0 && x < 1000;
    if (!small(v.n) || !small(v.of)) continue;
    const got = (Array.isArray(v.got) ? v.got : []).slice(0, MAX_CRITERIA)
      .filter((c) => typeof c === 'string').map((c) => clean(c, 64)).filter(Boolean);
    part[id] = { n: v.n, of: v.of, got };
  }
  return { done, part };
}

// POST /api/ingest/advancements from the server mod: { tree?: { ts, list: [...] }, players: [{ uuid, name, ts, done, part }] }
export async function ingestAdvancements(request, env) {
  const secret = env.CHAT_INGEST_TOKEN || '';
  if (secret.length < 32) return json({ error: 'ingest is not set up (no CHAT_INGEST_TOKEN secret)' }, 503);
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ') || !(await sameSecret(auth.slice(7), secret))) return json({ error: 'unauthorized' }, 401);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too large' }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  const players = body?.players ?? [];
  if (!Array.isArray(players) || players.length > MAX_PLAYERS) return json({ error: `expected { players: [...] }, at most ${MAX_PLAYERS}` }, 400);

  const now = Date.now();
  const okTime = (ts) => Number.isSafeInteger(ts) && ts <= now + 5 * 60_000;
  const rows = [];
  let tree = false;
  if (body.tree && typeof body.tree === 'object' && okTime(body.tree.ts)) {
    const list = cleanTree(body.tree.list);
    if (list?.length) {
      // the tree is the same from one server start to the next: only written when it changed
      const data = JSON.stringify(list);
      const old = await env.DB.prepare('SELECT data FROM advancement_tree WHERE id = 1').first();
      if (old?.data !== data) {
        rows.push(env.DB.prepare(
          `INSERT INTO advancement_tree (id, ts, data) VALUES (1, ?1, ?2)
           ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, data = excluded.data WHERE excluded.ts >= advancement_tree.ts`
        ).bind(Math.floor(body.tree.ts / 1000), data));
      }
      tree = true;
    }
  }
  const stmt = env.DB.prepare(
    `INSERT INTO advancements (name, uuid, ts, data) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(name) DO UPDATE SET uuid = excluded.uuid, ts = excluded.ts, data = excluded.data WHERE excluded.ts >= advancements.ts`
  );
  let stored = 0;
  for (const p of players) {
    if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !NAME_RE.test(p.name) || !okTime(p.ts)) continue;
    const uuid = typeof p.uuid === 'string' && UUID_RE.test(p.uuid) ? p.uuid.toLowerCase() : null;
    rows.push(stmt.bind(p.name, uuid, Math.floor(p.ts / 1000), JSON.stringify(cleanProgress(p))));
    stored++;
  }
  if (rows.length) await env.DB.batch(rows);
  return json({ stored, tree });
}

// GET /api/advancements?name=… — the tree, and that player's progress in it:
//   { tree: [...], ts, done: { id: unix seconds }, part: { id: { n, of } } }
// ts is when the player's progress was last reported (null if never, or not in this season: a
// season is a new world, so progress reported in another one doesn't count).
export async function advancementsFor(env, url, season) {
  const name = url.searchParams.get('name') || '';
  if (!NAME_RE.test(name)) return json({ error: 'bad name' }, 400);
  // all of their accounts (src/aliases.js): what any of them earned, and the newest one's progress
  const names = (await playerGroup(env.DB, { name }))?.names || [name];
  const [t, p] = await env.DB.batch([
    env.DB.prepare('SELECT ts, data FROM advancement_tree WHERE id = 1'),
    env.DB.prepare(`SELECT ts, data FROM advancements WHERE name IN (${marks(names)}) AND ts >= ? AND ts < ? ORDER BY ts DESC`)
      .bind(...names, season.lo, season.hi),
  ]);
  const body = { tree: [], ts: null, done: {}, part: {} };
  try {
    const tree = t.results[0];
    if (tree && tree.ts >= season.lo && tree.ts < season.hi) body.tree = JSON.parse(tree.data);
    for (const [i, mine] of p.results.entries()) {
      const data = JSON.parse(mine.data);
      if (i === 0) {
        body.ts = mine.ts;
        // which criteria are done is kept in the database but not needed by the page
        body.part = Object.fromEntries(Object.entries(data.part || {}).map(([id, v]) => [id, { n: v.n, of: v.of }]));
      }
      for (const [id, at] of Object.entries(data.done || {})) {
        if (!(id in body.done) || at < body.done[id]) body.done[id] = at; // the first time any account got it
      }
    }
    for (const id of Object.keys(body.done)) delete body.part[id];
  } catch {
    // unreadable rows: show nothing rather than fail
  }
  return json(body);
}
