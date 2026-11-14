// Turns roster-s<n>.json ({ "red": { "IGN": { "name": "Real name", "egg": "gravity", "email": "…" }, … }, "blue": { … } };
// a plain "Real name" works too, for a player without an egg yet) into SQL that replaces
// that season's roster: node scripts/roster-sql.mjs 2 > .wrangler/roster.sql
// "email" (one, or a list) is who may send chat from the dashboard as that player: the email they
// sign in with. Emails are never shown on the dashboard.
// "admins": ["email", …] (beside the teams) may send chat too, shown with a yellow Admin tag instead of a name.
import { readFileSync } from 'node:fs';

const season = Number(process.argv[2] || 2);
if (!Number.isInteger(season) || season < 1) throw new Error('usage: roster-sql.mjs <season>');
const teams = JSON.parse(readFileSync(new URL(`../roster-s${season}.json`, import.meta.url), 'utf8'));

const IGN_RE = /^[A-Za-z0-9_]{1,32}$/;
const TEAM_RE = /^[a-z][a-z0-9-]{0,19}$/;
const EGG_RE = /^[a-z][a-z0-9_]{0,23}$/;
const EMAIL_RE = /^[^\s@'"]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const rows = [];
const emails = new Map();
const ADMIN = '@admin'; // stands in for the IGN of an admin's email (no IGN can contain @)
const addEmail = (e, ign, who) => {
  if (typeof e !== 'string' || !EMAIL_RE.test(e.trim())) throw new Error(`bad email for ${who}`);
  const key = e.trim().toLowerCase();
  if (emails.has(key)) throw new Error(`${who} and ${emails.get(key)} have the same email`);
  emails.set(key, ign);
};
const { admins = [], ...teamsOnly } = teams;
for (const e of [admins].flat()) addEmail(e, ADMIN, 'an admin');
for (const [team, members] of Object.entries(teamsOnly)) {
  if (!TEAM_RE.test(team)) throw new Error(`bad team name: ${team}`);
  for (const [ign, v] of Object.entries(members)) {
    if (!IGN_RE.test(ign)) throw new Error(`bad IGN: ${ign}`);
    const { name, egg = null, email = [] } = typeof v === 'string' ? { name: v } : v || {};
    if (typeof name !== 'string' || !name.trim()) throw new Error(`no name for ${ign}`);
    if (egg != null && !EGG_RE.test(egg)) throw new Error(`bad egg for ${ign}: ${egg}`);
    for (const e of [email].flat()) addEmail(e, ign, ign);
    rows.push(`(${season}, ${q(ign)}, ${q(name.trim().slice(0, 40))}, ${q(team)}, ${egg == null ? 'NULL' : q(egg)})`);
  }
}
console.log(`DELETE FROM roster WHERE season = ${season};`);
if (rows.length) console.log(`INSERT INTO roster (season, ign, name, team, egg) VALUES\n${rows.join(',\n')};`);
console.log(`DELETE FROM roster_email WHERE season = ${season};`);
if (emails.size) console.log(`INSERT INTO roster_email (season, email, ign) VALUES\n${[...emails].map(([e, ign]) => `(${season}, ${q(e)}, ${q(ign)})`).join(',\n')};`);
console.error(`season ${season}: ${rows.length} players, ${emails.size} emails`);
