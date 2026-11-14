// What each player last wore and carried, reported by the server mod (POST /api/ingest/gear) for the
// 3D model on their page. Only the fields the dashboard uses are kept; everything is re-checked here.

import { sameSecret } from './chat.js';
import { json, UUID_RE } from './util.js';

const MAX_BODY = 256 * 1024;
const MAX_PLAYERS = 100;
const MAX_ITEMS = 40;
const ID_RE = /^[a-z0-9_.:/-]{1,64}$/;
const PALETTE_RE = /^[a-z0-9_]{1,32}$/;
const NAME_RE = /^[A-Za-z0-9_.]{1,20}$/;

const clean = (s, max) => s.replace(/[\u0000-\u001f\u007f]|§[0-9a-fk-or]/gi, '').trim().slice(0, max);

// { id, n?, glint?, model?, egg?, name?, asset?, trim?: { pattern, palette }, dye? } or null
function cleanItem(it) {
  if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !ID_RE.test(it.id)) return null;
  const out = { id: it.id };
  if (Number.isInteger(it.n) && it.n > 1 && it.n < 1000) out.n = it.n;
  if (it.glint === true) out.glint = true;
  if (typeof it.model === 'string' && ID_RE.test(it.model)) out.model = it.model;
  if (it.egg === true) out.egg = true;
  if (typeof it.name === 'string' && clean(it.name, 50)) out.name = clean(it.name, 50);
  if (typeof it.asset === 'string' && ID_RE.test(it.asset)) out.asset = it.asset;
  const t = it.trim;
  if (t && typeof t.pattern === 'string' && ID_RE.test(t.pattern) && typeof t.palette === 'string' && PALETTE_RE.test(t.palette)) {
    out.trim = { pattern: t.pattern, palette: t.palette };
  }
  if (Number.isInteger(it.dye) && it.dye >= 0 && it.dye <= 0xffffff) out.dye = it.dye;
  return out;
}

function cleanReport(p) {
  const armor = {};
  for (const slot of ['head', 'chest', 'legs', 'feet']) {
    const it = cleanItem(p.armor?.[slot]);
    if (it) armor[slot] = it;
  }
  const out = { armor };
  for (const hand of ['mainhand', 'offhand']) {
    const it = cleanItem(p[hand]);
    if (it) out[hand] = it;
  }
  out.items = (Array.isArray(p.items) ? p.items : []).slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean);
  // Egg SMP: which egg they have (its number in the egg mod), its level (1 or 2) and its energy (0 to 5)
  const small = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  const e = p.egg;
  if (e && typeof e === 'object' && small(e.type, 999) && e.type > 0) {
    out.egg = { type: e.type };
    if (small(e.tier, 9)) out.egg.tier = e.tier;
    if (small(e.energy, 99)) out.egg.energy = e.energy;
  }
  return out;
}

export async function ingestGear(request, env) {
  const secret = env.CHAT_INGEST_TOKEN || '';
  if (secret.length < 32) return json({ error: 'ingest is not set up (no CHAT_INGEST_TOKEN secret)' }, 503);
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ') || !(await sameSecret(auth.slice(7), secret))) return json({ error: 'unauthorized' }, 401);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too large' }, 413);
  let players;
  try {
    players = JSON.parse(raw).players;
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  if (!Array.isArray(players) || players.length > MAX_PLAYERS) return json({ error: `expected { players: [...] }, at most ${MAX_PLAYERS}` }, 400);

  const now = Date.now();
  const stmt = env.DB.prepare(
    `INSERT INTO gear (name, uuid, ts, data) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(name) DO UPDATE SET uuid = excluded.uuid, ts = excluded.ts, data = excluded.data WHERE excluded.ts >= gear.ts`
  );
  const rows = [];
  for (const p of players) {
    if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !NAME_RE.test(p.name)) continue;
    if (!Number.isSafeInteger(p.ts) || p.ts > now + 5 * 60_000) continue;
    const uuid = typeof p.uuid === 'string' && UUID_RE.test(p.uuid) ? p.uuid.toLowerCase() : null;
    rows.push(stmt.bind(p.name, uuid, Math.floor(p.ts / 1000), JSON.stringify(cleanReport(p))));
  }
  if (rows.length) await env.DB.batch(rows);
  return json({ stored: rows.length });
}

// The player's last report, as { ts, uuid, armor, mainhand?, offhand?, items, egg? }, or null.
export async function gearFor(db, name) {
  const row = await db.prepare('SELECT ts, uuid, data FROM gear WHERE name = ?').bind(name).first();
  if (!row) return null;
  try {
    return { ts: row.ts, uuid: row.uuid, ...JSON.parse(row.data) };
  } catch {
    return null;
  }
}
