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
// Whispers (/w, /msg, /tell) typed on the dashboard come here too (src/whisper.js): to the player in game
// through the mod (1.8.0), or to their page if they're only on the website. The mod sends whispers typed
// in game to someone who's only on the website, and is sent who that is whenever it changes.
//
// The socket hibernates while idle, so an idle link costs next to nothing. The mod's pings (every 30
// seconds) are answered by this object itself, not by Cloudflare's automatic reply: after a deploy
// the automatic reply could keep answering for a connection this object no longer holds, so the mod
// thought it was connected while the dashboard said it wasn't. Answered here, a connection the object
// doesn't hold goes quiet, and the mod reconnects by itself within about 75 seconds.

import { DurableObject } from 'cloudflare:workers';
import { sameSecret } from './chat.js';
import { CURRENT_SEASON } from './seasons.js';
import { json } from './util.js';
import { tellPresence } from './presence.js';
import { ADMIN_SENDER, deliverWhisper, parseCommand } from './whisper.js';

export const MAX_WEB_CHAT = 256; // the game's own limit for a chat message
const IGN_RE = /^[A-Za-z0-9_.]{1,20}$/;
const ACK_MS = 5_000;
// per player: at most one message every 1.5 seconds, and 8 in any 30 seconds
const GAP_MS = 1_500;
const BURST = 8;
const BURST_MS = 30_000;

// The mod pings every 30 seconds; a connection not heard from for this long is dead, whatever it looks like.
const QUIET_MS = 100_000;
const link = (env) => env.LINK.get(env.LINK.idFromName('server'));

