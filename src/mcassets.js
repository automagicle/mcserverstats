// Minecraft's own textures (armor, trims, items, blocks, particles, the advancements screen) and players'
// skins, for the 3D model and the advancement tree on player pages.
//
// Textures come straight out of the official game client for the server's version (MC_VERSION),
// downloaded from Mojang piece by piece: a .jar is a zip, so one ranged request reads its table of
// contents (cached) and another reads just the one file asked for. Nothing of Mojang's is kept in
// this repository, and only signed-in visitors can load them (they're under /api/).

import { json } from './util.js';

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const TEXTURE_RE = /^textures\/(item|block|misc|particle|gui\/sprites\/advancements|gui\/advancements\/backgrounds|entity|entity\/(chest|bed|skeleton|zombie|creeper|piglin|enderdragon|decorated_pot|banner|shield)|entity\/player\/(wide|slim)|entity\/equipment\/humanoid(_leggings)?|trims\/entity\/humanoid(_leggings)?|trims\/color_palettes)\/[a-z0-9_]{1,64}\.png$/;
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const WEEK = 7 * 86400;

const png = (body, maxAge, extra = {}) => new Response(body, {
  headers: { 'Content-Type': 'image/png', 'Cache-Control': `private, max-age=${maxAge}`, ...extra },
});

// Responses kept in Cloudflare's cache under a made-up address (the real request needs a login).
async function cached(key, maxAge, make) {
  const cache = caches.default;
  const req = new Request(`https://mcstats-cache.invalid/${key}`);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await make();
  if (res.ok) await cache.put(req, new Response(res.clone().body, { headers: { ...Object.fromEntries(res.headers), 'Cache-Control': `public, max-age=${maxAge}` } }));
  return res;
}

/* ---------- the client jar, read in pieces ---------- */

let jarUrl = null; // per isolate
let directory = null; // { version, bytes, text }

async function clientJar(version) {
  if (jarUrl?.version === version) return jarUrl.url;
  const manifest = await (await fetch(MANIFEST, { cf: { cacheTtl: 3600 } })).json();
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new Error(`Minecraft ${version} isn't in Mojang's version list`);
  const meta = await (await fetch(entry.url, { cf: { cacheTtl: 86400 } })).json();
  jarUrl = { version, url: meta.downloads.client.url };
  return jarUrl.url;
}

