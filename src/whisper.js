// Whispers (/w, /msg, /tell) to and from people on the dashboard.
//
// Typed on the website: "/w Name message" goes to Name in game through the server mod (src/link.js),
// shown to them as "[Web] Sender whispers to you: message". If Name isn't in game but has the
// dashboard open, it goes to their page instead. Typed in game to a player who's only on the website
// (mod 1.8.0 or newer), the mod hands it to the dashboard rather than saying no one was found.
//
// Who has the dashboard open comes from the live connection every open page keeps (src/presence.js),
// which also carries whispers to the pages of the two people in one the moment it's sent. Each is kept
// in the whispers table, so a page opened later still shows them; only those two can read it back.
import { tellPresence } from './presence.js';
import { json } from './util.js';

export const WHISPER_COMMANDS = ['w', 'msg', 'tell']; // the game's own names for it
const COMMAND_RE = /^\/(\S*)/;
const IGN_RE = /^[A-Za-z0-9_.]{1,20}$/;
export const ADMIN_SENDER = '@admin';
const HISTORY = 200;

// A message typed on the website: null when it isn't a command (plain chat), { target, text } for a
// whisper, or { error } for anything else starting with "/".
export function parseCommand(text) {
  const cmd = text.match(COMMAND_RE);
  if (!cmd) return null;
  if (!WHISPER_COMMANDS.includes(cmd[1].toLowerCase())) {
    return { error: `Only /w, /msg and /tell work from here, as /w <player> <message>.` };
  }
  const m = text.match(/^\/\S+\s+(\S+)\s+(\S[\s\S]*)$/);
  if (!m) return { error: `To whisper, type /${cmd[1].toLowerCase()} <player> <message>.` };
  if (!IGN_RE.test(m[1])) return { error: `There's no player called ${m[1].slice(0, 32)}.` };
  return { target: m[1], text: m[2].trim() };
}

// Keeps a whisper and sends it to the open pages of the two people in it. w: { sender, target, text, via }.
export async function deliverWhisper(env, w) {
  const ts = Date.now();
  const res = await env.DB.prepare('INSERT INTO whispers (ts_ms, sender, target, text, via) VALUES (?, ?, ?, ?, ?)')
    .bind(ts, w.sender, w.target, w.text, w.via).run();
  const row = { id: res.meta.last_row_id, ts, sender: w.sender, target: w.target, text: w.text, via: w.via };
  await tellPresence(env, '/whisper', { whisper: row });
  return row;
}

// GET /api/chat/whispers?since_id= — the signed-in person's whispers (sent and received) in the
// season's span, oldest first, the latest HISTORY of them. me is the sender name they'd use.
export async function readWhispers(env, url, me, season) {
  if (!me) return json({ whispers: [] });
  const since = Math.max(0, Number(url.searchParams.get('since_id')) || 0);
  const lo = season.lo * 1000, hi = season.hi * 1000;
  const { results } = await env.DB.prepare(
    `SELECT id, ts_ms AS ts, sender, target, text, via FROM whispers
     WHERE (sender = ?1 OR target = ?1) AND id > ?2 AND ts_ms >= ?3 AND ts_ms < ?4 ORDER BY id DESC LIMIT ?5`
  ).bind(me, since, lo, hi, HISTORY).all();
  return json({ whispers: results.reverse() });
}
