// The admin page: who may use it, and what it can change. Admins are the emails in the ADMIN_EMAIL
// secret (comma-separated), so they stay out of this public repository.
//   GET  /api/me     { email, admin } for the page (no database needed)
//   GET  /api/admin  the lists the admin page edits
//   POST /api/admin  { action, ... } one change (see ACTIONS)
import { json } from './util.js';
import { fillGaps } from './gapfill.js';
import { clearCache } from './cache.js';
import { tellPresence } from './presence.js';
import { linkProbe, linkStatus } from './link.js';

const IGN_RE = /^[A-Za-z0-9_]{1,32}$/;
const TEAM_RE = /^[a-z][a-z0-9-]{0,19}$/;
const EGG_RE = /^[a-z][a-z0-9_]{0,23}$/;

export const isAdmin = (env, who) => {
  const email = who?.email?.toLowerCase();
  if (!email) return false;
  return String(env.ADMIN_EMAIL || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean).includes(email);
};

export const me = (env, who) => json({ email: who.email, admin: isAdmin(env, who) });

export async function adminState(env, season) {
  if (!season.n) return json({ error: 'pick a season' }, 400);
  const db = env.DB;
  const [roster, hidden, aliases, players, uncounted, deleted] = await db.batch([
    db.prepare('SELECT ign, team, egg FROM roster WHERE season = ? ORDER BY team, ign COLLATE NOCASE').bind(season.n),
    db.prepare('SELECT name, note FROM hidden_players ORDER BY name COLLATE NOCASE'),
    db.prepare('SELECT alias, name FROM player_aliases ORDER BY name COLLATE NOCASE, alias COLLATE NOCASE'),
    db.prepare('SELECT name FROM players GROUP BY lower(name) ORDER BY name COLLATE NOCASE'),
    db.prepare(`SELECT d.id, d.ts_ms AS ts, c.text FROM deaths d JOIN chat c ON c.id = d.id
                WHERE d.uncounted = 1 ORDER BY d.ts_ms DESC LIMIT 500`),
    db.prepare(`SELECT event_id, ts_ms AS ts, deleted_at, json_extract(chat, '$.kind') AS kind,
                json_extract(chat, '$.name') AS name, json_extract(chat, '$.text') AS text, death IS NOT NULL AS death
                FROM deleted_chat ORDER BY deleted_at DESC LIMIT 500`),
  ]);
  return json({
    season: season.n,
    roster: roster.results,
    hidden: hidden.results,
    aliases: aliases.results,
    players: players.results.map((r) => r.name),
    uncounted: uncounted.results,
    deleted: deleted.results,
    link: await linkStatus(env), // the server mod's web chat connection (src/link.js)
  });
}

const bad = (msg) => json({ error: msg }, 400);
const ign = (v) => (typeof v === 'string' && IGN_RE.test(v.trim()) ? v.trim() : null);
const chatId = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

