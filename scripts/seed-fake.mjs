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
const out = ['DELETE FROM snapshots;', 'DELETE FROM hourly;', 'DELETE FROM sessions;', 'DELETE FROM players;'];

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

console.log(out.join('\n'));