async function range(url, from, to) {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
  if (res.status !== 206) throw new Error(`ranged download failed (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

// The zip's central directory: every file's name, size and where it starts.
async function centralDirectory(version) {
  if (directory?.version === version) return directory;
  const res = await cached(`jar-dir/${version}`, 30 * 86400, async () => {
    const url = await clientJar(version);
    const tail = new Uint8Array(await (await fetch(url, { headers: { Range: 'bytes=-65558' } })).arrayBuffer());
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip');
    const size = u32(tail, eocd + 12), offset = u32(tail, eocd + 16);
    return new Response(await range(url, offset, offset + size - 1), { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  // One character per byte, so a name's index in the text is its byte offset.
  directory = { version, bytes, text: new TextDecoder('latin1').decode(bytes) };
  return directory;
}

async function readFromJar(version, name) {
  const dir = await centralDirectory(version);
  const { bytes, text } = dir;
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    const h = at - 46; // the entry's fixed-size header comes right before its name
    if (h < 0 || u32(bytes, h) !== 0x02014b50 || u16(bytes, h + 28) !== name.length) continue;
    const method = u16(bytes, h + 10), size = u32(bytes, h + 20), local = u32(bytes, h + 42);
    const url = await clientJar(version);
    let chunk = await range(url, local, local + 30 + name.length + 512 + size);
    const start = 30 + u16(chunk, 26) + u16(chunk, 28);
    if (start + size > chunk.length) chunk = await range(url, local, local + start + size);
    const data = chunk.subarray(start, start + size);
    if (method === 0) return data;
    if (method !== 8) throw new Error(`unsupported compression ${method}`);
    const out = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(out).arrayBuffer());
  }
  return null;
}

// GET /api/mc/textures/…png
export async function serveTexture(env, path) {
  if (!TEXTURE_RE.test(path)) return json({ error: 'not found' }, 404);
  const version = env.MC_VERSION || '26.2';
  try {
    const res = await cached(`mc/${version}/${path}`, 30 * 86400, async () => {
      const data = await readFromJar(version, `assets/minecraft/${path}`);
      return data ? png(data, WEEK) : json({ error: 'not found' }, 404);
    });
    return res.ok ? png(res.body, WEEK) : res;
  } catch (err) {
    console.error(`texture ${path}:`, err.message);
    return json({ error: 'texture unavailable' }, 502);
  }
}

/* ---------- how an item is drawn in the inventory ---------- */

const ITEM_RE = /^[a-z0-9_]{1,64}$/;
const local = (id) => String(id).replace(/^minecraft:/, '');
const GRASS = 0x7cbd6b; // the grass color the game uses for items

async function jarJson(version, path) {
  const data = await readFromJar(version, path);
  return data ? JSON.parse(new TextDecoder().decode(data)) : null;
}

// The models an item definition (assets/…/items/<id>.json) shows in an inventory slot, in order:
// [{ model, tints?, xf } | { special, base, xf }], xf being the transformations wrapped around it.
function guiModels(m, xf = []) {
  if (!m || typeof m !== 'object') return [];
  if (m.transformation) xf = [...xf, m.transformation];
  switch (local(m.type)) {
    case 'model': return [{ model: local(m.model), tints: m.tints, xf }];
    case 'special': return [{ special: { ...m.model, type: local(m.model?.type) }, base: local(m.base), xf }];
    case 'composite': return (m.models || []).flatMap((c) => guiModels(c, xf));
    case 'condition': return guiModels(m.on_false, xf);
    case 'range_dispatch': return guiModels(m.fallback ?? m.entries?.[0]?.model, xf);
    case 'select': {
      const gui = local(m.property) === 'display_context'
        && (m.cases || []).find((c) => [].concat(c.when).includes('gui'));
      return guiModels(gui ? gui.model : m.fallback ?? m.cases?.[0]?.model, xf);
    }
    default: return [];
  }
}

// A model with its parents folded in: { layers } for a flat item, or { elements, textures } for a
// 3D one, plus how it sits in an inventory slot (gui) and how it's lit (light: front or side).
async function resolveModel(version, id) {
  const out = { textures: {} };
  for (let depth = 0, at = id; at && depth < 10; depth++) {
    if (at === 'builtin/generated') { out.generated = true; break; }
    if (!/^[a-z0-9_/]{1,96}$/.test(at)) break;
    const m = await jarJson(version, `assets/minecraft/models/${at}.json`);
    if (!m) break;
    for (const [k, v] of Object.entries(m.textures || {})) if (!(k in out.textures)) out.textures[k] = v;
    out.elements ??= m.elements;
    out.gui ??= m.display?.gui;
    out.light ??= m.gui_light;
    at = m.parent ? local(m.parent) : null;
  }
  const tex = (v, depth = 0) => (typeof v === 'string' && v.startsWith('#') && depth < 8 ? tex(out.textures[v.slice(1)], depth + 1) : v && local(v));
  const textures = Object.fromEntries(Object.entries(out.textures).map(([k, v]) => [k, tex(v)]).filter(([, v]) => v));
  const base = { gui: out.gui, light: out.light === 'front' || out.generated ? 'front' : 'side' };
  if (out.generated || !out.elements) {
    const layers = [];
    for (let i = 0; textures[`layer${i}`]; i++) layers.push(textures[`layer${i}`]);
    return { ...base, layers };
  }
  return { ...base, elements: out.elements, textures };
}

const tintColor = (t) => {
  const v = local(t?.type) === 'grass' ? GRASS : local(t?.type) === 'constant' ? t.value : t?.default;
  return Number.isInteger(v) ? v & 0xffffff : 0xffffff;
};

// GET /api/mc/item/<id>.json: everything needed to draw the item as its inventory icon:
//   { gui: { rotation, translation, scale }, light, parts: [{ layers | elements + textures | special, tints, xf }] }
export async function serveItem(env, path) {
  const id = path.replace(/\.json$/, '');
  if (!ITEM_RE.test(id)) return json({ error: 'not found' }, 404);
  const version = env.MC_VERSION || '26.2';
  try {
    const res = await cached(`mc-item/2/${version}/${id}`, 30 * 86400, async () => {
      const def = await jarJson(version, `assets/minecraft/items/${id}.json`);
      if (!def) return json({ error: 'not found' }, 404);
      const parts = [];
      let gui, light;
      for (const p of guiModels(def.model).slice(0, 8)) {
        const m = await resolveModel(version, p.special ? p.base : p.model);
        gui ??= m.gui;
        light ??= m.light;
        const part = { xf: p.xf };
        if (p.special) part.special = p.special;
        else if (m.layers) part.layers = m.layers;
        else Object.assign(part, { elements: m.elements, textures: m.textures });
        if (p.tints) part.tints = p.tints.map(tintColor);
        parts.push(part);
      }
      return new Response(JSON.stringify({ gui: gui ?? null, light: light ?? 'front', parts }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `private, max-age=${WEEK}` },
      });
    });
    if (!res.ok) return res;
    return new Response(res.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `private, max-age=${WEEK}` } });
  } catch (err) {
    console.error(`item ${id}:`, err.message);
    return json({ error: 'item unavailable' }, 502);
  }
}

/* ---------- skins ---------- */

// The Mojang profile id for a name: Mojang's two lookup services (each rate-limits on its own).
async function profileId(name) {
  for (const url of [
    `https://api.minecraftservices.com/minecraft/profile/lookup/name/${name}`,
    `https://api.mojang.com/users/profiles/minecraft/${name}`,
  ]) {
    const res = await fetch(url);
    if (res.status === 200) return (await res.json()).id;
    if (res.status === 404 || res.status === 204) return null;
  }
  return undefined; // couldn't tell
}

