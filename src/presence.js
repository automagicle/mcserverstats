// Who's online right now, pushed to open pages the moment someone joins or leaves.
//
// The once-a-minute check (src/poll.js) still records the player counts the charts are drawn from;
// this is only the "live" part of the page: the online badges, the online count and the live pill.
//
// Two things feed it, both from the server mod, and both sent within a second or two of a change:
//   - join, leave and server start/stop lines from the chat log (src/chat.js forwards them here), which
//     move a badge in or out at once and give the exact time someone joined;
//   - the mod's full list of who's in the tab list (src/online.js forwards it here), sent on every
//     change and every 20 seconds regardless. That list is the final word: anything the chat lines got
//     wrong (a line lost or sent late) is put right by the next one.
// With no list for ONLINE_FRESH_SECONDS (the mod isn't running, or the server is asleep) what this
// knows is marked stale, and pages go back to the once-a-minute check's numbers.
//
// Pages connect with a WebSocket (GET /api/live, signed in like the rest of /api/). Sockets hibernate
// between updates, so an open page costs next to nothing; what's known is kept in this object's own
// storage so a wake-up doesn't need the database. Hidden players are left out and other accounts are
// shown as the player they belong to, as everywhere else.
import { DurableObject } from 'cloudflare:workers';
import { ONLINE_FRESH_SECONDS } from './online.js';
import { json } from './util.js';

const INFO_MS = 5 * 60_000; // hidden players and aliases are read again after this long
const JOIN_MEMORY_MS = 120_000; // a join line older than this doesn't give anyone's start time
const SESSION_GAP = 210; // as in poll.js
const MAX_VIEWERS = 200;

export const presence = (env) => env.PRESENCE.get(env.PRESENCE.idFromName('server'));

