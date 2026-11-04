'use strict';

// Made-up activity for /?dummydata, to see the page full before the season has real data.
// It answers the same /api/* requests the server does, all worked out from one set of generated
// sessions, so the charts, leaderboard, player pages and cards agree with each other. The chat log
// is left empty on purpose.
//
// The season "began" SEASON_DAYS ago with a launch event, and follows a school-week rhythm:
// short after-school sessions, busier evenings, Friday and Saturday faction-war nights,
// late nights only for a few. Each player has a habit (grinder, regular, casual, rare) and a usual
// time of day; casual players drift off as the novelty wears off, and a couple joined late.
// The same day always generates the same data, so live refreshes and reloads stay consistent.

window.createDummyApi = function createDummyApi({ roster = [], tz = 'America/Los_Angeles' } = {}) {
  const POLL = 60;
  const DAY = 86400;
  const SEASON_DAYS = 18;
  const SESSION_GAP = 210; // the server merges sightings this close together into one session
  const SLOTS = 30;

  /* ---------- time in the dashboard's zone ---------- */

  const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  function local(ts) {
    const p = {};
    for (const { type, value } of fmt.formatToParts(ts * 1000)) p[type] = value;
    return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour % 24, minute: +p.minute, dow: DOWS.indexOf(p.weekday), date: `${p.year}-${p.month}-${p.day}` };
  }
  const offset = (ts) => {
    const p = local(ts);
    return Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute) / 1000 - Math.floor(ts / 60) * 60;
  };
  // The time `hours` (may be fractional, or past 24) after local midnight of `date`.
  const at = (date, hours) => {
    const [y, m, d] = date.split('-').map(Number);
    const want = Date.UTC(y, m - 1, d) / 1000 + hours * 3600;
    return want - offset(want - offset(want));
  };
  const addDays = (date, n) => {
    const t = new Date(`${date}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  const minute = (t) => Math.floor(t / 60) * 60;
  const nowMin = () => minute(Date.now() / 1000);

  /* ---------- seeded randomness ---------- */

  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  };
  const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const today = local(Date.now() / 1000).date;
  const startDate = addDays(today, -SEASON_DAYS);
  const rand = rng(hash(`season:${startDate}`));
  const chance = (p) => rand() < p;
  const between = (a, b) => a + rand() * (b - a);
  const normal = (mean, sd) => mean + sd * Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  // session lengths: mostly near the typical length, now and then much longer
  const length = (mins) => Math.max(8, mins * Math.exp(normal(-0.1, 0.5))) * 60;

  /* ---------- who plays ---------- */

  const FALLBACK = [
    ['BuilderBee', 'red'], ['xXCreeperXx', 'blue'], ['redstone_rae', 'red'], ['Pickaxe_Pat', 'blue'], ['Notch_Fan99', 'red'],
    ['LlamaDrama', 'blue'], ['EnderEli', 'red'], ['Mossy', 'blue'], ['GlowSquid42', 'red'], ['NetherNate', 'blue'],
  ].map(([ign, team]) => ({ ign, team }));
  const list = roster.length ? roster : FALLBACK;

  const HABITS = {
    grinder: { play: 0.88, mins: 165, solo: 0.55, fade: 0.05 },
    regular: { play: 0.6, mins: 95, solo: 0.3, fade: 0.15 },
    casual: { play: 0.32, mins: 55, solo: 0.15, fade: 0.45 },
    rare: { play: 0.18, mins: 40, solo: 0.08, fade: 0.5 },
  };
  // About 15% grinders, 40% regulars, 30% casual and 15% rare, in a shuffled order.
  const order = list.map((p, i) => [rand(), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  const habitAt = (rank) => {
    const f = rank / list.length;
    return f < 0.15 ? 'grinder' : f < 0.55 ? 'regular' : f < 0.85 ? 'casual' : 'rare';
  };

  const uuidFor = (ign) => {
    const r = rng(hash(`uuid:${ign.toLowerCase()}`));
    const hex = (n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
    return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(r() * 4)]}${hex(3)}-${hex(12)}`;
  };

  const people = list.map((p, i) => {
    const habit = habitAt(order.indexOf(i));
    return {
      uuid: uuidFor(p.ign),
      name: p.ign,
      habit,
      ...HABITS[habit],
      evening: Math.min(21.5, Math.max(17.5, normal(19.4, 1))), // when they usually log on at night
      afterSchool: chance(0.5), // hops on right after school
      lateNights: habit === 'grinder' || chance(0.1),
      // a couple of non-grinders only found the server a few days in
      joinDay: habit !== 'grinder' && chance(0.12) ? 2 + Math.floor(rand() * 5) : 0,
      sessions: [],
    };
  });

  /* ---------- the season ---------- */

  const seasonStart = minute(at(startDate, 16)); // launch day, 4 PM
  const horizon = nowMin() + 4 * 3600; // planned a little past now, so sessions in progress keep going

  // Group times each day: when friends tend to be on together.
  function hangouts(d, dow) {
    if (d === 0) return [{ at: 16, pull: 1.15, len: 1.9 }]; // launch: nearly everyone, for a long time
    const out = [];
    if (dow >= 1 && dow <= 5) out.push({ at: 15.6, pull: 0.4, len: 0.7, afterSchool: true });
    if (dow === 5 || dow === 6) out.push({ at: dow === 5 ? 20 : 20.5, pull: 1, len: 1.35 }); // faction-war night
    else if (dow === 0) out.push({ at: 18.5, pull: 0.55, len: 0.8 }); // school tomorrow
    else out.push({ at: normal(19.6, 0.5), pull: 0.75, len: 1 });
    if (dow === 0 || dow === 6) out.push({ at: between(12, 14), pull: 0.55, len: 1 });
    return out;
  }

  for (let d = 0; d <= SEASON_DAYS; d++) {
    const date = addDays(startDate, d);
    const dow = local(at(date, 12)).dow;
    const weekend = dow === 0 || dow === 6;
    const lateOk = dow === 5 || dow === 6; // no school tomorrow
    const groups = hangouts(d, dow);
    for (const p of people) {
      if (d < p.joinDay) continue;
      const mood = Math.max(0.3, normal(1, 0.2));
      const keen = p.play * (1 - p.fade * (d / SEASON_DAYS)) * (weekend ? 1.2 : 1) * mood;
      // latest they'll stay on: lights out on school nights, later on weekends
      const curfew = lateOk ? (p.lateNights ? 26 : 24.5) : (p.lateNights && chance(0.3) ? 24.5 : 22.75);
      const add = (startH, secs) => {
        const s = at(date, startH);
        const e = Math.min(s + secs, at(date, curfew + normal(0, 0.2)));
        if (e - s >= 5 * 60) p.sessions.push([s, e]);
      };
      for (const g of groups) {
        if (g.afterSchool && !p.afterSchool) continue;
        // launch day: almost everyone shows up
        if (!chance(d === 0 ? 0.9 : Math.min(0.97, keen * g.pull))) continue;
        add(Math.max(g.at - 0.5, g.at + normal(0.2, 0.4)), length(p.mins * g.len));
      }
      if (chance(keen * p.solo * 0.6)) {
        add(weekend ? between(10, 22.5) : between(15.5, Math.min(22, p.evening + 1.5)), length(p.mins * 0.7));
      }
      if (lateOk && p.lateNights && chance(0.35)) add(between(22.3, 23.6), length(110));
    }
  }

  // Now and then a long session is really two: a crash, or dinner.
  for (const p of people) {
    const split = [];
    for (const [s, e] of p.sessions) {
      if (e - s > 90 * 60 && chance(0.2)) {
        const cut = between(s + 30 * 60, e - 30 * 60);
        const gap = between(5, 20) * 60;
        split.push([s, cut], [cut + gap, e]);
      } else split.push([s, e]);
    }
    p.sessions = split;
  }

  // The server restarts at 4 AM every night, down for two minutes.
  const down = new Set();
  for (let d = 1; d <= SEASON_DAYS + 1; d++) {
    const t = minute(at(addDays(startDate, d), 4));
    down.add(t).add(t + 60);
  }

  // Sightings are once a minute, merged into sessions the way the server does.
  function settle(p) {
    const minuteSpans = p.sessions
      .map(([s, e]) => [Math.max(seasonStart, Math.ceil(s / 60) * 60), Math.min(horizon, minute(e))])
      .filter(([s, e]) => e >= s)
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of minuteSpans) {
      const last = merged.at(-1);
      if (last && s <= last[1] + SESSION_GAP) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    // a restart kicks everyone off
    const out = [];
    for (const [s, e] of merged) {
      let from = s;
      for (let t = s; t <= e; t += 60) {
        if (!down.has(t)) continue;
        if (t - 60 >= from) out.push([from, t - 60]);
        from = t + 60;
      }
      if (e >= from) out.push([from, e]);
    }
    p.sessions = out.map(([s, e]) => ({ s, e }));
  }
  people.forEach(settle);

  // So the page has someone to show, a few people are always on right now.
  const nowAtStart = nowMin();
  const onNow = () => people.filter((p) => p.sessions.some((x) => x.s <= nowAtStart && x.e >= nowAtStart));
  if (onNow().length < 2) {
    const keenest = people.filter((p) => !onNow().includes(p))
      .map((p) => [p.play + rand() * 0.4, p]).sort((a, b) => b[0] - a[0]).map(([, p]) => p);
    for (const p of keenest.slice(0, 2 + Math.floor(rand() * 3))) {
      p.sessions = p.sessions.map(({ s, e }) => [s, e]);
      p.sessions.push([nowAtStart - between(8, 75) * 60, nowAtStart + between(25, 140) * 60]);
      settle(p);
    }
  }

  const all = people.flatMap((p) => p.sessions.map((x) => ({ p, s: x.s, e: x.e }))).sort((a, b) => a.s - b.s);
  const byUuid = new Map(people.map((p) => [p.uuid, p]));

  // players online each minute
  const counts = new Uint8Array((horizon - seasonStart) / 60 + 1);
  for (const { s, e } of all) for (let t = s; t <= e; t += 60) counts[(t - seasonStart) / 60]++;
  const countAt = (t) => (down.has(t) ? 0 : counts[(t - seasonStart) / 60] || 0);

  /* ---------- answering requests ---------- */

  // A session as of now: not started yet (null), in progress (ends now), or over.
  const asOfNow = (x, now) => (x.s > now ? null : [x.s, Math.min(x.e, now)]);

  function range(q, defaultDays, maxDays) {
    const now = Math.floor(Date.now() / 1000);
    const to = Number(q.get('to')) || now;
    let from = Number(q.get('from')) || to - defaultDays * DAY;
    if (maxDays && to - from > maxDays * DAY) from = to - maxDays * DAY;
    return [Math.floor(from), Math.floor(to)];
  }

  const hourCache = new Map();
  function hourRow(h, now) {
    if (hourCache.has(h)) return hourCache.get(h);
    let samples = 0, up = 0, sum = 0, peak = 0;
    for (let t = Math.max(h, seasonStart); t < h + 3600 && t <= now; t += 60) {
      const n = countAt(t);
      samples++;
      up += down.has(t) ? 0 : 1;
      sum += n;
      peak = Math.max(peak, n);
    }
    const row = [h, samples, up, sum, peak];
    if (h + 3600 <= now) hourCache.set(h, row); // a finished hour doesn't change
    return row;
  }

  const notFound = (path) => { throw new Error(`${path} → 404`); };

  const routes = {
    '/api/status': (q, now) => {
      const online = all.filter((x) => x.s <= now && x.e >= now).map((x) => ({ uuid: x.p.uuid, name: x.p.name, start_ts: x.s }));
      let peak = 0;
      for (let i = 0, end = (now - seasonStart) / 60; i <= end; i++) peak = Math.max(peak, counts[i]);
      return {
        tz,
        poll_seconds: POLL,
        now,
        last: { ts: now, up: down.has(now) ? 0 : 1, online: countAt(now), max: SLOTS, listed: countAt(now) },
        online: down.has(now) ? [] : online,
        players_total: people.filter((p) => p.sessions.some((x) => x.s <= now)).length,
        data_start: seasonStart,
        peak_ever: peak,
        server_event: null,
        season: { n: 2, started: true, ended: false, start: seasonStart, end: null },
      };
    },

    '/api/leaderboard': (q, now) => {
      const [from, to] = range(q, 36500);
      const rows = [];
      for (const p of people) {
        let secs = 0, sessions = 0, lastSeen = 0, first = null;
        for (const x of p.sessions) {
          const v = asOfNow(x, now);
          if (!v) continue;
          first ??= v[0];
          if (v[1] + POLL <= from || v[0] >= to) continue;
          secs += Math.min(v[1] + POLL, to) - Math.max(v[0], from);
          sessions++;
          lastSeen = Math.max(lastSeen, v[1]);
        }
        if (sessions) rows.push({ uuid: p.uuid, name: p.name, first_seen: first, secs, sessions, last_seen: lastSeen });
      }
      return { from, to, players: rows.sort((a, b) => b.secs - a.secs) };
    },

    '/api/snapshots': (q, now) => {
      const [from, to] = range(q, 1, 8);
      const rows = [];
      for (let t = Math.max(Math.ceil(from / 60) * 60, seasonStart); t <= Math.min(to, now); t += 60) {
        rows.push([t, down.has(t) ? 0 : 1, countAt(t)]);
      }
      return { from, to, cols: ['ts', 'up', 'online'], rows };
    },

    '/api/hourly': (q, now) => {
      const [from, to] = range(q, 371, 800);
      const rows = [];
      const first = Math.floor(seasonStart / 3600) * 3600;
      for (let h = Math.max(Math.ceil(from / 3600) * 3600, first); h <= Math.min(to, now); h += 3600) rows.push(hourRow(h, now));
      return { from, to, cols: ['hour_ts', 'samples', 'up_samples', 'online_sum', 'peak'], rows };
    },

    '/api/sessions': (q, now) => {
      const [from, to] = range(q, 1, 120);
      const rows = [];
      for (const x of all) {
        const v = asOfNow(x, now);
        if (v && v[1] + POLL > from && v[0] < to) rows.push([x.p.uuid, x.p.name, v[0], v[1]]);
      }
      return { from, to, poll_seconds: POLL, cols: ['uuid', 'name', 'start_ts', 'end_ts'], rows };
    },

    // The chat log stays empty.
    '/api/chat': () => ({ messages: [], more_before: false, more_after: false, max_id: 0, unread: 0 }),
    '/api/chat/search': () => ({ results: [], more: false }),
    '/api/chat/players': (q, now) => ({
      players: people.filter((p) => p.sessions.some((x) => x.s <= now)).map((p) => ({ uuid: p.uuid, name: p.name, n: 0 })),
    }),
    '/api/chat/player': (q, now, path) => {
      const want = q.get('uuid')?.toLowerCase();
      const name = q.get('name')?.toLowerCase();
      const p = people.find((x) => (want ? x.uuid === want : x.name.toLowerCase() === name));
      if (!p) notFound(path);
      return { uuid: p.uuid, name: p.name, display: null, total: 0, today: 0, data_start: null, ...(q.get('events') === '1' && { events: [] }) };
    },
  };

  return async function dummyApi(path) {
    const url = new URL(path, location.origin);
    const now = nowMin();
    const m = url.pathname.match(/^\/api\/player\/([^/]+)$/);
    if (m) {
      const p = byUuid.get(decodeURIComponent(m[1]).toLowerCase());
      if (!p) notFound(path);
      const sessions = p.sessions.map((x) => asOfNow(x, now)).filter(Boolean);
      return { player: { uuid: p.uuid, name: p.name, first_seen: sessions[0]?.[0] ?? null }, poll_seconds: POLL, sessions };
    }
    const handler = routes[url.pathname];
    if (!handler) notFound(path);
    return handler(url.searchParams, now, path);
  };
};