// GET /api/skin/<name>[?uuid=…]: the player's current skin. The uuid (from the server mod, so it's
// Mojang's) saves a lookup; otherwise it's looked up by name, since the server's player list may use
// made-up UUIDs. X-Skin-Model is slim (3-pixel arms), classic, or unknown (when it had to come
// from minotar.net because Mojang was busy). Players without a skin of their own get the default one.
// The game's default skin, for players without one of their own (or not known to Mojang).
async function defaultSkin(env) {
  const data = await readFromJar(env.MC_VERSION || '26.2', 'assets/minecraft/textures/entity/player/wide/steve.png');
  return data ? png(data, 3600, { 'X-Skin-Model': 'classic', 'X-Skin-Default': '1' }) : json({ error: 'no skin' }, 404);
}

export async function serveSkin(env, name, uuid) {
  if (!NAME_RE.test(name)) return json({ error: 'bad name' }, 400);
  const known = /^[0-9a-f]{32}$/.test(uuid || '') ? uuid : null;
  try {
    const res = await cached(`skin/${known || name.toLowerCase()}`, 3600, async () => {
      const id = known ?? await profileId(name);
      if (id === null) return defaultSkin(env);
      if (id) {
        const profile = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`);
        if (profile.status === 200) {
          const prop = (await profile.json()).properties?.find((p) => p.name === 'textures');
          const skin = prop && JSON.parse(atob(prop.value)).textures?.SKIN;
          if (!skin?.url) return defaultSkin(env);
          const image = await fetch(skin.url.replace(/^http:/, 'https:'));
          if (image.ok) return png(image.body, 3600, { 'X-Skin-Model': skin.metadata?.model === 'slim' ? 'slim' : 'classic' });
        }
      }
      const image = await fetch(`https://minotar.net/skin/${name}`);
      if (!image.ok) return json({ error: 'skin unavailable' }, 502);
      return png(image.body, 3600, { 'X-Skin-Model': 'unknown' });
    });
    return res.ok ? png(res.body, 3600, { 'X-Skin-Model': res.headers.get('X-Skin-Model') || 'unknown' }) : res;
  } catch (err) {
    console.error(`skin ${name}:`, err.message);
    return json({ error: 'skin unavailable' }, 502);
  }
}
