// The admin page: who may use it, and what it can change. Admins are the emails in the ADMIN_EMAIL
// secret (comma-separated), so they stay out of this public repository.
//   GET  /api/me     { email, admin } for the page (no database needed)
//   GET  /api/admin  the lists the admin page edits
//   POST /api/admin  { action, ... } one change (see ACTIONS). The page's settings (teams, roster,
//                    each player's teams over time, hidden players, merged accounts) are saved
//                    together by config.save, when the page's Save button is pressed; the rest
//                    (restoring a message, counting a death again, …) happen at once.
import { json } from './util.js';
import { fillGaps } from './gapfill.js';
import { clearCache } from './cache.js';
import { tellPresence } from './presence.js';
import { linkProbe, linkStatus } from './link.js';
import { teamRows } from './teams.js';

const IGN_RE = /^[A-Za-z0-9_]{1,32}$/;
const TEAM_RE = /^[a-z][a-z0-9-]{0,19}$/;
const EGG_RE = /^[a-z][a-z0-9_]{0,23}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_TEAMS = 12;
const MAX_ROSTER = 500;
const MAX_PERIODS = 2000;
const MAX_BODY = 4096, MAX_CONFIG_BODY = 512 * 1024;

export const isAdmin = (env, who) => {
  const email = who?.email?.toLowerCase();
  if (!email) return false;
  return String(env.ADMIN_EMAIL || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean).includes(email);
};

export const me = (env, who) => json({ email: who.email, admin: isAdmin(env, who) });

