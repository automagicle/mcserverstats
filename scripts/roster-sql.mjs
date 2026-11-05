// Turns roster-s<n>.json ({ "red": { "IGN": "Real name", … }, "blue": { … } }) into SQL that replaces
// that season's roster: node scripts/roster-sql.mjs 2 > .wrangler/roster.sql
import { readFileSync } from 'node:fs';

const season = Number(process.argv[2] || 2);
if (!Number.isInteger(season) || season < 1) throw new Error('usage: roster-sql.mjs <season>');
const teams = JSON.parse(readFileSync(new URL(`../roster-s${season}.json`, import.meta.url), 'utf8'));

const IGN_RE = /^[A-Za-z0-9_]{1,32}$/;
const TEAM_RE = /^[a-z][a-z0-9-]{0,19}$/;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const rows = [];
for (const [team, members] of Object.entries(teams)) {
  if (!TEAM_RE.test(team)) throw new Error(`bad team name: ${team}`);
  for (const [ign, name] of Object.entries(members)) {
    if (!IGN_RE.test(ign)) throw new Error(`bad IGN: ${ign}`);
    if (typeof name !== 'string' || !name.trim()) throw new Error(`no name for ${ign}`);
    rows.push(`(${season}, ${q(ign)}, ${q(name.trim().slice(0, 40))}, ${q(team)})`);
  }
}
console.log(`DELETE FROM roster WHERE season = ${season};`);
if (rows.length) console.log(`INSERT INTO roster (season, ign, name, team) VALUES\n${rows.join(',\n')};`);
console.error(`season ${season}: ${rows.length} players`);
