// Minecraft's own textures (armor, trims, items) and players' skins, for the 3D model on player pages.
//
// Textures come straight out of the official game client for the server's version (MC_VERSION),
// downloaded from Mojang piece by piece: a .jar is a zip, so one ranged request reads its table of
// contents (cached) and another reads just the one file asked for. Nothing of Mojang's is kept in
// this repository, and only signed-in visitors can load them (they're under /api/).

import { json } from './util.js';

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const TEXTURE_RE = /^textures\/(item|misc|entity\/player\/(wide|slim)|entity\/equipment\/humanoid(_leggings)?|trims\/entity\/humanoid(_leggings)?|trims\/color_palettes)\/[a-z0-9_]{1,64}\.png$/;
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