export async function adminState(env, season) {
  if (!season.n) return json({ error: 'pick a season' }, 400);
  const db = env.DB;
  const [roster, hidden, aliases, players, uncounted, deleted, history] = await db.batch([
    db.prepare('SELECT ign, team, egg FROM roster WHERE season = ? ORDER BY team, ign COLLATE NOCASE').bind(season.n),
    db.prepare('SELECT name, note FROM hidden_players ORDER BY name COLLATE NOCASE'),
    db.prepare('SELECT alias, name FROM player_aliases ORDER BY name COLLATE NOCASE, alias COLLATE NOCASE'),
    db.prepare('SELECT name FROM players GROUP BY lower(name) ORDER BY name COLLATE NOCASE'),
    db.prepare(`SELECT d.id, d.ts_ms AS ts, c.text FROM deaths d JOIN chat c ON c.id = d.id
                WHERE d.uncounted = 1 ORDER BY d.ts_ms DESC LIMIT 500`),
    db.prepare(`SELECT event_id, ts_ms AS ts, deleted_at, json_extract(chat, '$.kind') AS kind,
                json_extract(chat, '$.name') AS name, json_extract(chat, '$.text') AS text, death IS NOT NULL AS death
                FROM deleted_chat ORDER BY deleted_at DESC LIMIT 500`),
    db.prepare('SELECT ign, until, team FROM team_history WHERE season = ? ORDER BY ign COLLATE NOCASE, until').bind(season.n),
  ]);
  return json({
    season: season.n,
    roster: roster.results,
    lo: season.lo, // when the season's data begins (unix seconds), for the teams-over-time bars
    teams: await teamRows(db, season.n),
    history: history.results,
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
  // Everything the admin page's Save button saves, at once (all of it or none of it). Each part is
  // the whole of what it should be from now on, and a part that's left out isn't touched:
  //   teams:   [{ id, name, short, color, bar, middle, chart, activity, activity_with }] in their order
  //   roster:  [{ ign, team, egg }] this season's players; a new one gets their IGN for a name until the roster file gives one
  //   history: [{ ign, team, until }] players' earlier teams: on `team` (or '' for none) before `until` (unix seconds)
  //   hidden:  [{ name, note }]       aliases: [{ alias, name }]
  async 'config.save'(db, b, season) {
    const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const list = (v, max) => (Array.isArray(v) && v.length <= max && v.every((x) => x && typeof x === 'object') ? v : null);
    const lower = (v) => v.toLowerCase();
    const stmts = [];
    const [haveTeams, haveRoster, haveHidden, haveAliases] = await db.batch([
      db.prepare('SELECT id FROM teams WHERE season = ?').bind(season.n),
      db.prepare('SELECT ign, team FROM roster WHERE season = ?').bind(season.n),
      db.prepare('SELECT name FROM hidden_players'),
      db.prepare('SELECT alias FROM player_aliases'),
    ]);

    let roster = haveRoster.results; // as it will be, for checking the teams against
    if (b.roster !== undefined) {
      const rows = list(b.roster, MAX_ROSTER);
      if (!rows) return bad('bad roster');
      const seen = new Set();
      roster = [];
      for (const r of rows) {
        const name = ign(r.ign);
        if (!name) return bad(`bad IGN: ${String(r.ign).slice(0, 40)}`);
        if (seen.has(lower(name))) return bad(`${name} is on the roster twice`);
        seen.add(lower(name));
        if (typeof r.team !== 'string' || !TEAM_RE.test(r.team)) return bad(`bad team for ${name}`);
        const egg = r.egg == null || r.egg === '' ? null : r.egg;
        if (egg != null && (typeof egg !== 'string' || !EGG_RE.test(egg))) return bad(`bad egg for ${name}`);
        roster.push({ ign: name, team: r.team });
        stmts.push(db.prepare(
          `INSERT INTO roster (season, ign, name, team, egg) VALUES (?1, ?2, ?2, ?3, ?4)
           ON CONFLICT(season, ign) DO UPDATE SET team = excluded.team, egg = excluded.egg`
        ).bind(season.n, name, r.team, egg));
      }
      for (const r of haveRoster.results) {
        if (!seen.has(lower(r.ign))) stmts.push(db.prepare('DELETE FROM roster WHERE season = ? AND ign = ?').bind(season.n, r.ign));
      }
    }

    if (b.teams !== undefined) {
      const rows = list(b.teams, MAX_TEAMS);
      if (!rows) return bad(`bad teams (at most ${MAX_TEAMS})`);
      const ids = new Set();
      for (const t of rows) {
        if (typeof t.id !== 'string' || !TEAM_RE.test(t.id)) return bad('a team needs an id: lowercase letters, digits and dashes, starting with a letter');
        if (ids.has(t.id)) return bad(`two teams are called ${t.id}`);
        ids.add(t.id);
        if (typeof t.color !== 'string' || !COLOR_RE.test(t.color)) return bad(`bad color for ${t.id}`);
      }
      // a team's playtime can count with another team that has a series of its own (not with one that's itself counted elsewhere)
      const ownSeries = (id) => { const t = rows.find((x) => x.id === id); return !!t && t.activity !== false && !t.activity_with; };
      rows.forEach((t, i) => {
        const name = text(t.name, 40) || t.id[0].toUpperCase() + t.id.slice(1);
        const withTeam = typeof t.activity_with === 'string' && t.activity_with !== t.id && ownSeries(t.activity_with) ? t.activity_with : null;
        stmts.push(db.prepare(
          `INSERT INTO teams (season, id, name, short, color, sort, show_bar, show_chart, show_activity, activity_with)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT(season, id) DO UPDATE SET name = excluded.name, short = excluded.short,
             color_dark = CASE WHEN teams.color = excluded.color THEN teams.color_dark ELSE NULL END, color = excluded.color,
             sort = excluded.sort, show_bar = excluded.show_bar, show_chart = excluded.show_chart,
             show_activity = excluded.show_activity, activity_with = excluded.activity_with`
        ).bind(season.n, t.id, name, text(t.short, 16) || name.split(/\s+/)[0].slice(0, 16), t.color.toLowerCase(), i,
          t.bar === false ? 0 : t.middle === true ? 2 : 1, t.chart === false ? 0 : 1, withTeam || t.activity === false ? 0 : 1, withTeam));
      });
      for (const { id } of haveTeams.results) {
        if (ids.has(id)) continue;
        const on = roster.filter((r) => r.team === id).length;
        if (on) return bad(`${on} player${on === 1 ? ' is' : 's are'} still on ${id}; move them first`);
        stmts.push(db.prepare('DELETE FROM teams WHERE season = ? AND id = ?').bind(season.n, id));
      }
    }

    if (b.history !== undefined) {
      const rows = list(b.history, MAX_PERIODS);
      if (!rows) return bad('bad team history');
      const seen = new Set();
      stmts.push(db.prepare('DELETE FROM team_history WHERE season = ?').bind(season.n));
      for (const h of rows) {
        const name = ign(h.ign);
        if (!name) return bad('bad IGN in the team history');
        if (h.team !== '' && (typeof h.team !== 'string' || !TEAM_RE.test(h.team))) return bad(`bad earlier team for ${name}`);
        if (!Number.isSafeInteger(h.until) || h.until <= 0 || h.until > 4102444800) return bad(`bad time for ${name}’s earlier team`);
        const key = `${lower(name)}:${h.until}`;
        if (seen.has(key)) return bad(`two of ${name}’s earlier teams end at the same time`);
        seen.add(key);
        stmts.push(db.prepare('INSERT INTO team_history (season, ign, until, team) VALUES (?, ?, ?, ?)').bind(season.n, name, h.until, h.team));
      }
    }

    if (b.hidden !== undefined) {
      const rows = list(b.hidden, MAX_ROSTER);
      if (!rows) return bad('bad hidden players');
      const seen = new Set();
      for (const h of rows) {
        const name = ign(h.name);
        if (!name) return bad('bad name among the hidden players');
        seen.add(lower(name));
        const note = typeof h.note === 'string' ? h.note.trim().slice(0, 200) || null : null;
        stmts.push(db.prepare('INSERT INTO hidden_players (name, note) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET note = excluded.note').bind(name, note));
      }
      for (const h of haveHidden.results) {
        if (!seen.has(lower(h.name))) stmts.push(db.prepare('DELETE FROM hidden_players WHERE name = ?').bind(h.name));
      }
    }

    if (b.aliases !== undefined) {
      const rows = list(b.aliases, MAX_ROSTER);
      if (!rows) return bad('bad merged accounts');
      const pairs = [];
      for (const a of rows) {
        const alias = ign(a.alias), name = ign(a.name);
        if (!alias || !name) return bad('bad name among the merged accounts');
        if (lower(alias) === lower(name)) return bad('an account can’t be its own alias');
        if (pairs.some((p) => lower(p.alias) === lower(alias))) return bad(`${alias} is merged twice`);
        pairs.push({ alias, name });
      }
      const others = new Set(pairs.map((p) => lower(p.alias)));
      const chained = pairs.find((p) => others.has(lower(p.name)));
      if (chained) return bad(`${chained.name} is itself merged into another account; merge ${chained.alias} into the main one`);
      for (const p of pairs) {
        stmts.push(db.prepare('INSERT INTO player_aliases (alias, name) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET name = excluded.name').bind(p.alias, p.name));
      }
      for (const a of haveAliases.results) {
        if (!others.has(lower(a.alias))) stmts.push(db.prepare('DELETE FROM player_aliases WHERE alias = ?').bind(a.alias));
      }
    }

    if (stmts.length) await db.batch(stmts);
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
  // credit a death to a player (it then counts as their kill), or to no one with killer: null
  async 'death.attribute'(db, b) {
    const id = chatId(b.id);
    if (!id) return bad('bad id');
    const killer = b.killer == null || b.killer === '' ? null : b.killer;
    if (killer !== null && (typeof killer !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(killer))) return bad('bad name');
    const d = await db.prepare('SELECT victim FROM deaths WHERE id = ?').bind(id).first();
    if (!d) return bad('not a death');
    if (killer && killer.toLowerCase() === d.victim.toLowerCase()) return bad('they can’t be credited with their own death');
    await db.prepare(
      `UPDATE deaths SET killer = ?2,
              killer_uuid = (SELECT uuid FROM players WHERE name = ?2 COLLATE NOCASE ORDER BY first_seen DESC LIMIT 1),
              mob = CASE WHEN ?2 IS NULL THEN mob ELSE NULL END
       WHERE id = ?1`
    ).bind(id, killer).run();
    return json({ ok: true, killer, victim: d.victim });
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
    if (raw.length > MAX_CONFIG_BODY) return json({ error: 'too large' }, 413);
    body = JSON.parse(raw);
    if (raw.length > MAX_BODY && body?.action !== 'config.save') return json({ error: 'too large' }, 413);
  } catch {
    return bad('bad json');
  }
  const run = body && Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
  if (!run) return bad('unknown action');
  if (body.action === 'config.save' && !season.n) return bad('pick a season');
  const out = (await run(env.DB, body, season, env)) || json({ ok: true });
  if (out.ok) await clearCache(env.DB); // season totals may have changed
  if (out.ok && body.action === 'config.save' && (body.hidden !== undefined || body.aliases !== undefined)) await tellPresence(env, '/invalidate'); // the live badges
  return out;
}