// What the web chat connection is doing, for the logs and the admin page: { linked, sockets, version,
// connected_ago, heard_ago, started_ago (this object), log: recent connects and closes }.
export async function linkProbe(env) {
  try {
    return await (await link(env).fetch('https://link/probe')).json();
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

export async function linkStatus(env) {
  if (!env.LINK) return null;
  try {
    return await (await link(env).fetch('https://link/status')).json();
  } catch (err) {
    console.error('link status:', err.message);
    return null;
  }
}

// Whether this side holds the mod's web chat connection, or null if that couldn't be found out. The
// mod is told with each online list (src/online.js): after a deploy its connection can look open to it
// while this side no longer has it, and that's how it finds out to reconnect.
export async function linkUp(env) {
  if (!env.LINK) return null;
  try {
    return !!(await (await link(env).fetch('https://link/status')).json()).linked;
  } catch (err) {
    console.error('link status:', err.message);
    return null;
  }
}

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
export async function playerFor(env, email) {
  if (!email) return null;
  const row = await env.DB.prepare(
    `SELECT e.ign, r.team FROM roster_email e LEFT JOIN roster r ON r.season = e.season AND r.ign = e.ign
     WHERE e.season = ? AND e.email = ?`
  ).bind(CURRENT_SEASON, email).first();
  if (!row) return null;
  if (row.ign === ADMIN) return { admin: true };
  return row.team ? { ign: row.ign, team: row.team } : null;
}

// A player's name the way the game spells it (the roster's capitals can differ). The game looks up a
// name's team exactly, so a message sent as "Mar9904" for the player "mar9904" lost its team color.
async function gameName(env, ign) {
  try {
    // with more than one spelling on record, the one most recently on the server
    const row = await env.DB.prepare(
      `SELECT p.name FROM players p WHERE p.name = ? COLLATE NOCASE
       ORDER BY (SELECT MAX(s.end_ts) FROM sessions s WHERE s.uuid = p.uuid) DESC LIMIT 1`
    ).bind(ign).first();
    return row?.name || ign;
  } catch {
    return ign;
  }
}

// GET /api/chat/me: who you'd be sending as, and whether the server is connected.
export async function webChatMe(env, who) {
  const player = await playerFor(env, who.email);
  const linked = player ? (await linkUp(env)) === true : false;
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

  const sendAs = player.admin ? null : await gameName(env, player.ign);

  // "/w Name message" (or /msg, /tell): a whisper (src/whisper.js)
  const command = parseCommand(text);
  if (command?.error) return json({ error: command.error, reason: 'command' }, 400);
  if (command) {
    const sender = player.admin ? ADMIN_SENDER : player.ign;
    if (command.target.toLowerCase() === sender.toLowerCase()) return json({ error: 'You can’t whisper to yourself.', reason: 'command' }, 400);
    const res = await link(env).fetch('https://link/whisper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sendAs, admin: !!player.admin, key: player.admin ? who.email : player.ign, target: command.target, text: command.text }),
    });
    const r = await res.json().catch(() => ({ error: 'Something went wrong.' }));
    if (!res.ok) return json(r, res.status);
    const whisper = await deliverWhisper(env, { sender, target: r.to, text: command.text, via: 'web' });
    return json({ ok: true, whisper, where: r.where, unsure: !!r.unsure });
  }

  const began = Date.now();
  const res = await link(env).fetch('https://link/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(player.admin ? { admin: true, key: who.email, text } : { name: sendAs, key: player.ign, text }),
  });
  console.log(`web chat send: HTTP ${res.status} after ${Date.now() - began}ms`);
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export class ServerLink extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = new Map(); // message id -> resolve, while a send waits for the mod's answer
    this.late = new Map(); // message id -> when it was sent, for the ones that got no answer in time
    this.sent = new Map(); // player -> times of their recent messages
    this.web = null; // roster players with the dashboard open (src/presence.js), for whispers typed in game
    this.started = Date.now();
    this.log = null; // recent connects and closes, kept in storage: [{ at, what }]
    ctx.setWebSocketAutoResponse(); // no automatic reply: pings are answered in webSocketMessage
  }

  async webList() {
    this.web ??= (await this.ctx.storage.get('web')) ?? [];
    return this.web;
  }

  // At most one message every GAP_MS per sender, and BURST in any BURST_MS. A Response when it's too soon.
  limited(key) {
    const now = Date.now();
    const times = (this.sent.get(key) || []).filter((t) => now - t < BURST_MS);
    if (times.length && now - times[times.length - 1] < GAP_MS) return json({ error: 'Slow down a little.', reason: 'rate' }, 429);
    if (times.length >= BURST) return json({ error: 'Too many messages; wait a few seconds.', reason: 'rate' }, 429);
    times.push(now);
    this.sent.set(key, times);
    return null;
  }

  // Sends the mod a message that it answers with an ack: { ok, error } or { ok: false, unsure: true }.
  async ask(ws, message) {
    const id = crypto.randomUUID();
    const answer = new Promise((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => resolve({ ok: false, unsure: true }), ACK_MS);
    });
    try {
      ws.send(JSON.stringify({ ...message, id }));
    } catch {
      this.pending.delete(id);
      return null; // not connected after all
    }
    const sent = Date.now();
    const r = await answer;
    this.pending.delete(id);
    if (r.unsure) {
      const a = ws.deserializeAttachment() || {};
      this.late.set(id, sent);
      if (this.late.size > 50) this.late.delete(this.late.keys().next().value);
      this.note(`no answer to a ${message.type} within ${ACK_MS / 1000}s (connection ${ws.readyState === WebSocket.OPEN ? 'open' : 'not open'}, `
        + `last heard ${Math.round((Date.now() - (a.heard || 0)) / 1000)}s ago, ${this.ctx.getWebSockets().length} socket(s))`);
    }
    return r;
  }

  // The mod's connection, if there's a live one. One that hasn't been heard from for QUIET_MS (no
  // ping, no answer) is dead even if it still looks open from here, so it's closed and doesn't count:
  // a message sent down it would just wait for an answer that never comes.
  socket() {
    const now = Date.now();
    let live = null;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue; // closing: a newer connection replaced it
      const a = ws.deserializeAttachment() || {};
      if (now - (a.heard || 0) > QUIET_MS) {
        this.note(`dropped a connection not heard from for ${Math.round((now - (a.heard || 0)) / 1000)}s`);
        try { ws.close(4001, 'went quiet'); } catch {}
        this.ctx.waitUntil(this.gone(ws));
        continue;
      }
      if (!live || (a.at || 0) >= (live.deserializeAttachment()?.at || 0)) live = ws;
    }
    return live;
  }

  // Heard from the mod on this connection just now.
  heard(ws) {
    const a = ws.deserializeAttachment() || {};
    ws.serializeAttachment({ ...a, heard: Date.now() });
  }

  note(what) {
    console.log(`web chat link: ${what}`);
    this.ctx.waitUntil((async () => {
      this.log ??= (await this.ctx.storage.get('log')) ?? [];
      this.log.push({ at: Date.now(), what });
      if (this.log.length > 30) this.log.splice(0, this.log.length - 30);
      await this.ctx.storage.put('log', this.log);
    })());
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === '/connect') {
      // One server at a time: a new connection (say, after a restart) replaces any old one.
      for (const old of this.ctx.getWebSockets()) {
        try { old.close(4000, 'replaced by a newer connection'); } catch {}
      }
      const [client, server] = Object.values(new WebSocketPair());
      // the mod's version, from its User-Agent ("mcstats-chat/1.8.0"): whispers need 1.8.0
      const version = (request.headers.get('User-Agent') || '').match(/mcstats-chat\/(\d+)\.(\d+)/);
      const ua = (request.headers.get('User-Agent') || '').match(/mcstats-chat\/([\w.+-]{1,20})/);
      server.serializeAttachment({
        whispers: !!version && (Number(version[1]) > 1 || (Number(version[1]) === 1 && Number(version[2]) >= 8)),
        version: ua ? ua[1] : null, at: Date.now(), heard: Date.now(),
      });
      this.note(`mod ${ua ? ua[1] : '(unknown version)'} connected`);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: 'hello', max: MAX_WEB_CHAT }));
      server.send(JSON.stringify({ type: 'web', names: await this.webList() }));
      this.ctx.waitUntil(tellPresence(this.env, '/link', { up: true }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // who has the dashboard open changed (src/presence.js): { names }
    if (path === '/web' && request.method === 'POST') {
      const { names } = await request.json();
      this.web = Array.isArray(names) ? names.filter((n) => typeof n === 'string').slice(0, 500) : [];
      await this.ctx.storage.put('web', this.web);
      const ws = this.socket();
      if (ws) try { ws.send(JSON.stringify({ type: 'web', names: this.web })); } catch {}
      return json({ ok: true });
    }

    // a whisper typed on the website: { name, admin, key, target, text }. To the player in game if
    // they're on, otherwise to their page if they have the dashboard open. The answer says where:
    // { to (their name as the server has it), where: 'game' | 'web' }.
    if (path === '/whisper' && request.method === 'POST') {
      const { name = null, admin = false, key, target, text } = await request.json();
      const slow = this.limited(key);
      if (slow) return slow;
      let state = { game: [], web: [] };
      try {
        state = await (await this.env.PRESENCE.get(this.env.PRESENCE.idFromName('server')).fetch('https://presence/state')).json();
      } catch (err) {
        console.error('whisper state:', err.message);
      }
      const find = (list) => (list || []).find((n) => n.toLowerCase() === target.toLowerCase());
      const inGame = find(state.game), onWeb = find(state.web);
      const ws = this.socket();
      const canWhisper = !!ws?.deserializeAttachment()?.whispers;
      if (inGame && ws && !canWhisper && !onWeb) {
        return json({ error: `The server's mcstats-chat mod is too old to pass whispers on (it needs 1.8.0 or newer).`, reason: 'refused' }, 503);
      }
      if (inGame && ws && canWhisper) {
        const r = await this.ask(ws, admin ? { type: 'whisper', admin: true, to: inGame, text } : { type: 'whisper', name, to: inGame, text });
        if (r?.ok) return json({ ok: true, to: inGame, where: 'game' });
        if (r?.unsure) return json({ ok: true, to: inGame, where: 'game', unsure: true });
        if (!onWeb) return json({ error: r?.error || 'No player was found.', reason: 'refused' }, r ? 404 : 503);
      }
      if (onWeb) return json({ ok: true, to: onWeb, where: 'web' });
      if (inGame) return json({ error: `The server isn't connected right now, so this can't reach ${inGame} in game.`, reason: 'offline' }, 503);
      return json({ error: `No player was found called ${target}, in game or on the website.`, reason: 'refused' }, 404);
    }

    if (path === '/status') {
      const ws = this.socket();
      const a = ws?.deserializeAttachment() || {};
      const now = Date.now();
      const ago = (t) => (t ? Math.round((now - t) / 1000) : null);
      this.log ??= (await this.ctx.storage.get('log')) ?? [];
      return json({
        linked: !!ws, sockets: this.ctx.getWebSockets().length, version: a.version ?? null,
        connected_ago: ago(a.at), heard_ago: ago(a.heard), started_ago: ago(this.started),
        log: this.log.slice(-12).map((e) => ({ ago: ago(e.at), what: e.what })),
      });
    }

    // A round trip to the mod that shows nothing in game: a message without a sender, which the mod
    // refuses with "bad message". { ok (it answered), ms, answer } or { ok: false, why }.
    if (path === '/probe') {
      const ws = this.socket();
      if (!ws) return json({ ok: false, why: 'not connected' });
      const began = Date.now();
      const r = await this.ask(ws, { type: 'say', name: '', text: 'connection test' });
      if (!r) return json({ ok: false, why: 'not connected' });
      if (r.unsure) return json({ ok: false, why: `no answer within ${ACK_MS / 1000}s`, ms: Date.now() - began });
      return json({ ok: true, ms: Date.now() - began, answer: r.error || 'ok' });
    }

    if (path === '/send' && request.method === 'POST') {
      const { name = null, admin = false, key, text } = await request.json();
      const ws = this.socket();
      if (!ws) return json({ error: "The server isn't connected right now, so messages can't reach the game.", reason: 'offline' }, 503);

      const slow = this.limited(key);
      if (slow) return slow;
      const began = Date.now();
      const r = await this.ask(ws, admin ? { type: 'say', admin: true, text } : { type: 'say', name, text });
      if (!r) return json({ error: "The server isn't connected right now.", reason: 'offline' }, 503);
      const took = Date.now() - began;
      if (!r.ok && !r.unsure) this.note(`the mod refused a message after ${(took / 1000).toFixed(1)}s: "${String(r.error).slice(0, 60)}"`);
      else if (r.ok && took > 1500) this.note(`a message took ${(took / 1000).toFixed(1)}s to be shown`);
      if (/too busy/.test(r.error || '')) {
        return json({ error: 'The Minecraft server was too busy to show that message (it may be lagging). Nothing was sent; try again in a moment.', reason: 'refused' }, 502);
      }
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
    this.heard(ws);
    if (message === 'ping') {
      try { ws.send('pong'); } catch {}
      return;
    }
    let m;
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    if (m?.type === 'ack' && typeof m.id === 'string') {
      if (this.late.has(m.id)) {
        this.note(`the answer came late, ${((Date.now() - this.late.get(m.id)) / 1000).toFixed(1)}s after sending (ok: ${m.ok === true}${m.error ? `, "${String(m.error).slice(0, 60)}"` : ''})`);
        this.late.delete(m.id);
      } else if (!this.pending.has(m.id)) {
        this.note(`an answer came for a message no longer waited on (ok: ${m.ok === true})`);
      }
      this.pending.get(m.id)?.({ ok: m.ok === true, error: typeof m.error === 'string' ? m.error.slice(0, 200) : null });
    }
    // typed in game to a player who's only on the website (mod 1.8.0): { id, from, to, text }
    if (m?.type === 'whisper' && typeof m.id === 'string') {
      const answer = (error) => { try { ws.send(JSON.stringify({ type: 'ack', id: m.id, ok: !error, ...(error ? { error } : {}) })); } catch {} };
      const from = typeof m.from === 'string' && IGN_RE.test(m.from) ? m.from : null;
      const text = typeof m.text === 'string' ? cleanWebText(m.text) : '';
      const to = typeof m.to === 'string' ? (await this.webList()).find((n) => n.toLowerCase() === m.to.toLowerCase()) : null;
      if (!from || !text) return answer('bad message');
      if (!to) return answer(`${m.to} isn't on the website any more`);
      try {
        await deliverWhisper(this.env, { sender: from, target: to, text, via: 'game' });
        answer(null);
      } catch (err) {
        console.error('whisper from game:', err.message);
        answer("the dashboard couldn't keep it");
      }
    }
  }

  // The mod's connection is gone (unless a newer one replaced it): pages' message boxes say so.
  async gone(ws) {
    if (!this.ctx.getWebSockets().some((s) => s !== ws)) await tellPresence(this.env, '/link', { up: false });
  }

  async webSocketClose(ws, code, reason) {
    this.note(`connection closed (${code}${reason ? `: ${reason}` : ''})`);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed'); } catch {}
    await this.gone(ws);
  }

  async webSocketError(ws, error) {
    this.note(`connection error (${String(error?.message || error).slice(0, 80)})`);
    try { ws.close(1011, 'error'); } catch {}
    await this.gone(ws);
  }
}