// Tell the presence object something, without letting a problem there break the request it came from.
export async function tellPresence(env, path, body) {
  if (!env.PRESENCE) return;
  try {
    await presence(env).fetch(`https://presence${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    console.error(`presence ${path}:`, err.message);
  }
}

export class Presence extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // pages keep their socket open with a ping now and then; answered without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.info = null; // { at, hidden: Set, alias: Map lowercased alias -> { name, uuid } }
    this.ready = ctx.blockConcurrencyWhile(async () => {
      // st: { reportAt (ms the last list arrived), up, stopping, players: [{ uuid, name }] (as the server
      // names them), since: { uuid: ms }, joins: { lowercased name: ms } }
      this.st = (await ctx.storage.get('st')) || { reportAt: 0, up: false, stopping: false, players: [], since: {}, joins: {} };
    });
  }

  async save() {
    await this.ctx.storage.put('st', this.st);
  }

  async fetch(request) {
    await this.ready;
    const path = new URL(request.url).pathname;

    if (path === '/watch') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'expected a WebSocket' }, 426);
      const viewers = this.ctx.getWebSockets();
      if (viewers.length >= MAX_VIEWERS) viewers[0].close(4001, 'too many viewers');
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(await this.view()));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method !== 'POST') return json({ error: 'not found' }, 404);
    const body = await request.json().catch(() => null);

    // the mod's list: { players: [{ uuid, name }], stopping }, already checked by src/online.js
    if (path === '/report' && body && Array.isArray(body.players)) {
      const now = Date.now();
      const before = this.key();
      const prev = new Set(this.st.players.map((p) => p.uuid));
      this.st.reportAt = now;
      this.st.stopping = !!body.stopping;
      this.st.up = !body.stopping;
      this.st.players = body.stopping ? [] : body.players.map((p) => ({ uuid: p.uuid, name: p.name }));
      const missing = [];
      for (const p of this.st.players) if (!prev.has(p.uuid) && !this.st.since[p.uuid]) missing.push(p);
      await this.fillSince(missing, now);
      this.prune(now);
      await this.save();
      // a change goes out at once; an unchanged list still goes out, so pages know it's current
      await this.broadcast(before !== this.key());
      return json({ ok: true });
    }

    // join, leave and server lines from the chat log: { events: [{ ts, kind, uuid, name, text }] }
    if (path === '/events' && body && Array.isArray(body.events)) {
      if (await this.apply(body.events)) {
        await this.save();
        await this.broadcast(true);
      }
      return json({ ok: true });
    }

    // an admin changed the hidden players or the aliases
    if (path === '/invalidate') {
      this.info = null;
      await this.ctx.storage.delete('info');
      await this.broadcast(true);
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  }

  // What a list looks like, to tell whether it changed.
  key() {
    return `${this.st.up ? 1 : 0}|${this.st.players.map((p) => `${p.uuid}:${p.name}`).sort().join(',')}`;
  }

  // Chat lines move the list on until the next full list arrives. A line older than the last list is
  // already in it (the mod sends its lines before its list), so only newer ones count.
  async apply(events) {
    const now = Date.now();
    let changed = false;
    for (const e of events) {
      if (!e || !Number.isFinite(e.ts) || now - e.ts > JOIN_MEMORY_MS) continue;
      const lname = typeof e.name === 'string' ? e.name.toLowerCase() : '';
      if (e.kind === 'join' && lname) this.st.joins[lname] = e.ts;
      if (e.ts <= this.st.reportAt) continue;
      if (e.kind === 'server') {
        const stopped = /stopp/i.test(e.text || '');
        if (this.st.players.length || this.st.up !== !stopped) changed = true;
        this.st.players = [];
        this.st.up = !stopped;
        this.st.stopping = stopped;
        continue;
      }
      if (!lname) continue;
      const at = this.st.players.findIndex((p) => p.name.toLowerCase() === lname);
      if (e.kind === 'leave' && at >= 0) {
        this.st.players.splice(at, 1);
        changed = true;
      } else if (e.kind === 'join' && at < 0 && typeof e.uuid === 'string' && e.uuid) {
        const p = { uuid: e.uuid.toLowerCase(), name: e.name };
        this.st.players.push(p);
        this.st.since[p.uuid] = e.ts;
        this.st.up = true;
        this.st.stopping = false;
        changed = true;
      }
    }
    this.prune(now);
    return changed;
  }

  // When each newly listed player came on: their join line if it's recent, otherwise the start of the
  // session the minute checks have open for them, otherwise now.
  async fillSince(players, now) {
    const lookup = [];
    for (const p of players) {
      const joined = this.st.joins[p.name.toLowerCase()];
      if (joined && now - joined < JOIN_MEMORY_MS) this.st.since[p.uuid] = joined;
      else lookup.push(p);
    }
    if (!lookup.length) return;
    let open = new Map();
    try {
      const { results } = await this.env.DB.prepare(
        `SELECT uuid, MIN(start_ts) AS start_ts FROM sessions WHERE end_ts >= ? AND uuid IN (${lookup.map(() => '?').join(', ')}) GROUP BY uuid`
      ).bind(Math.floor(now / 1000) - SESSION_GAP, ...lookup.map((p) => p.uuid)).all();
      open = new Map(results.map((r) => [r.uuid, r.start_ts * 1000]));
    } catch (err) {
      console.error('presence sessions:', err.message);
    }
    for (const p of lookup) this.st.since[p.uuid] = open.get(p.uuid) ?? now;
  }

  // Forget start times for players no longer on, and join lines too old to use.
  prune(now) {
    const on = new Set(this.st.players.map((p) => p.uuid));
    for (const uuid of Object.keys(this.st.since)) if (!on.has(uuid)) delete this.st.since[uuid];
    for (const [n, t] of Object.entries(this.st.joins)) if (now - t > JOIN_MEMORY_MS) delete this.st.joins[n];
  }

  // Hidden players and aliases, read now and then (and kept in storage, so waking up doesn't read them again).
  async loadInfo() {
    if (!this.info) {
      const saved = await this.ctx.storage.get('info');
      if (saved) this.info = { at: saved.at, hidden: new Set(saved.hidden), alias: new Map(saved.alias) };
    }
    if (this.info && Date.now() - this.info.at < INFO_MS) return this.info;
    try {
      const [hidden, aliases] = await this.env.DB.batch([
        this.env.DB.prepare('SELECT name FROM hidden_players'),
        this.env.DB.prepare(
          `SELECT pa.alias, pa.name, (SELECT p2.uuid FROM players p2 WHERE p2.name = pa.name ORDER BY p2.first_seen DESC LIMIT 1) AS uuid
           FROM player_aliases pa`
        ),
      ]);
      this.info = {
        at: Date.now(),
        hidden: new Set(hidden.results.map((r) => r.name.toLowerCase())),
        alias: new Map(aliases.results.map((r) => [r.alias.toLowerCase(), { name: r.name, uuid: r.uuid }])),
      };
      await this.ctx.storage.put('info', { at: this.info.at, hidden: [...this.info.hidden], alias: [...this.info.alias] });
    } catch (err) {
      console.error('presence info:', err.message);
      // keep using what was read before; with nothing yet, hide nobody rather than fail
      this.info ??= { at: 0, hidden: new Set(), alias: new Map() };
    }
    return this.info;
  }

  // What pages get: { type, fresh, up, stopping, report_at, players: [{ uuid, name, start_ts }] }, with
  // hidden players left out and each person once, under their main account.
  async view() {
    const { hidden, alias } = await this.loadInfo();
    const people = new Map();
    for (const p of this.st.players) {
      const main = alias.get(p.name.toLowerCase());
      const name = main?.name || p.name;
      if (hidden.has(name.toLowerCase()) || hidden.has(p.name.toLowerCase())) continue;
      const uuid = main?.uuid || p.uuid;
      const since = Math.floor((this.st.since[p.uuid] || Date.now()) / 1000);
      const seen = people.get(name.toLowerCase());
      if (seen) seen.start_ts = Math.min(seen.start_ts, since);
      else people.set(name.toLowerCase(), { uuid, name, start_ts: since });
    }
    const players = [...people.values()].sort((a, b) => a.start_ts - b.start_ts || a.name.localeCompare(b.name));
    const fresh = this.st.reportAt > 0 && Date.now() - this.st.reportAt <= ONLINE_FRESH_SECONDS * 1000;
    return {
      type: 'presence',
      fresh,
      up: this.st.up,
      stopping: this.st.stopping,
      report_at: Math.floor(this.st.reportAt / 1000),
      sent_at: Math.floor(Date.now() / 1000),
      players: this.st.up ? players : [],
    };
  }

  async broadcast(changed) {
    const viewers = this.ctx.getWebSockets();
    if (!viewers.length) return;
    const msg = JSON.stringify({ ...(await this.view()), changed });
    for (const ws of viewers) {
      try { ws.send(msg); } catch {}
    }
  }

  async webSocketMessage() {} // pages only listen

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed'); } catch {}
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch {}
  }
}
