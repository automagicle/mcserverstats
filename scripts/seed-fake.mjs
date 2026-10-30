// Generates ~200 days of fake activity as SQL, for trying the UI locally.
// Usage: npm run seed:local   (local database only)
import { randomUUID } from 'node:crypto';

const DAYS = 200;
const POLL = 60;
const now = Math.floor(Date.now() / 1000 / POLL) * POLL;
const start = now - DAYS * 86400;

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

// name, chance of playing on a given day, favourite local (Pacific) hour, avg session minutes
const people = [
  ['Notch_Fan99', 0.7, 19, 150], ['xXCreeperXx', 0.5, 21, 90], ['BuilderBee', 0.6, 16, 200],
  ['redstone_rae', 0.35, 22, 120], ['Mossy', 0.25, 13, 60], ['Pickaxe_Pat', 0.45, 20, 80],
  ['LlamaDrama', 0.15, 10, 45], ['EnderEli', 0.3, 23, 110],
].map(([name, p, hour, mins]) => ({ uuid: randomUUID(), name, p, hour, mins }));

const PT_OFFSET = 7 * 3600; // close enough for fake data
const counts = new Map(); // minute ts -> online count
const out = ['DELETE FROM snapshots;', 'DELETE FROM hourly;', 'DELETE FROM sessions;', 'DELETE FROM players;', 'DELETE FROM chat;'];
const allSessions = []; // [person, start, end]

for (const person of people) {
  let first = null;
  for (let d = 0; d < DAYS; d++) {
    const dayStart = start - ((start - PT_OFFSET) % 86400) + d * 86400;
    const weekend = new Date((dayStart - PT_OFFSET) * 1000).getUTCDay() % 6 === 0;
    const trend = 0.5 + d / DAYS; // the server gets busier over time
    if (rand() > person.p * trend * (weekend ? 1.3 : 1)) continue;
    const sessionsToday = rand() < 0.3 ? 2 : 1;
    for (let k = 0; k < sessionsToday; k++) {
      const hour = (person.hour + Math.round((rand() - 0.5) * 6) + k * 3 + 24) % 24;
      const s = Math.floor((dayStart + hour * 3600 + rand() * 3600) / POLL) * POLL;
      const len = Math.max(5, Math.round(person.mins * (0.3 + rand() * 1.4))) * 60;
      const e = Math.min(now, s + len);
      if (s >= now) continue;
      first ??= s;
      out.push(`INSERT INTO sessions (uuid, start_ts, end_ts) VALUES ('${person.uuid}', ${s}, ${e});`);
      for (let t = s; t <= e; t += POLL) counts.set(t, (counts.get(t) || 0) + 1);
      allSessions.push([person, s, e]);
    }
  }
  if (first) out.push(`INSERT INTO players (uuid, name, first_seen) VALUES ('${person.uuid}', '${person.name}', ${first});`);
}

const hourly = new Map();
const snapRows = [];
for (let t = start; t <= now; t += POLL) {
  const down = rand() < 0.002;
  const n = down ? 0 : counts.get(t) || 0;
  const h = Math.floor(t / 3600) * 3600;
  const a = hourly.get(h) || [0, 0, 0, 0];
  a[0]++; a[1] += down ? 0 : 1; a[2] += n; a[3] = Math.max(a[3], n);
  hourly.set(h, a);
  if (t >= now - 8 * 86400) snapRows.push(`(${t}, ${down ? 0 : 1}, ${n}, 20, ${n})`);
}
for (let i = 0; i < snapRows.length; i += 500) {
  out.push(`INSERT INTO snapshots (ts, up, online, max, listed) VALUES ${snapRows.slice(i, i + 500).join(',')};`);
}
const hourRows = [...hourly].map(([h, a]) => `(${h}, ${a.join(', ')})`);
for (let i = 0; i < hourRows.length; i += 500) {
  out.push(`INSERT INTO hourly (hour_ts, samples, up_samples, online_sum, peak) VALUES ${hourRows.slice(i, i + 500).join(',')};`);
}

