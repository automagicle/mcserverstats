// Website analytics, kept in our own database (no outside service). The page reports each view
// and, once a minute while it's open and visible, a minute on the page it shows:
//   POST /api/hit              { page, beat?, mobile? }  (any signed-in visitor)
//   GET  /api/admin/analytics  ?days=N  the Analytics tab's numbers (admins only)
// Rows are per visitor, page and UTC day, so a busy day is still only a few hundred rows.
import { json, UUID_RE } from './util.js';
import { isAdmin } from './admin.js';
import { CURRENT_SEASON } from './seasons.js';

const PAGES = new Set(['home', 'chat', 'combat', 'admin']);
const MAX_DAYS = 365;

const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

function cleanPage(v) {
  if (typeof v !== 'string') return null;
  if (PAGES.has(v)) return v;
  const m = v.match(/^player:(.+)$/);
  return m && UUID_RE.test(m[1]) ? `player:${m[1].toLowerCase()}` : null;
}

export async function recordHit(request, env, who) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const email = who?.email?.toLowerCase();
  if (!email) return json({ ok: true });
  const text = await request.text();
  if (text.length > 512) return json({ error: 'too big' }, 413);
  let b;
  try { b = JSON.parse(text); } catch { return json({ error: 'bad json' }, 400); }
  const page = cleanPage(b?.page);
  if (!page) return json({ error: 'bad page' }, 400);
  const now = Math.floor(Date.now() / 1000);
  const beat = b.beat === true;
  await env.DB.prepare(
    `INSERT INTO site_visits (day, visitor, page, views, minutes, mobile, last_ts) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (day, visitor, page) DO UPDATE SET
       views = views + excluded.views, minutes = minutes + excluded.minutes,
       mobile = max(mobile, excluded.mobile), last_ts = excluded.last_ts`
  ).bind(day(now), email, page, beat ? 0 : 1, beat ? 1 : 0, b.mobile ? 1 : 0, now).run();
  return json({ ok: true });
}

export async function analytics(env, url, who) {
  if (!isAdmin(env, who)) return json({ error: 'forbidden' }, 403);
  const days = Math.min(MAX_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const now = Math.floor(Date.now() / 1000);
  const from = day(now - (days - 1) * 86400);
  const db = env.DB;
  const [rows, firsts, names, players] = await db.batch([
    db.prepare('SELECT day, visitor, page, views, minutes, mobile, last_ts FROM site_visits WHERE day >= ?').bind(from),
    db.prepare('SELECT visitor, MIN(day) AS first FROM site_visits GROUP BY visitor'),
    db.prepare('SELECT email, ign FROM roster_email WHERE season = ?').bind(CURRENT_SEASON),
    db.prepare(`SELECT DISTINCT p.uuid, p.name FROM players p
                WHERE p.uuid IN (SELECT DISTINCT substr(page, 8) FROM site_visits WHERE day >= ? AND page LIKE 'player:%')`).bind(from),
  ]);
  const ign = Object.fromEntries(names.results.map((r) => [r.email.toLowerCase(), r.ign]));
  const visitors = {};
  for (const r of firsts.results) visitors[r.visitor] = { name: ign[r.visitor] || null, first: r.first, admin: isAdmin(env, { email: r.visitor }) };
  return json({
    days, from, today: day(now),
    rows: rows.results,
    visitors: Object.fromEntries(Object.entries(visitors).filter(([v]) => rows.results.some((r) => r.visitor === v))),
    players: Object.fromEntries(players.results.map((r) => [r.uuid, r.name])),
  });
}
