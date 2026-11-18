// Who's online according to the server mod (POST /api/ingest/online, from mod 1.7.0): everyone in
// the server's tab list. The minute-by-minute check (src/poll.js) adds these players to the ones the
// server-list ping names, since the ping can leave some out.

import { sameSecret } from './chat.js';
import { json, UUID_RE } from './util.js';
import { tellPresence } from './presence.js';
import { linkStatus } from './link.js';

const MAX_PLAYERS = 500;
const NAME_RE = /^[A-Za-z0-9_.]{1,20}$/; // Java names, and Bedrock ones through Floodgate's "." prefix
// A report older than this isn't trusted (the mod sends one at least every 20 seconds while running).
export const ONLINE_FRESH_SECONDS = 75;

export async function ingestOnline(request, env) {
  const secret = env.CHAT_INGEST_TOKEN || '';
  if (secret.length < 32) return json({ error: 'ingest is not set up (no CHAT_INGEST_TOKEN secret)' }, 503);
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ') || !(await sameSecret(auth.slice(7), secret))) return json({ error: 'unauthorized' }, 401);

  const raw = await request.text();
  if (raw.length > 64 * 1024) return json({ error: 'too large' }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  if (!body || !Array.isArray(body.players) || body.players.length > MAX_PLAYERS) {
    return json({ error: `expected { players: [{ uuid, name }], stopping? }, at most ${MAX_PLAYERS}` }, 400);
  }
  const players = [];
  const ids = new Set();
  for (const p of body.players) {
    // anyone malformed means the list can't be trusted to be complete, so the whole report is refused
    if (!p || typeof p.uuid !== 'string' || !UUID_RE.test(p.uuid) || typeof p.name !== 'string' || !NAME_RE.test(p.name)) {
      return json({ error: 'bad player entry' }, 400);
    }
    const uuid = p.uuid.toLowerCase();
    if (ids.has(uuid)) continue;
    ids.add(uuid);
    players.push({ uuid, name: p.name });
  }
  const stopping = body.stopping === true;
  await env.DB.prepare(
    `INSERT INTO server_online (id, ts, players, stopping) VALUES (1, ?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, players = excluded.players, stopping = excluded.stopping`
  ).bind(Math.floor(Date.now() / 1000), JSON.stringify(stopping ? [] : players), stopping ? 1 : 0).run();
  await tellPresence(env, '/report', { players, stopping }); // the live badges (src/presence.js)
  // link: whether the dashboard holds the mod's web chat connection (mod 1.7.1 reconnects when it doesn't)
  const status = stopping ? null : await linkStatus(env);
  // what the connection has been through lately, where the logs show it (this object's own don't always)
  if (status && (!status.linked || status.log?.some((e) => e.ago <= 25))) console.log('web chat link:', JSON.stringify(status));
  const link = status ? !!status.linked : null;
  return json({ ok: true, players: stopping ? 0 : players.length, ...(link == null ? {} : { link }) });
}

// The mod's latest list, if it's recent enough to trust: { players: [{ uuid, name }], stopping } or null.
export async function modOnline(db, nowSeconds) {
  let row;
  try {
    row = await db.prepare('SELECT ts, players, stopping FROM server_online WHERE id = 1').first();
  } catch {
    return null; // table not there yet (migration not applied): the ping alone, as before
  }
  if (!row || nowSeconds - row.ts > ONLINE_FRESH_SECONDS || row.ts > nowSeconds + 60) return null;
  try {
    return { players: JSON.parse(row.players), stopping: !!row.stopping, age: nowSeconds - row.ts };
  } catch {
    return null;
  }
}