// Chat for the last two weeks: joins and leaves at session edges, chatter while people are on.
const LINES = [
  'hey all', 'anyone want to go to the nether?', 'brb', 'back', 'lol', 'nice', 'where is everyone',
  'found diamonds!!', 'who took my pickaxe', 'gg', 'creeper blew up my house again', 'on my way',
  'can someone help me with the farm', 'what are we building today', 'i need iron', 'coords?',
  'the villagers are breeding finally', 'night night', 'skip the night pls', 'sleep pls',
  'check out the new bridge at spawn', 'anyone have spare wool?', 'that was close', 'haha',
  'ok heading to the end portal', 'trading hall is done', 'there is a witch hut near the swamp',
  'who wants to raid an ocean monument later', 'my elytra broke', 'thanks!', 'np',
];
const DEATHS = ['was slain by Zombie', 'was blown up by Creeper', 'fell from a high place', 'drowned',
  'tried to swim in lava', 'was shot by Skeleton', 'hit the ground too hard'];
const ADV = ['has made the advancement [Diamonds!]', 'has made the advancement [We Need to Go Deeper]',
  'has made the advancement [Monster Hunter]', 'has completed the challenge [Return to Sender]'];
// Names as chat shows them, for players on a team (prefix and colors).
const DISPLAY = {
  Notch_Fan99: [{ t: '[Admin] ', c: '#ff5555' }, { t: 'Notch_Fan99', c: '#ffaa00' }],
  BuilderBee: [{ t: 'BuilderBee', c: '#55ffff' }],
  redstone_rae: [{ t: '[VIP] ', c: '#55ff55' }, { t: 'redstone_rae', c: '#ffff55' }],
  EnderEli: [{ t: 'EnderEli', c: '#ffffff' }],
  Mossy: [{ t: 'Mossy', c: '#0000aa' }],
};
const shown = (p) => (DISPLAY[p.name] ? DISPLAY[p.name].map((x) => x.t).join('') : p.name);
const chat = [];
let n = 0;
const sql = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const msg = (ts, kind, p, text) => chat.push([ts, (id) => `('seed-${id}', ${ts}, '${kind}', ${sql(p?.uuid)}, ${sql(p?.name)}, ${sql(text)}, ${sql(p && DISPLAY[p.name] ? JSON.stringify(DISPLAY[p.name]) : null)})`]);
const chatFrom = now - 14 * 86400;
for (const [p, s, e] of allSessions) {
  if (e < chatFrom) continue;
  msg(s * 1000 + Math.floor(rand() * 20000), 'join', p, `${shown(p)} joined the game`);
  for (let t = s + 30 + rand() * 600; t < e; t += 60 + rand() * 900) {
    const r = rand();
    const ms = Math.floor(t * 1000);
    if (r < 0.06) msg(ms, 'death', p, `${shown(p)} ${DEATHS[Math.floor(rand() * DEATHS.length)]}`);
    else if (r < 0.09) msg(ms, 'advancement', p, `${shown(p)} ${ADV[Math.floor(rand() * ADV.length)]}`);
    else if (r < 0.11) msg(ms, 'emote', p, `waves`);
    else {
      msg(ms, 'chat', p, LINES[Math.floor(rand() * LINES.length)]);
      if (rand() < 0.4) msg(ms + 3000 + Math.floor(rand() * 8000), 'chat', p, LINES[Math.floor(rand() * LINES.length)]);
    }
  }
  if (e < now - 120) msg(e * 1000 + 30000, 'leave', p, `${shown(p)} left the game`);
}
msg((now - 3 * 86400) * 1000, 'server', null, 'Server stopped');
msg((now - 3 * 86400 + 90) * 1000, 'server', null, 'Server started');
// stored in time order, like the mod sends them
const rows = chat.sort((a, b) => a[0] - b[0]).map(([, row]) => row(++n));
for (let i = 0; i < rows.length; i += 200) {
  out.push(`INSERT INTO chat (event_id, ts_ms, kind, uuid, name, text, display) VALUES ${rows.slice(i, i + 200).join(',')};`);
}

console.log(out.join('\n'));