// Each returns a Response on bad input, or nothing once it's done.
const ACTIONS = {
  // a player's team and egg this season; a new player gets their IGN for a name until the roster file gives one
  async 'roster.set'(db, b, season) {
    const name = ign(b.ign);
    if (!name) return bad('bad IGN');
    if (typeof b.team !== 'string' || !TEAM_RE.test(b.team)) return bad('bad team');
    const egg = b.egg == null || b.egg === '' ? null : b.egg;
    if (egg != null && (typeof egg !== 'string' || !EGG_RE.test(egg))) return bad('bad egg');
    await db.prepare(
      `INSERT INTO roster (season, ign, name, team, egg) VALUES (?1, ?2, ?2, ?3, ?4)
       ON CONFLICT(season, ign) DO UPDATE SET team = excluded.team, egg = excluded.egg`
    ).bind(season.n, name, b.team, egg).run();
  },
  async 'roster.remove'(db, b, season) {
    const name = ign(b.ign);
    if (!name) return bad('bad IGN');
    await db.prepare('DELETE FROM roster WHERE season = ? AND ign = ?').bind(season.n, name).run();
  },
  async 'hidden.add'(db, b) {
    const name = ign(b.name);
    if (!name) return bad('bad name');
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 200) || null : null;
    await db.prepare('INSERT INTO hidden_players (name, note) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET note = excluded.note')
      .bind(name, note).run();
  },
  async 'hidden.remove'(db, b) {
    const name = ign(b.name);
    if (!name) return bad('bad name');
    await db.prepare('DELETE FROM hidden_players WHERE name = ?').bind(name).run();
  },
  // another account (alias) shown as part of a player (name)
  async 'alias.set'(db, b) {
    const alias = ign(b.alias), name = ign(b.name);
    if (!alias || !name) return bad('bad name');
    if (alias.toLowerCase() === name.toLowerCase()) return bad('an account can’t be its own alias');
    const chain = await db.prepare('SELECT 1 FROM player_aliases WHERE alias = ? OR name = ? LIMIT 1').bind(name, alias).first();
    if (chain) return bad(`${name} is itself an alias, or ${alias} already has aliases; merge into the main account`);
    await db.prepare('INSERT INTO player_aliases (alias, name) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET name = excluded.name')
      .bind(alias, name).run();
  },
  async 'alias.remove'(db, b) {
    const alias = ign(b.alias);
    if (!alias) return bad('bad name');
    await db.prepare('DELETE FROM player_aliases WHERE alias = ?').bind(alias).run();
  },
  // out of the chat log (and Combat, for a death), kept in deleted_chat so it can be put back
  async 'chat.delete'(db, b) {
    const id = chatId(b.id);
    if (!id) return bad('bad id');
    const row = await db.prepare('SELECT * FROM chat WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'already gone' }, 404);
    const death = await db.prepare('SELECT * FROM deaths WHERE id = ?').bind(id).first();
    await db.batch([
      db.prepare('INSERT OR REPLACE INTO deleted_chat (event_id, id, ts_ms, deleted_at, chat, death) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(row.event_id, id, row.ts_ms, Date.now(), JSON.stringify(row), death ? JSON.stringify(death) : null),
      db.prepare('DELETE FROM deaths WHERE id = ?').bind(id),
      db.prepare('DELETE FROM chat WHERE id = ?').bind(id),
    ]);
  },
  async 'chat.restore'(db, b) {
    if (typeof b.event_id !== 'string') return bad('bad id');
    const saved = await db.prepare('SELECT chat, death FROM deleted_chat WHERE event_id = ?').bind(b.event_id).first();
    if (!saved) return json({ error: 'not found' }, 404);
    const insert = (table, row) => {
      const cols = Object.keys(row);
      if (!cols.every((c) => /^[a-z_]+$/.test(c))) throw new Error('bad saved row');
      return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .bind(...cols.map((c) => row[c]));
    };
    const chatRow = JSON.parse(saved.chat);
    // a newer line may have taken its row number since; then it gets a new one (its time keeps its place)
    if (await db.prepare('SELECT 1 FROM chat WHERE id = ?').bind(chatRow.id).first()) delete chatRow.id;
    if (await db.prepare('SELECT 1 FROM chat WHERE event_id = ?').bind(chatRow.event_id).first()) {
      await db.prepare('DELETE FROM deleted_chat WHERE event_id = ?').bind(b.event_id).run();
      return;
    }
    const res = await insert('chat', chatRow).run();
    const stmts = [];
    if (saved.death) stmts.push(insert('deaths', { ...JSON.parse(saved.death), id: chatRow.id ?? res.meta.last_row_id }));
    stmts.push(db.prepare('DELETE FROM deleted_chat WHERE event_id = ?').bind(b.event_id));
    await db.batch(stmts);
  },
  // a death left out of (or back in) the Combat page; it stays in the chat log either way
  async 'death.uncount'(db, b) {
    const id = chatId(b.id);
    if (!id) return bad('bad id');
    await db.prepare('UPDATE deaths SET uncounted = 1 WHERE id = ?').bind(id).run();
  },
  // fill in minutes an outage kept from being recorded now, instead of at the next :07 (src/gapfill.js)
  async 'gaps.fill'(db, b, season, env) {
    return json({ ok: true, gaps: await fillGaps(env, Math.floor(Date.now() / 1000)) });
  },
  // a round trip to the server mod that shows nothing in game (src/link.js)
  async 'link.test'(db, b, season, env) {
    return json({ ok: true, probe: await linkProbe(env), link: await linkStatus(env) });
  },
  async 'death.count'(db, b) {
    const id = chatId(b.id);
    if (!id) return bad('bad id');
    await db.prepare('UPDATE deaths SET uncounted = 0 WHERE id = ?').bind(id).run();
  },
};

export async function adminAction(request, env, url, season) {
  // Only this page may post here (a JSON body also can't be sent cross-site without CORS allowing it).
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'wrong origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'expected JSON' }, 415);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return bad('bad json');
  }
  const run = body && Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
  if (!run) return bad('unknown action');
  if (body.action.startsWith('roster.') && !season.n) return bad('pick a season');
  const out = (await run(env.DB, body, season, env)) || json({ ok: true });
  if (out.ok) await clearCache(env.DB); // season totals may have changed
  if (out.ok && /^(hidden|alias)\./.test(body.action)) await tellPresence(env, '/invalidate'); // the live badges
  return out;
}
