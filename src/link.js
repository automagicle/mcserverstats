// Chat from the dashboard into the game.
//
// The server mod keeps one WebSocket open to /api/ingest/link (with its CHAT_INGEST_TOKEN and the
// Access service token). That socket lives in a Durable Object, ServerLink, so every Worker request
// reaches the same one. A signed-in player whose login email is on the roster can POST
// /api/chat/send; the message goes down the socket, the mod shows it in game chat as
// "[Web] <name> text" and logs it like any other chat (marked via = 'web'), so it comes back to
// the chat log a few seconds later. Admins (the roster file's "admins" emails) send without a
// player name: a yellow [Admin] tag stands in for it (via = 'admin'). Nothing is queued: if the server isn't connected, sending
// fails right away rather than turning up in game later. If the mod doesn't answer in time the reply
// is 202 { unsure: true }: the message may or may not have been shown, and the log will tell.
//
// The socket hibernates while idle (the mod's pings are answered without waking the object), so an
// idle link costs next to nothing.

import { DurableObject } from 'cloudflare:workers';
import { sameSecret } from './chat.js';
import { CURRENT_SEASON } from './seasons.js';
import { json } from './util.js';

export const MAX_WEB_CHAT = 256; // the game's own limit for a chat message
const ACK_MS = 5_000;
// per player: at most one message every 1.5 seconds, and 8 in any 30 seconds
const GAP_MS = 1_500;
const BURST = 8;
const BURST_MS = 30_000;

const link = (env) => env.LINK.get(env.LINK.idFromName('server'));

// One line of plain text: no control characters or § formatting codes.
export const cleanWebText = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/§.?/gs, '').trim().slice(0, MAX_WEB_CHAT);

// GET /api/ingest/link (WebSocket) from the server mod.
export async function connectLink(request, env) {
  const secret = env.CHAT_INGEST_TOKEN || '';
  if (secret.length < 32) return json({ error: 'not set up (no CHAT_INGEST_TOKEN secret)' }, 503);
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ') || !(await sameSecret(auth.slice(7), secret))) return json({ error: 'unauthorized' }, 401);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'expected a WebSocket' }, 426);
  return link(env).fetch(new Request('https://link/connect', request));
}

const ADMIN = '@admin'; // roster_email's stand-in IGN for an admin (scripts/roster-sql.mjs)

// Who a login email sends as this season: { ign, team } for a roster player, { admin: true } for an
// admin, or null.
async function playerFor(env, email) {
  if (!email) return null;
  const row = await env.DB.prepare(
    `SELECT e.ign, r.team FROM roster_email e LEFT JOIN roster r ON r.season = e.season AND r.ign = e.ign
     WHERE e.season = ? AND e.email = ?`
  ).bind(CURRENT_SEASON, email).first();
  if (!row) return null;
  if (row.ign === ADMIN) return { admin: true };
  return row.team ? { ign: row.ign, team: row.team } : null;
}

// GET /api/chat/me: who you'd be sending as, and whether the server is connected.
export async function webChatMe(env, who) {
  const player = await playerFor(env, who.email);
  let linked = false;
  if (player) {
    try {
      linked = (await (await link(env).fetch('https://link/status')).json()).linked;
    } catch (err) {
      console.error('link status:', err.message);
    }
  }
  return json({ email: who.email, ign: player?.ign ?? null, team: player?.team ?? null, admin: !!player?.admin, linked, max: MAX_WEB_CHAT });
}

// POST /api/chat/send { text }
export async function sendWebChat(request, env, url, who) {
  // Only this page may post here (a JSON body also can't be sent cross-site without CORS allowing it).
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'wrong origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'expected JSON' }, 415);

  const player = await playerFor(env, who.email);
  if (!player) {
    return json({ error: who.email ? `${who.email} isn't on this season's roster, so it can't send chat` : 'not signed in with an email' }, 403);
  }
  let text;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'too large' }, 413);
    text = JSON.parse(raw).text;
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  if (typeof text !== 'string') return json({ error: 'expected { text }' }, 400);
  text = cleanWebText(text);
  if (!text) return json({ error: 'empty message' }, 400);

  const res = await link(env).fetch('https://link/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(player.admin ? { admin: true, key: who.email, text } : { name: player.ign, key: player.ign, text }),
  });
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export class ServerLink extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map(); // message id -> resolve, while a send waits for the mod's answer
    this.sent = new Map(); // player -> times of their recent messages
    // The mod pings every 30 seconds; answered here without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  socket() {
    const all = this.ctx.getWebSockets();
    return all.length ? all[all.length - 1] : null;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === '/connect') {
      // One server at a time: a new connection (say, after a restart) replaces any old one.
      for (const old of this.ctx.getWebSockets()) {
        try { old.close(4000, 'replaced by a newer connection'); } catch {}
      }
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: 'hello', max: MAX_WEB_CHAT }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (path === '/status') return json({ linked: !!this.socket() });

    if (path === '/send' && request.method === 'POST') {
      const { name = null, admin = false, key, text } = await request.json();
      const ws = this.socket();
      if (!ws) return json({ error: "The server isn't connected right now, so messages can't reach the game.", reason: 'offline' }, 503);

      const now = Date.now();
      const times = (this.sent.get(key) || []).filter((t) => now - t < BURST_MS);
      if (times.length && now - times[times.length - 1] < GAP_MS) return json({ error: 'Slow down a little.', reason: 'rate' }, 429);
      if (times.length >= BURST) return json({ error: 'Too many messages; wait a few seconds.', reason: 'rate' }, 429);
      times.push(now);
      this.sent.set(key, times);

      const id = crypto.randomUUID();
      const answer = new Promise((resolve) => {
        this.pending.set(id, resolve);
        setTimeout(() => resolve({ ok: false, unsure: true }), ACK_MS);
      });
      try {
        ws.send(JSON.stringify(admin ? { type: 'say', id, admin: true, text } : { type: 'say', id, name, text }));
      } catch {
        this.pending.delete(id);
        return json({ error: "The server isn't connected right now.", reason: 'offline' }, 503);
      }
      const r = await answer;
      this.pending.delete(id);
      // No answer in time (or an older mod saying it's busy, which can still show the message a moment later)
      // isn't a no: the page keeps the message as sending and watches the log for it.
      if (r.unsure || r.error === 'the server is busy') return json({ ok: false, unsure: true, name, admin, text }, 202);
      return r.ok ? json({ ok: true, name, admin, text }) : json({ error: r.error || 'The server refused the message.', reason: 'refused' }, 502);
    }

    return json({ error: 'not found' }, 404);
  }

  // The mod answers each message: { type: 'ack', id, ok, error? }.
  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    let m;
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    if (m?.type === 'ack' && typeof m.id === 'string') {
      this.pending.get(m.id)?.({ ok: m.ok === true, error: typeof m.error === 'string' ? m.error.slice(0, 200) : null });
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed'); } catch {}
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch {}
  }
}
