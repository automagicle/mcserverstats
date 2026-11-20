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
// The latest of these names' (one player's accounts) gear reports.
export async function gearFor(db, names) {
  const row = await db.prepare(`SELECT ts, uuid, data FROM gear WHERE name IN (${names.map(() => '?').join(', ')}) ORDER BY ts DESC LIMIT 1`)
    .bind(...names).first();
  if (!row) return null;
  try {
    return { ts: row.ts, uuid: row.uuid, ...JSON.parse(row.data) };
  } catch {
    return null;
  }
}

// Each named item they carry (a custom name, as on an anvil) as the game styles it, found in the chat
// log: a death message names the weapon it was done with, with its colors and tooltip (src/chat.js
// cleanRich). The server mod reports only the plain name with the gear, so this is how the dashboard
// can show it as in game without asking the mod for more. Their own kills come first, then the latest.
//   -> { [plain name]: { name: [{ t, c? }], tip: [[{ t, c?, i? }]] or null, ts (ms) } }
// Items no message has named yet are left out (the page draws them from their item id).
export async function gearStyles(db, gear, names) {
  const wanted = new Set();
  for (const it of [gear?.mainhand, gear?.offhand, ...(gear?.items || [])]) if (it?.name) wanted.add(it.name);
  if (!wanted.size) return {};
  const mine = new Set(names.map((n) => n.toLowerCase()));
  const { results } = await db.prepare(
    `SELECT c.ts_ms AS ts, c.rich, d.killer FROM chat c LEFT JOIN deaths d ON d.id = c.id
     WHERE c.kind = 'death' AND c.rich IS NOT NULL AND (c.rich LIKE '%"w":1%' OR c.text LIKE '%[%]%')
     ORDER BY c.ts_ms DESC LIMIT 3000`
  ).all();
  const out = {};
  const rank = {}; // name -> 0 for one of their own kills, 1 for anyone's
  for (const r of results) {
    let pieces;
    try { pieces = JSON.parse(r.rich); } catch { continue; }
    const item = weaponIn(pieces);
    if (!item || !wanted.has(item.plain)) continue;
    const k = r.killer && mine.has(r.killer.toLowerCase()) ? 0 : 1;
    const had = out[item.plain];
    // newest first, so a later row only wins by being theirs, or by having a tooltip where the other didn't
    if (had && (rank[item.plain] < k || (rank[item.plain] === k && (had.tip || !item.tip)))) continue;
    out[item.plain] = { name: item.name, tip: item.tip, ts: r.ts };
    rank[item.plain] = k;
  }
  return out;
}

// The weapon named in a death message's pieces: the ones the server mod marked (w), or in older
// messages the [bracketed] part that isn't a player. Its name without the brackets, and its tooltip.
function weaponIn(pieces) {
  let run = pieces.filter((p) => p.w);
  if (!run.length) {
    const from = pieces.findIndex((p) => !p.p && p.t.trimStart().startsWith('['));
    const to = from < 0 ? -1 : pieces.findIndex((p, k) => k >= from && p.t.trimEnd().endsWith(']'));
    if (to < 0 || pieces.slice(from, to + 1).some((p) => p.p)) return null;
    run = pieces.slice(from, to + 1);
  }
  const tip = run.find((p) => p.i)?.i || null;
  const name = run.map((p) => ({ t: p.t, ...(p.c ? { c: p.c } : {}) }));
  name[0] = { ...name[0], t: name[0].t.replace(/^\s*\[/, '') };
  name[name.length - 1] = { ...name.at(-1), t: name.at(-1).t.replace(/\]\s*$/, '') };
  const shown = name.filter((p) => p.t);
  const plain = shown.map((p) => p.t).join('').trim();
  return plain ? { name: shown, tip, plain } : null;
}
