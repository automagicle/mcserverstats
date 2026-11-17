'use strict';

/* ---------- small DOM helpers ---------- */

const $ = (sel) => document.querySelector(sel);
const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
}

function sv(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// Looked up by name: servers in offline mode (or query-only player lists) report
// made-up v3 UUIDs that skin services don't know, which renders everyone as Steve.
// minotar renders current skins reliably (incl. slim/newer skins mc-heads shows as Steve).
const head = (name, size) => `https://minotar.net/helm/${encodeURIComponent(name)}/${size}`;
const headFallback = (name, size) => `https://mc-heads.net/avatar/${encodeURIComponent(name)}/${size}`;

// One-shot fallback to a second skin service if the first fails to load.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.name || img.dataset.fellBack) return;
  img.dataset.fellBack = '1';
  img.src = headFallback(img.dataset.name, img.dataset.size);
}, true);

function headImg(name, size, attrs = {}) {
  const img = el('img', { src: head(name, size), alt: '', loading: 'lazy', ...attrs });
  img.dataset.name = name;
  img.dataset.size = size;
  return img;
}

/* ---------- seasons ---------- */

// The main page shows the current season; /s1/ (and later /s2/, …) show past ones.
// A season that's over is shown as of its end: the page's clock stops there.
const CURRENT_SEASON = 2; // keep in step with src/seasons.js
const SEASON = Number(location.pathname.match(/^\/s(\d+)\//)?.[1]) || CURRENT_SEASON;
const SITE = SEASON < CURRENT_SEASON ? `Season ${SEASON} · Server Stats` : 'Server Stats';
// ?dummydata on the main page fills it with made-up activity (public/dummy.js). The chat log stays empty.
const DUMMY = SEASON === CURRENT_SEASON && new URLSearchParams(location.search).has('dummydata');
let clockStop = Infinity; // the last moment of a finished season (unix seconds)
const archived = () => clockStop !== Infinity;

/* ---------- time helpers (everything shown in the server's configured zone) ---------- */

let TZ = 'America/Los_Angeles';
let POLL = 60;
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtCache = new Map();
const hourCache = new Map();

function setTz(tz) {
  if (tz === TZ && fmtCache.size) return;
  TZ = tz;
  fmtCache.clear();
  hourCache.clear();
}

function formatter(opts) {
  const key = JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });
    fmtCache.set(key, f);
  }
  return f;
}

const fmt = (ts, opts) => formatter(opts).format(ts * 1000);

// Local date/hour/weekday for an hour. Pacific offsets are whole hours, so a UTC hour
// is also exactly one local hour.
function hourInfo(ts) {
  const h = Math.floor(ts / 3600) * 3600;
  let v = hourCache.get(h);
  if (!v) {
    const p = {};
    const f = formatter({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
    for (const { type, value } of f.formatToParts(h * 1000)) p[type] = value;
    v = { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, dow: DOWS.indexOf(p.weekday) };
    hourCache.set(h, v);
  }
  return v;
}

const nowSec = () => Math.floor(Math.min(Date.now() / 1000, clockStop));
const todayStr = () => hourInfo(nowSec()).date;

function addDays(d, n) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const dowOf = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const fmtDay = (d, opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });

function startOfTodayTs() {
  const now = nowSec();
  return Math.floor(now / 3600) * 3600 - hourInfo(now).hour * 3600;
}

function hourName(h, short) {
  const ap = h < 12 ? (short ? 'a' : ' AM') : (short ? 'p' : ' PM');
  return `${h % 12 || 12}${ap}`;
}

function dur(secs) {
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h >= 100) return `${h.toLocaleString()}h`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function ago(ts) {
  if (archived()) return fmt(ts, { month: 'short', day: 'numeric', year: 'numeric' }); // "3h ago" means little once it's over
  const s = nowSec() - ts;
  if (s < 150) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return fmt(ts, { month: 'short', day: 'numeric', year: 'numeric' });
}

const fmtHours = (h) => (h >= 100 ? Math.round(h).toLocaleString() : h >= 10 ? h.toFixed(0) : h.toFixed(1));

// Split [start, end) into pieces that each fall inside one hour.
function eachHourChunk(start, end, fn) {
  let t = start;
  while (t < end) {
    const h = Math.floor(t / 3600) * 3600;
    const e = Math.min(end, h + 3600);
    fn(h, e - t);
    t = e;
  }
}

/* ---------- API ---------- */

class AuthError extends Error {}

// Every request is for this page's season.
async function api(path) {
  if (DUMMY && !path.startsWith('/api/roster')) return (await dummyApi())(path);
  const url = `${path}${path.includes('?') ? '&' : '?'}season=${SEASON}`;
  const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (res.status === 401) throw new AuthError('unauthorized');
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

// The sample data's generator, loaded only when it's asked for. It answers the same requests the server would.
let dummy = null;
function dummyApi() {
  dummy ??= new Promise((resolve, reject) => {
    const script = el('script', { src: '/dummy.js' });
    script.onload = () => rosterLoad.then((players) => resolve(window.createDummyApi({ roster: players, tz: TZ, eggIds: EGG_BY_ID })));
    script.onerror = () => reject(new Error('couldn’t load the sample data'));
    document.head.append(script);
  });
  return dummy;
}

/* ---------- teams and real names ---------- */

// The season's teams, from the server (its roster table, so real names stay out of the repository).
const roster = new Map(); // lowercased IGN -> { ign, name, team }
const rosterAliases = new Map(); // another account's lowercased name -> its player's lowercased IGN
const TEAM_NAMES = { red: 'Red Faction', blue: 'Blue Faction' };
let nameMode = recall('nameMode') === 'real' ? 'real' : 'ign'; // what the IGN / Name switch shows
const rosterLoad = api('/api/roster').then((r) => {
  for (const a of r.aliases || []) rosterAliases.set(a.alias.toLowerCase(), a.name.toLowerCase());
  return r.players;
}, () => []).then((players) => {
  for (const p of players) roster.set(p.ign.toLowerCase(), p);
  syncNameToggle();
  syncHeatToggle();
  return players;
});

const rosterOf = (ign) => (ign ? roster.get(ign.toLowerCase()) ?? roster.get(rosterAliases.get(ign.toLowerCase())) : null);
const realName = (ign) => rosterOf(ign)?.name ?? null;
const shownName = (ign) => (nameMode === 'real' && realName(ign)) || ign;
// the name that isn't shown, for hovering
const otherName = (ign) => (realName(ign) ? (nameMode === 'real' ? ign : realName(ign)) : null);

// A styled name ([{ t, c }] pieces, as chat shows it) with the IGN swapped for the real name when that's shown.
// The game puts a [RED] / [BLUE] team tag before each name; the name's color already says it.
const TEAM_TAG = /\[(?:RED|BLUE)\]\s*/g;
const noTag = (t) => t.replace(TEAM_TAG, '');
function swapParts(parts, ign) {
  const real = nameMode === 'real' && ign && realName(ign);
  return parts
    .map((p) => ({ ...p, t: real && p.t.includes(ign) ? noTag(p.t).replace(ign, real) : noTag(p.t) }))
    .filter((p) => p.t);
}

// Colors a name by team, with the other name on hover.
function teamName(node, ign) {
  const r = rosterOf(ign);
  if (r) node.classList.add('team', `team-${r.team}`);
  const other = otherName(ign);
  if (other) node.title = other;
  return node;
}

function syncNameToggle() {
  const t = $('#name-toggle');
  t.hidden = !roster.size;
  for (const b of t.children) b.setAttribute('aria-pressed', String(b.dataset.v === nameMode));
}
$('#name-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === nameMode) return;
  nameMode = b.dataset.v;
  remember('nameMode', nameMode);
  syncNameToggle();
  rerenderNames();
});

/* ---------- eggs and gear ---------- */

// Egg SMP's eggs (from the egg datapack): name, color, and the game item each one is drawn as.
const EGGS = {
  life: ['Life Egg', '#FF4F8B', 'sniffer_egg'],
  hunger: ['Harvest Egg', '#D6E35A', 'turtle_egg'],
  sky: ['Skyblocker Egg', '#7DD3FC', 'vex_spawn_egg'],
  gravity: ['Gravity Egg', '#9BC9FF', 'breeze_spawn_egg'],
  gambler: ['Gambler Egg', '#FFE56A', 'piglin_spawn_egg'],
  fire: ['Fire Egg', '#FF7A2E', 'blaze_spawn_egg'],
  blood: ['Blood Egg', '#C41818', 'magma_cube_spawn_egg'],
  echo: ['Echo Egg', '#2DD4BF', 'warden_spawn_egg'],
  aqua: ['Aqua Egg', '#3DDCFF', 'tropical_fish_spawn_egg'],
  meteor: ['Meteor Egg', '#FF8C2A', 'strider_spawn_egg'],
  wizard: ['Wizard Egg', '#B14BFF', 'enderman_spawn_egg'],
  train: ['Train Egg', '#E03A3A', 'spider_spawn_egg'],
  redstone: ['Redstone Egg', '#FF3B3B', 'mooshroom_spawn_egg'],
  binding: ['Binding Egg', '#C5CCD6', 'stray_spawn_egg'],
  murica: ["'Murica Egg", '#C8102E', 'parrot_spawn_egg'],
  dung: ['Dung Egg', '#A0693A', 'tadpole_spawn_egg'],
  fat: ['Fat Egg', '#FF9EB5', 'pig_spawn_egg'],
  woods: ['Woods Egg', '#3C8F3A', 'creaking_spawn_egg'],
  smite: ['Smite Egg', '#2BB7A0', 'guardian_spawn_egg'],
  stash: ['Stash Egg', '#3DDC97', 'villager_spawn_egg'],
  sulfur: ['Sulfur Egg', '#E8D44D', 'sulfur_cube_spawn_egg'],
  subzero: ['Sub-Zero Egg', '#8FD8FF', 'stray_spawn_egg'],
  combo: ['Combo Egg', '#7DD3FF', 'allay_spawn_egg'],
  electric: ['Electric Egg', '#4FD8FF', 'glow_squid_spawn_egg'],
  deadshot: ['Deadshot Egg', '#E04848', 'pillager_spawn_egg'],
  purpur: ['Purpur Egg', '#C9A0DC', 'shulker_spawn_egg'],
};
// The egg mod's number for each egg (its egg.type score), which the server mod reports with a player's gear.
const EGG_BY_ID = {
  1: 'life', 2: 'hunger', 3: 'sky', 4: 'gravity', 5: 'gambler', 7: 'fire', 8: 'blood', 9: 'echo', 10: 'aqua', 11: 'meteor',
  12: 'wizard', 13: 'train', 14: 'redstone', 15: 'binding', 16: 'murica', 17: 'dung', 18: 'fat', 19: 'woods', 20: 'smite',
  21: 'stash', 22: 'sulfur', 23: 'subzero', 24: 'combo', 25: 'electric', 26: 'deadshot', 27: 'purpur',
};
// A player's egg: the one the server last reported them having, else the one the roster gives them.
const playerEggId = (name, gear) => EGG_BY_ID[gear?.egg?.type] || rosterOf(name)?.egg || null;
// An egg the datapack doesn't have (yet): its name from the id, drawn as a plain egg.
const eggInfo = (id) => {
  if (!id) return null;
  const [name, color, model] = EGGS[id] || [`${id[0].toUpperCase()}${id.slice(1)} Egg`, null, 'egg'];
  return { id, name, color, model };
};

// The best weapon they carry: mace, then trident, sword, axe, pickaxe, shovel; better material first.
const WEAPON_KINDS = ['mace', 'trident', 'sword', 'axe', 'pickaxe', 'shovel'];
const TOOL_MATERIALS = ['netherite', 'diamond', 'iron', 'copper', 'stone', 'golden', 'wooden'];
function weaponRank(it) {
  if (!it || it.egg) return null;
  const kind = WEAPON_KINDS.indexOf(it.id === 'mace' || it.id === 'trident' ? it.id : it.id.split('_').pop());
  if (kind < 0) return null;
  const mat = TOOL_MATERIALS.indexOf(it.id.split('_')[0]);
  return kind * 100 + (mat < 0 ? 50 : mat * 2) + (it.glint ? 0 : 1);
}
function bestWeapon(gear) {
  let best = null, bestRank = Infinity;
  for (const it of [gear?.mainhand, gear?.offhand, ...(gear?.items || [])]) {
    const r = weaponRank(it);
    if (r != null && r < bestRank) [best, bestRank] = [it, r];
  }
  return best;
}
// Their egg as they carry it (the off hand first: that's where it works), else the season's assignment.
function heldEgg(gear, assigned) {
  const carried = [gear?.offhand, gear?.mainhand, ...(gear?.items || [])].find((it) => it?.egg && it.model);
  if (carried) return { id: carried.model };
  const info = eggInfo(assigned);
  return info ? { id: info.model } : null;
}
const itemName = (it) => it.name || it.id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/* ---------- tooltip ---------- */

const tip = $('#tooltip');

// rows: [{ value, label, color }]
function showTip(x, y, rows) {
  tip.replaceChildren(
    ...rows.map((r) => {
      if (r.players) return playerList(r.players);
      if (r.node) return r.node;
      const row = el('div', { class: 'row' });
      if (r.color) row.append(el('span', { class: 'key', style: `background:${r.color}` }));
      if (r.value != null) row.append(el('span', { class: 'tv', text: r.value }));
      if (r.label) row.append(el('span', { class: 'tl', text: r.label }));
      return row;
    })
  );
  tip.classList.toggle('tip-item', rows.some((r) => r.node && !r.adv)); // an item's tooltip looks like the game's
  tip.classList.toggle('tip-adv', rows.some((r) => r.adv)); // and an advancement's like the advancements screen's
  tip.hidden = false;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left = x + 14;
  if (left + w > window.innerWidth - 8) left = x - w - 14;
  let top = y - h - 10;
  if (top < 8) top = y + 18;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${top}px`;
}
const hideTip = () => { tip.hidden = true; };

const TIP_PLAYERS = 10;
const tipHeads = new Map(); // reused across tooltip redraws so heads don't blink while moving
function playerList(names) {
  const list = el('div', { class: 'tip-players' });
  // red team first, then blue, then anyone on neither; each in the order given
  const rank = (name) => ({ red: 0, blue: 1 })[rosterOf(name)?.team] ?? 2;
  names = names.map((name, i) => [rank(name), i, name]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  for (const name of names.slice(0, TIP_PLAYERS)) {
    if (!tipHeads.has(name)) tipHeads.set(name, headImg(name, 14, { width: 14, height: 14, loading: 'eager' }));
    list.append(el('div', { class: 'tip-player' }, tipHeads.get(name), teamName(el('span', { text: shownName(name) }), name)));
  }
  if (names.length > TIP_PLAYERS) list.append(el('div', { class: 'tip-more', text: `+${names.length - TIP_PLAYERS} more` }));
  return list;
}

function attachCellTips(root, selector, getRows) {
  const handler = (e) => {
    const t = e.target.closest(selector);
    if (!t || !root.contains(t)) return hideTip();
    showTip(e.clientX, e.clientY, getRows(t));
  };
  root.addEventListener('pointermove', handler);
  root.addEventListener('pointerdown', handler);
  root.addEventListener('pointerleave', hideTip);
}

/* ---------- color levels ---------- */

function quantileLevels(values) {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))];
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  return (v) => (v <= 0 ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4);
}

function scaleLegend(lowLabel = 'Less', highLabel = 'More') {
  const s = el('div', { class: 'scale' }, el('span', { class: 'lbl', text: lowLabel }));
  for (let i = 0; i < 5; i++) s.append(el('span', { class: `sw lv${i}` }));
  s.append(el('span', { class: 'lbl', text: highLabel }));
  return s;
}

/* ---------- GitHub-style calendar heatmap ---------- */

// days: Map<'YYYY-MM-DD', number>, describe(date, value) -> tooltip rows
function renderHeatmap(root, days, describe) {
  root.replaceChildren();
  const end = todayStr();
  let start = addDays(end, -364);
  start = addDays(start, -dowOf(start));

  const dates = [];
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
  const cols = Math.ceil(dates.length / 7);

  const cell = 11, gap = 3, left = 30, top = 18;
  const W = left + cols * (cell + gap);
  const H = top + 7 * (cell + gap);
  const svg = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Activity per day for the past year' });

  const level = quantileLevels(dates.map((d) => days.get(d) || 0));
  let lastMonth = '';
  dates.forEach((d, i) => {
    const col = Math.floor(i / 7);
    const row = i % 7;
    if (row === 0) {
      const month = d.slice(5, 7);
      if (month !== lastMonth && Number(d.slice(8)) <= 7 && col < cols - 1) {
        const t = sv('text', { x: left + col * (cell + gap), y: 11, class: 'axis-text' });
        t.textContent = fmtDay(d, { month: 'short' });
        svg.append(t);
        lastMonth = month;
      }
    }
    const v = days.get(d) || 0;
    const r = sv('rect', {
      x: left + col * (cell + gap), y: top + row * (cell + gap), width: cell, height: cell,
      class: `cell lv${level(v)}`,
    });
    r.dataset.d = d;
    svg.append(r);
  });

  [['Mon', 1], ['Wed', 3], ['Fri', 5]].forEach(([name, row]) => {
    const t = sv('text', { x: 0, y: top + row * (cell + gap) + 9, class: 'axis-text' });
    t.textContent = name;
    svg.append(t);
  });

  root.append(svg, scaleLegend());
  attachCellTips(root, 'rect.cell', (r) => describe(r.dataset.d, days.get(r.dataset.d) || 0));
  root.scrollLeft = root.scrollWidth; // most recent weeks visible on narrow screens
}

/* ---------- update effects ---------- */

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const FX = {
  green: ['#0ca30c', '#3ddc84', '#9af0b0', '#e3ffe9'],
  red: ['#d03b3b', '#ff6b6b', '#ffb0b0', '#ffe3e3'],
  blue: ['#2a78d6', '#5598e7', '#9ec5f4', '#e3f0ff'],
};

// Square "pixel" particles drawn on one full-screen canvas that only runs while particles exist.
const fx = (() => {
  const cv = el('canvas', { class: 'fx-canvas', 'aria-hidden': 'true' });
  document.body.append(cv);
  const ctx = cv.getContext('2d');
  let parts = [], raf = 0, last = 0, dpr = 1;
  const resize = () => {
    dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(window.innerWidth * dpr);
    cv.height = Math.round(window.innerHeight * dpr);
  };
  resize();
  window.addEventListener('resize', resize);
  const rand = (a, b) => a + Math.random() * (b - a);

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, cv.width, cv.height);
    parts = parts.filter((p) => now - p.born < p.life);
    for (const p of parts) {
      p.vx *= 1 - 2 * dt;
      p.vy = p.vy * (1 - 2 * dt) + p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const age = (now - p.born) / p.life;
      const twinkle = p.twinkle ? 0.55 + 0.45 * Math.sin(now / 45 + p.phase) : 1;
      ctx.globalAlpha = Math.max(0, (1 - age * age) * twinkle);
      ctx.fillStyle = p.color;
      const s = Math.max(1, Math.round(p.size * dpr));
      ctx.fillRect(Math.round(p.x * dpr), Math.round(p.y * dpr), s, s);
    }
    ctx.globalAlpha = 1;
    raf = parts.length ? requestAnimationFrame(frame) : 0;
  }

  const api = {
    // One particle at viewport coordinates (x, y). Ranges are [min, max].
    spark(x, y, { colors, vx = [-20, 20], vy = [-40, -10], g = 0, life = [500, 900], size = [2, 3] }) {
      if (reducedMotion()) return;
      parts.push({
        x, y, vx: rand(...vx), vy: rand(...vy), g,
        born: performance.now(), life: rand(...life), size: Math.round(rand(...size)),
        color: colors[Math.floor(Math.random() * colors.length)],
        twinkle: Math.random() < 0.6, phase: Math.random() * 6.28,
      });
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    },
    burst(rect, { count = 16, ...opts }) {
      for (let i = 0; i < count; i++) {
        api.spark(rect.left + Math.random() * rect.width, rect.top + Math.random() * rect.height, opts);
      }
    },
  };
  return api;
})();

const burstUp = (node) => fx.burst(node.getBoundingClientRect(), {
  colors: FX.green, count: 18, vx: [-60, 60], vy: [-120, -30], g: 40, life: [600, 1100], size: [2, 4],
});
const burstDown = (node) => fx.burst(node.getBoundingClientRect(), {
  colors: FX.red, count: 18, vx: [-60, 60], vy: [-30, 30], g: 160, life: [600, 1100], size: [2, 4],
});

// A grid of square tiles on a canvas over `target` (inside `host`, which must be position: relative).
// mode 'clear': starts filled with `color`, tiles vanish one by one (a tint dissolving away).
// mode 'cover': tiles fill in with `color` one by one (the element disintegrating into the page).
function pixelTiles({ host, target, mode, color, tile = 4, pad = 0, hold = 0, duration = 800, sweep = 0.4, spark, onDone }) {
  if (reducedMotion()) { onDone?.(); return; }
  const hr = host.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  const w = Math.ceil(r.width + 2 * pad), h = Math.ceil(r.height + 2 * pad);
  const dpr = window.devicePixelRatio || 1;
  const cv = el('canvas', { class: 'fx-local', 'aria-hidden': 'true' });
  cv.width = Math.ceil(w * dpr);
  cv.height = Math.ceil(h * dpr);
  Object.assign(cv.style, {
    left: `${r.left - hr.left + host.scrollLeft - pad}px`,
    top: `${r.top - hr.top + host.scrollTop - pad}px`,
    width: `${w}px`, height: `${h}px`,
  });
  host.append(cv);
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = color;
  if (mode === 'clear') ctx.fillRect(0, 0, w, h);

  const cols = Math.ceil(w / tile), rows = Math.ceil(h / tile);
  const tiles = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      tiles.push({ x: x * tile, y: y * tile, at: hold + duration * ((x / cols) * sweep + Math.random() * (1 - sweep)) });
    }
  }
  tiles.sort((a, b) => a.at - b.at);

  let i = 0;
  const t0 = performance.now();
  const step = (now) => {
    const t = now - t0;
    const cr = cv.getBoundingClientRect();
    while (i < tiles.length && tiles[i].at <= t) {
      const tl = tiles[i++];
      if (mode === 'clear') ctx.clearRect(tl.x, tl.y, tile, tile);
      else ctx.fillRect(tl.x, tl.y, tile, tile);
      if (spark && Math.random() < spark.chance) fx.spark(cr.left + tl.x, cr.top + tl.y, spark);
    }
    if (i < tiles.length && cv.isConnected) requestAnimationFrame(step);
    else { cv.remove(); onDone?.(); }
  };
  requestAnimationFrame(step);
}

/* ---------- rolling counters ---------- */

const ROLL_MS = 650;

// Renders `text` with each digit in a vertical strip (0-9 twice) that can roll to a new digit.
function buildOdometer(node, text, fromText) {
  const fromDigits = fromText ? fromText.replace(/\D/g, '') : '';
  const digitCount = text.replace(/\D/g, '').length;
  let di = 0;
  const odo = el('span', { class: 'odo', 'aria-hidden': 'true' });
  for (const c of text) {
    if (/\d/.test(c)) {
      // right-align old digits against new ones; brand-new leading digits start at 0
      const oi = fromDigits.length - (digitCount - di);
      const start = fromText == null ? Number(c) : oi >= 0 ? Number(fromDigits[oi]) : 0;
      const strip = el('span', { class: 'odo-strip' });
      for (let k = 0; k < 20; k++) strip.append(el('span', { text: String(k % 10) }));
      strip.style.transform = `translateY(${-start * 1.2}em)`;
      strip.dataset.pos = start;
      odo.append(el('span', { class: 'odo-col' }, strip));
      di++;
    } else {
      odo.append(el('span', { class: 'odo-static', text: c }));
    }
  }
  node.replaceChildren(odo, el('span', { class: 'sr-only', text }));
}

function rollOdometer(node, text, up) {
  const targets = text.replace(/\D/g, '');
  const strips = node.querySelectorAll('.odo-strip');
  strips.forEach((strip, i) => {
    const t = Number(targets[i]);
    const cur = Number(strip.dataset.pos);
    if (t === cur) return;
    let to = t;
    if (up && t < cur) to = t + 10; // keep rolling forward through 9 -> 0
    if (!up && t > cur) {
      // jump to the identical digit in the second half, then roll backward
      strip.style.transition = 'none';
      strip.style.transform = `translateY(${-(cur + 10) * 1.2}em)`;
      void strip.offsetHeight;
    }
    const delay = (strips.length - 1 - i) * 60; // ones column moves first, like a clicker
    strip.style.transition = `transform ${ROLL_MS}ms cubic-bezier(.2,.8,.25,1) ${delay}ms`;
    strip.style.transform = `translateY(${-to * 1.2}em)`;
    strip.dataset.pos = t;
    if (to !== t) {
      strip.addEventListener('transitionend', () => {
        strip.style.transition = 'none';
        strip.style.transform = `translateY(${-t * 1.2}em)`;
      }, { once: true });
    }
  });
}

// Sets a tile's value. On live updates digits roll and particles burst green (up) or red (down).
function setCounter(node, text, value, animate) {
  const prevText = node.dataset.text;
  const prevValue = node.dataset.value === undefined || node.dataset.value === '' ? null : Number(node.dataset.value);
  node.dataset.text = text;
  node.dataset.value = value ?? '';
  if (prevText === text && node.querySelector('.odo')) return;

  const changed = animate && prevValue != null && value != null && value !== prevValue;
  if (!changed || reducedMotion()) {
    buildOdometer(node, text, null);
    return;
  }
  const up = value > prevValue;
  const shape = (s) => s.replace(/\d/g, '0');
  if (!node.querySelector('.odo') || shape(prevText) !== shape(text)) buildOdometer(node, text, prevText);
  requestAnimationFrame(() => rollOdometer(node, text, up));
  (up ? burstUp : burstDown)(node);
}

/* ---------- chart tweening ---------- */

const TWEEN_MS = 650;
const chartPrev = new Map(); // root -> what was last drawn, to tween from
const tweens = new Map();
const lerp = (a, b, e) => a + (b - a) * e;
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

function stopTween(root) {
  cancelAnimationFrame(tweens.get(root));
  tweens.delete(root);
}

function tween(root, draw) {
  stopTween(root);
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / TWEEN_MS);
    draw(easeInOut(k));
    if (k < 1) tweens.set(root, requestAnimationFrame(step));
    else tweens.delete(root);
  };
  draw(0);
  tweens.set(root, requestAnimationFrame(step));
}

// Paging with ‹ ›: the old drawing scrolls out as the new one scrolls in from the side it came from.
const SLIDE_MS = 450;
const sliding = new Map(); // root -> slides in progress
// shift: how far the content moves, in chart widths (-1 = a whole width earlier).
// Partial shifts also cross-fade, since the old and new drawings overlap.
function slideIn(root, old, shift) {
  const cur = root.firstElementChild;
  if (!old || !cur || !shift || reducedMotion()) return;
  const W = root.clientWidth;
  const fade = Math.abs(shift) < 0.999;
  Object.assign(old.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
  root.style.overflow = 'hidden';
  sliding.set(root, (sliding.get(root) || 0) + 1);
  root.append(old);
  const opts = { duration: SLIDE_MS, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' };
  morphAxis(old, cur, opts);
  // Earlier (negative shift) moves content right, like scrolling back along a timeline.
  const oldBody = old.querySelector(':scope > .slide') || old;
  const curBody = cur.querySelector(':scope > .slide') || cur;
  oldBody.animate([
    { transform: 'translateX(0)', opacity: 1 },
    { transform: `translateX(${-shift * W}px)`, opacity: fade ? 0 : 1 },
  ], opts);
  curBody.animate([
    { transform: `translateX(${shift * W}px)`, opacity: fade ? 0 : 1 },
    { transform: 'translateX(0)', opacity: 1 },
  ], opts).finished
    .catch(() => {})
    .finally(() => {
      old.remove();
      const n = sliding.get(root) - 1;
      if (n) sliding.set(root, n);
      else { sliding.delete(root); root.style.overflow = ''; }
    });
}

// When a slide changes the y scale, the gridlines glide from where their values sat on the old
// scale to the new one (a 10 line moves from the top to the middle when the peak doubles).
// Lines only on the old scale fade out; lines only on the new one fade in.
function morphAxis(old, cur, opts) {
  const a = old.querySelector(':scope > .yaxis'), b = cur.querySelector(':scope > .yaxis');
  if (!a || !b) return;
  const top = Number(cur.dataset.top), ph = Number(cur.dataset.ph);
  const oldMax = Number(old.dataset.ymax), newMax = Number(cur.dataset.ymax);
  if (oldMax === newMax || Number(old.dataset.ph) !== ph) return;
  const yOld = (v) => top + ph - (v / oldMax) * ph;
  const yNew = (v) => top + ph - (v / newMax) * ph;
  const ticks = (g) => [...g.querySelectorAll('.ytick')];
  const newVals = new Set(ticks(b).map((t) => t.dataset.v));
  const oldVals = new Set(ticks(a).map((t) => t.dataset.v));
  for (const t of ticks(a)) {
    const v = Number(t.dataset.v);
    if (newVals.has(t.dataset.v)) { t.style.visibility = 'hidden'; continue; } // the new one covers it
    t.animate([
      { transform: 'translateY(0)', opacity: 1 },
      { transform: `translateY(${yNew(v) - yOld(v)}px)`, opacity: 0 },
    ], opts);
  }
  for (const t of ticks(b)) {
    const v = Number(t.dataset.v);
    t.animate([
      { transform: `translateY(${yOld(v) - yNew(v)}px)`, opacity: oldVals.has(t.dataset.v) ? 1 : 0 },
      { transform: 'translateY(0)', opacity: 1 },
    ], opts);
  }
}

/* ---------- hour × weekday grid ---------- */

const weekPrev = new Map();

// grid[dow][hour] = number, laid out like a week calendar: days across, hours running down.
// cellColor(d, h), when given, colors each cell itself (instead of the five levels), with its own legend.
// describe(value, label, d, h) -> tooltip rows
function renderWeekGrid(root, grid, describe, { animate = false, cellColor = null, legend = null } = {}) {
  root.replaceChildren();
  const max = Math.max(0, ...grid.flat());
  const level = (v) => (v <= 0 || max <= 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)));
  const g = el('div', { class: 'weekgrid', role: 'img', 'aria-label': 'Activity by weekday and hour' });

  g.append(el('span'));
  for (let d = 0; d < 7; d++) g.append(el('span', { class: 'dlabel', text: DOWS[d] }));
  const cells = [];
  for (let h = 0; h < 24; h++) {
    g.append(el('span', { class: 'hlabel', text: h % 3 ? '' : hourName(h, true) }));
    for (let d = 0; d < 7; d++) {
      const c = el('span', { class: cellColor ? 'wcell' : `wcell lv${level(grid[d][h])}` });
      if (cellColor) c.style.background = cellColor(d, h);
      c.dataset.d = d;
      c.dataset.h = h;
      g.append(c);
      cells.push(c);
    }
  }
  root.append(g, legend || scaleLegend());
  attachCellTips(root, '.wcell', (c) => {
    const d = Number(c.dataset.d), h = Number(c.dataset.h);
    return describe(grid[d][h], `${DOWS[d]} ${hourName(h)}–${hourName((h + 1) % 24)}`, d, h);
  });

  const prev = weekPrev.get(root);
  weekPrev.set(root, grid.map((row) => row.slice()));
  if (!animate || !prev) return;
  cells.forEach((c) => {
    const d = Number(c.dataset.d), h = Number(c.dataset.h);
    if (Math.abs(prev[d][h] - grid[d][h]) < 1e-9) return;
    const r = c.getBoundingClientRect();
    fx.burst({ left: r.left - 6, top: r.top - 6, width: r.width + 12, height: r.height + 12 }, {
      colors: FX.blue, count: 12, vx: [-35, 35], vy: [-50, -10], life: [600, 1100], size: [2, 3],
    });
  });
}

/* ---------- "no data yet" block ---------- */

// Where charts mark the season as beginning. Normally that's the first recorded check; when the
// season has an official start later than that (recording began early, to test), it's the official
// start: what was recorded before it still shows, drawn over the hatching.
const seasonOpens = () => state.status?.season?.opens ?? null;
const chartStart = () => Math.max(state.dataStart ?? 0, seasonOpens() ?? 0) || null;
function hatchText() {
  const opens = seasonOpens();
  if (!opens || opens <= (state.dataStart ?? 0)) return 'No data yet';
  return nowSec() < opens ? `Season starts ${fmt(opens, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Before the season';
}

// A quiet grey rectangle with sparse diagonal lines, covering x0..x1 of a plot.
function noDataBlock(svg, parent, id, x0, x1, top, height, { label = true, text = hatchText() } = {}) {
  const w = x1 - x0;
  if (w < 1) return;
  if (!svg.querySelector(`#${CSS.escape(id)}`)) {
    const pattern = sv('pattern', { id, width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pattern.append(sv('line', { x1: 0, y1: 0, x2: 0, y2: 7, class: 'nodata-line' }));
    svg.append(pattern);
  }
  parent.append(
    sv('rect', { x: x0, y: top, width: w, height, class: 'nodata-fill' }),
    sv('rect', { x: x0, y: top, width: w, height, fill: `url(#${id})` })
  );
  if (label && w >= 70) {
    const t = sv('text', { x: x0 + w / 2, y: top + 16, 'text-anchor': 'middle', class: 'axis-text nodata-text' });
    t.textContent = w >= 150 ? text : text.replace(/^Season starts /, 'Starts ');
    parent.append(t);
  }
}

/* ---------- line chart with crosshair ---------- */

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

// Charts sized to their container re-render on resize.
const redraws = new Map();

function lineTarget(opts) {
  let vmax = opts.yMin || 0;
  for (const s of opts.series) for (const p of s.pts) if (p.v > vmax) vmax = p.v;
  const ystep = niceStep(Math.max(1, Math.max(vmax, 4) / (opts.ticks || 4)));
  const ymax = Math.max(4, Math.ceil(vmax / ystep) * ystep);
  return { from: opts.from, to: opts.to, ymax, ystep, vals: opts.series.map((s) => s.pts.map((p) => p.v)) };
}

// opts: { key, from, to, step, series: [{ name, cls, color, area, pts: [{t, v, down}] }], fmtValue, fmtTime,
//         ticks?, yMin? (the y-axis reaches at least this), whoAt?(t), onPick?(t) when the plot is clicked,
//         onDraw?(geometry) after every frame }
// With animate, morphs from the previous drawing of the same range (domain, scale and values).
function renderLineChart(root, opts, { animate = false, slide = 0 } = {}) {
  const prev = chartPrev.get(root);
  const old = slide ? root.firstElementChild : null;
  const target = lineTarget(opts);
  chartPrev.set(root, { key: opts.key, opts, frame: target });
  redraws.set(root, () => drawLineChart(root, opts, target));

  const canTween = animate && prev && prev.key === opts.key
    && opts.series[0].pts.length && prev.opts.series[0].pts.length;
  if (!canTween) {
    stopTween(root);
    drawLineChart(root, opts, target);
    slideIn(root, old, slide);
    return;
  }

  const start = {
    ...prev.frame,
    vals: opts.series.map((s, k) => {
      const oldPts = prev.opts.series[k]?.pts || [];
      const oldVals = prev.frame.vals[k] || [];
      const byT = new Map(oldPts.map((p, i) => [p.t, oldVals[i]]));
      const tail = oldVals.length ? oldVals[oldVals.length - 1] : 0; // new points grow out of the last one
      return s.pts.map((p) => (byT.has(p.t) ? byT.get(p.t) : tail));
    }),
  };
  tween(root, (e) => drawLineChart(root, opts, {
    from: lerp(start.from, target.from, e),
    to: lerp(start.to, target.to, e),
    ymax: lerp(start.ymax, target.ymax, e),
    ystep: e < 0.5 ? start.ystep : target.ystep,
    vals: target.vals.map((vs, k) => vs.map((v, i) => lerp(start.vals[k][i], v, e))),
  }));
}

function drawLineChart(root, opts, f) {
  root.replaceChildren();
  const { step, series } = opts;
  const { from, to, ymax, ystep } = f;
  const pts0 = series[0].pts;
  if (!pts0.length) {
    root.append(el('div', { class: 'empty-chart', text: 'No data in this range yet' }));
    opts.onDraw?.(null);
    return;
  }

  const W = Math.max(280, root.clientWidth);
  const H = root.clientHeight || 240;
  const m = { l: 30, r: 10, t: 10, b: 24 };
  root.plotBox = { l: m.l, r: m.r }; // for pinch zoom
  const pw = W - m.l - m.r, ph = H - m.t - m.b;

  const x = (t) => m.l + ((t - from) / (to - from)) * pw;
  const y = (v) => m.t + ph - (v / ymax) * ph;

  const svg = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Players online over time' });

  // The y-axis stays put while paging slides the rest (.slide) sideways; see slideIn.
  const yaxis = sv('g', { class: 'yaxis' });
  const body = sv('g', { class: 'slide' });
  svg.append(yaxis, body);
  svg.dataset.top = m.t;
  svg.dataset.ph = ph;
  svg.dataset.ymax = ymax;
  for (let v = 0; v <= ymax + 1e-9; v += ystep) {
    const tick = sv('g', { class: 'ytick' });
    tick.dataset.v = v;
    if (v > 0) tick.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'gridline' }));
    const t = sv('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' });
    t.textContent = Number.isInteger(v) ? v : v.toFixed(1);
    tick.append(t);
    yaxis.append(tick);
  }
  yaxis.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), class: 'baseline' }));

  // x ticks: local hours for short ranges, local midnights for long ones
  const days = (to - from) / 86400;
  const candidates = [];
  for (let h = Math.ceil(from / 3600) * 3600; h < to; h += 3600) { // the end itself would hang off the edge
    const info = hourInfo(h);
    if (days <= 0.6 || (days <= 1.5 ? info.hour % 3 === 0 : info.hour === 0)) candidates.push(h);
  }
  const maxTicks = Math.max(2, Math.floor(pw / 80));
  const every = Math.max(1, Math.ceil(candidates.length / maxTicks));
  candidates.forEach((h, i) => {
    if (i % every) return;
    const t = sv('text', { x: x(h), y: H - 6, 'text-anchor': 'middle', class: 'axis-text' });
    t.textContent = days <= 1.5 ? hourName(hourInfo(h).hour, false)
      : days <= 8 ? fmt(h, { weekday: 'short' })
      : fmt(h, { month: 'short', day: 'numeric' });
    body.append(t);
  });

  // lines, broken wherever there is missing data; clipped to the plot while the domain slides
  const clipId = `${root.id}-clip`;
  const clip = sv('clipPath', { id: clipId });
  clip.append(sv('rect', { x: m.l, y: 0, width: pw, height: m.t + ph + 1 }));
  body.append(clip);
  const plot = sv('g', { 'clip-path': `url(#${clipId})` });
  body.append(plot);

  // hatched block for the time before tracking started
  if (opts.dataStart && opts.dataStart > from) {
    noDataBlock(svg, plot, `${root.id}-hatch`, m.l, Math.min(m.l + pw, x(opts.dataStart)), m.t, ph);
  }

  series.forEach((s, k) => {
    const vals = f.vals[k];
    let line = '', area = '', segStart = null, prev = null;
    const closeArea = () => {
      if (s.area && segStart !== null) area += `L${x(prev.t)},${y(0)}L${x(segStart.t)},${y(0)}Z`;
    };
    s.pts.forEach((p, i) => {
      const py = y(vals[i]);
      const gap = !prev || p.t - prev.t > step * 2.5;
      if (gap) {
        closeArea();
        line += `M${x(p.t)},${py}`;
        if (s.area) area += `M${x(p.t)},${py}`;
        segStart = p;
      } else {
        line += `L${x(p.t)},${py}`;
        if (s.area) area += `L${x(p.t)},${py}`;
      }
      prev = p;
    });
    closeArea();
    if (s.area) plot.append(sv('path', { d: area, class: `area-${s.cls}` }));
    plot.append(sv('path', { d: line, class: `line-${s.cls}` }));
  });

  // crosshair + tooltip
  const cross = sv('line', { y1: m.t, y2: m.t + ph, class: 'crosshair', visibility: 'hidden' });
  const markers = series.map((s) => sv('circle', { r: 4, style: `fill:${s.color}`, class: 'marker', visibility: 'hidden' }));
  body.append(cross, ...markers);
  const hit = sv('rect', { x: m.l, y: 0, width: pw, height: H, fill: 'transparent' });
  body.append(hit);

  const nearest = (t) => {
    let lo = 0, hi = pts0.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts0[mid].t < t) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && t - pts0[lo - 1].t < pts0[lo].t - t) lo--;
    return lo;
  };
  const move = (e) => {
    const rect = svg.getBoundingClientRect();
    const t = from + ((e.clientX - rect.left - m.l) / pw) * (to - from);
    const i = nearest(t);
    const p = pts0[i];
    const px = x(p.t);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    series.forEach((s, k) => {
      markers[k].setAttribute('cx', px);
      markers[k].setAttribute('cy', y(f.vals[k][i]));
      markers[k].setAttribute('visibility', 'visible');
    });
    const rows = series.map((s) => ({
      value: s.pts[i].down ? 'Server offline' : opts.fmtValue(s.pts[i].v),
      label: s.pts[i].down ? null : s.name,
      color: series.length > 1 ? s.color : null,
    }));
    rows.push({ label: opts.fmtTime(p.t) });
    const who = opts.whoAt?.(p.t);
    if (who?.length) rows.push({ players: who });
    showTip(e.clientX, e.clientY, rows);
  };
  const leave = () => {
    cross.setAttribute('visibility', 'hidden');
    markers.forEach((mk) => mk.setAttribute('visibility', 'hidden'));
    hideTip();
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
  if (opts.onPick) {
    hit.style.cursor = 'pointer';
    hit.addEventListener('click', (e) => {
      const t = from + ((e.clientX - svg.getBoundingClientRect().left - m.l) / pw) * (to - from);
      opts.onPick(Math.max(from, Math.min(to, t)));
    });
  }

  root.append(svg);
  opts.onDraw?.({
    from, to, top: m.t, height: ph, x,
    // the line's height at t (nearest point), or null where there's no data
    yAt: (t) => {
      if (t < pts0[0].t - step || t > pts0.at(-1).t + step) return null;
      const i = nearest(t);
      return Math.abs(pts0[i].t - t) > step * 2.5 ? null : y(f.vals[0][i]);
    },
  });
}

/* ---------- bar chart over time buckets ---------- */

function barScale(vals) {
  const vmax = Math.max(0, ...vals);
  const ystep = vmax > 0 ? niceStep(vmax / 4) : 1;
  const ymax = vmax > 0 ? Math.ceil(vmax / ystep) * ystep : 4;
  return { ymax, ystep };
}

// spec: {
//   buckets: [{ key, start, end, date }]   contiguous time slots, one bar each
//   vals, fmtTick, describe(i) -> tooltip rows, labels: 'hour' | 'day',
//   windowKey   tween only between drawings of the same window
//   dataStart   hatch everything before it
//   strip?      { intervals: [[start, end]], describe(t, interval) } — a when-online bar under the plot
//   scale?      { ymax, ystep } — fixed y-axis instead of fitting the values
//   split?      [{ red, blue }] — each bar's share (0 to 1) that is the red and the blue team's
// }
// grow: bars rise from zero (first drawing for a newly opened page).
function renderBars(root, spec, { animate = false, slide = 0, grow = false } = {}) {
  const old = slide ? root.firstElementChild : null;
  const scale = (vals) => spec.scale || barScale(vals);
  const target = { vals: spec.vals, ...scale(spec.vals) };
  const prev = chartPrev.get(root);
  chartPrev.set(root, { windowKey: spec.windowKey, byKey: new Map(spec.buckets.map((b, i) => [b.key, spec.vals[i]])) });
  redraws.set(root, () => drawBars(root, spec, target));

  if (grow && reducedMotion()) grow = false;
  const startVals = grow ? spec.buckets.map(() => 0)
    : prev && prev.windowKey === spec.windowKey ? spec.buckets.map((b) => prev.byKey.get(b.key) ?? 0) : null;
  const same = startVals && startVals.every((v, i) => Math.abs(v - spec.vals[i]) < 1e-9);
  if (!(animate || grow) || !startVals || same) {
    stopTween(root);
    drawBars(root, spec, target);
    slideIn(root, old, slide);
    return;
  }
  const start = grow ? target : scale(startVals);
  tween(root, (e) => drawBars(root, spec, {
    vals: spec.vals.map((v, i) => lerp(startVals[i], v, e)),
    ymax: lerp(start.ymax, target.ymax, e),
    ystep: e < 0.5 ? start.ystep : target.ystep,
  }));
}

function drawBars(root, spec, f) {
  root.replaceChildren();
  const { buckets, fmtTick, strip, chatStrip } = spec;
  const n = buckets.length;
  const W = Math.max(280, root.clientWidth);
  const H = root.clientHeight || 200;
  const m = { l: chatStrip ? 46 : 34, r: 4, t: 10, b: strip ? (chatStrip ? 80 : 48) : 24 };
  root.plotBox = { l: m.l, r: m.r }; // for pinch zoom
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const { ymax, ystep } = f;
  const y = (v) => m.t + ph - (v / ymax) * ph;
  const slot = pw / n;
  const from = buckets[0].start, to = buckets[n - 1].end;

  // time <-> x, linear within each slot so bars, hatching and the strip line up exactly
  const xAt = (t) => {
    if (t <= from) return m.l;
    if (t >= to) return m.l + pw;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (buckets[mid].start <= t) lo = mid; else hi = mid - 1;
    }
    const b = buckets[lo];
    return m.l + slot * (lo + (t - b.start) / (b.end - b.start));
  };
  const tAt = (px) => {
    const u = Math.min(n - 1e-9, Math.max(0, (px - m.l) / slot));
    const i = Math.floor(u);
    const b = buckets[i];
    return b.start + (u - i) * (b.end - b.start);
  };

  const svg = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Activity over time' });

  for (let v = 0; v <= ymax + 1e-9; v += ystep) {
    if (v > 0) svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'gridline' }));
    const t = sv('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' });
    t.textContent = fmtTick(Math.round(v * 100) / 100);
    svg.append(t);
  }

  const hatchId = `${root.id}-hatch`;
  // a bar stands for its whole bucket, so the hatch stops at the start of the one the data (or season) begins in
  const firstBar = spec.dataStart && (buckets.find((bk) => spec.dataStart < bk.end)?.start ?? spec.dataStart);
  if (spec.dataStart && firstBar > from) noDataBlock(svg, svg, hatchId, m.l, xAt(firstBar), m.t, ph);

  const gap = slot >= 8 ? 2 * Math.max(2, slot * 0.15) : slot * 0.3;
  const bw = Math.min(40, slot - gap);
  const hourly = spec.labels === 'hour';
  const labelEvery = hourly
    ? (slot >= 36 ? 1 : slot >= 18 ? 2 : slot >= 12 ? 3 : 6)
    : (slot >= 44 ? 1 : slot >= 22 ? 2 : slot >= 14 ? 3 : slot >= 7 ? 7 : 14);
  const bars = [];

  buckets.forEach((b, i) => {
    const cx = m.l + slot * (i + 0.5);
    const top = Math.max(m.t, y(f.vals[i])), base = y(0);
    const h = base - top;
    if (h > 0.5) {
      // rounded top, square base; with spec.split the bar is stacked: red at the bottom, then blue, then the rest
      const x0 = cx - bw / 2, x1 = cx + bw / 2;
      const sp = spec.split?.[i];
      const segs = (sp ? [['team-red', sp.red], ['team-blue', sp.blue], ['', 1 - sp.red - sp.blue]] : [['', 1]])
        .filter(([, share]) => share * h > 0.5);
      const bar = sv('g', { class: 'dbar-stack' });
      let from = base;
      segs.forEach(([cls, share], k) => {
        const last = k === segs.length - 1;
        const to = last ? top : from - share * h;
        const r = last ? Math.min(4, from - to, bw / 2) : 0;
        bar.append(sv('path', {
          d: `M${x0},${from}V${to + r}Q${x0},${to} ${x0 + r},${to}H${x1 - r}Q${x1},${to} ${x1},${to + r}V${from}Z`,
          class: `dbar ${cls}`,
        }));
        from = to;
      });
      svg.append(bar);
      bars[i] = bar;
    }

    // Labels are counted back from the newest slot so the latest one is always labelled.
    if ((n - 1 - i) % labelEvery === 0) {
      const t = sv('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'axis-text' });
      if (hourly) {
        t.textContent = hourName(hourInfo(b.start).hour, true);
      } else {
        const day = Number(b.date.slice(8));
        t.textContent = b.date === todayStr() && !archived() ? 'Today'
          : day === 1 || slot >= 44 || i < labelEvery || labelEvery >= 7 ? fmtDay(b.date, { month: 'short', day: 'numeric' })
          : String(day);
      }
      svg.append(t);
    }

    const hit = sv('rect', { x: m.l + slot * i, y: m.t, width: slot, height: ph, fill: 'transparent', class: 'dbar-hit' });
    hit.dataset.i = i;
    svg.append(hit);
  });
  svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), class: 'baseline' }));

  // when-online strip, sharing the bars' time scale
  let stripCross = null, chatCross = null, chatMarks = [];
  if (strip) {
    const sy = m.t + ph + 8, sh = 14;
    svg.append(sv('rect', { x: m.l, y: sy, width: pw, height: sh, rx: 3, class: 'strip-bg' }));
    if (spec.dataStart && spec.dataStart > from) noDataBlock(svg, svg, hatchId, m.l, xAt(spec.dataStart), sy, sh, { label: false });
    for (const [a, e] of strip.intervals) {
      const x0 = xAt(Math.max(a, from));
      svg.append(sv('rect', { x: x0, y: sy, width: Math.max(1.5, xAt(Math.min(e, to)) - x0), height: sh, class: 'strip-on' }));
    }
    let bottom = sy + sh;
    stripCross = sv('line', { y1: sy - 3, y2: sy + sh + 3, class: 'crosshair strip-cross', visibility: 'hidden' });
    const stripHit = sv('rect', { x: m.l, y: sy - 4, width: pw, height: sh + 7, fill: 'transparent', class: 'strip-hit' });

    // chat strip: a line per message, a red diamond per death, a yellow star per advancement
    if (chatStrip) {
      const cy = sy + sh + 6, ch = 24, mid = cy + ch / 2;
      bottom = cy + ch;
      for (const [label, y0, cls] of [['Online', sy, 'strip-label-on'], ['Chat', cy, 'strip-label-chat']]) {
        const t = sv('text', { x: m.l - 6, y: y0 + (y0 === sy ? sh : ch) / 2 + 3.5, 'text-anchor': 'end', class: `axis-text strip-label ${cls}` });
        t.textContent = label;
        svg.append(t);
      }
      svg.append(sv('rect', { x: m.l, y: cy, width: pw, height: ch, rx: 3, class: 'strip-bg' }));
      if (chatStrip.dataStart && chatStrip.dataStart > from) noDataBlock(svg, svg, hatchId, m.l, xAt(chatStrip.dataStart), cy, ch, { label: false });
      const talk = [], marks = [];
      for (const ev of chatStrip.events) {
        const x = xAt(ev[1] / 1000);
        chatMarks.push({ ev, x });
        if (ev[2] === 'death') marks.push(sv('rect', { x: x - 3.5, y: mid - 3.5, width: 7, height: 7, transform: `rotate(45 ${x} ${mid})`, class: 'chat-death' }));
        else if (ev[2] === 'advancement') marks.push(sv('path', { d: starPath(x, mid, 7.5), class: 'chat-adv' }));
        else talk.push(`M${x},${cy + 3}V${cy + ch - 3}`);
      }
      if (talk.length) svg.append(sv('path', { d: talk.join(''), class: 'chat-tick' }));
      svg.append(...marks); // symbols on top of the lines
      chatCross = sv('line', { y1: cy - 3, y2: cy + ch + 3, class: 'crosshair strip-cross', visibility: 'hidden' });
      svg.append(chatCross, sv('rect', { x: m.l, y: cy - 3, width: pw, height: ch + 6, fill: 'transparent', class: 'chat-hit' }));
    }
    if (slot >= 4) {
      for (let i = 0; i <= n; i++) {
        const tx = m.l + slot * i;
        svg.append(sv('line', { x1: tx, x2: tx, y1: bottom + 1, y2: bottom + 5, class: 'strip-tick' }));
      }
    }
    svg.append(stripCross, stripHit);
  }

  // the chat mark nearest the pointer (symbols win when close, since they're bigger targets)
  const chatAt = (px) => {
    let best = null, bestD = 9;
    for (const c of chatMarks) {
      const d = Math.abs(c.x - px) - (c.ev[2] === 'death' || c.ev[2] === 'advancement' ? 3 : 0);
      if (d < bestD) { best = c; bestD = d; }
    }
    return best;
  };

  let hovered = null;
  const clearHover = () => {
    hovered?.classList.remove('hover');
    hovered = null;
    stripCross?.setAttribute('visibility', 'hidden');
    chatCross?.setAttribute('visibility', 'hidden');
  };
  const move = (e) => {
    if (e.target.classList.contains('chat-hit')) {
      clearHover();
      const c = chatAt(e.clientX - svg.getBoundingClientRect().left);
      if (!c) return hideTip();
      chatCross.setAttribute('x1', c.x);
      chatCross.setAttribute('x2', c.x);
      chatCross.setAttribute('visibility', 'visible');
      const [, ts, kind, text] = c.ev;
      const what = CHAT_KINDS[kind] || CHAT_KINDS.chat;
      showTip(e.clientX, e.clientY, [
        { value: what.label, color: what.color },
        { label: fmt(ts / 1000, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) },
        { label: text.length > 70 ? `${text.slice(0, 70)}…` : text },
        { label: 'Click to preview' },
      ]);
      return;
    }
    if (e.target.classList.contains('strip-hit')) {
      clearHover();
      const px = e.clientX - svg.getBoundingClientRect().left;
      const t = Math.floor(tAt(px) / 60) * 60;
      const iv = strip.intervals.find(([a, b]) => t >= a && t < b) || null;
      stripCross.setAttribute('x1', xAt(t));
      stripCross.setAttribute('x2', xAt(t));
      stripCross.setAttribute('visibility', 'visible');
      showTip(e.clientX, e.clientY, strip.describe(t, iv));
      return;
    }
    const hit = e.target.closest('.dbar-hit');
    if (!hit) {
      clearHover();
      hideTip();
      return;
    }
    const i = Number(hit.dataset.i);
    if (hovered !== bars[i]) {
      clearHover();
      hovered = bars[i] || null;
      hovered?.classList.add('hover');
    }
    showTip(e.clientX, e.clientY, spec.describe(i));
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', () => { clearHover(); hideTip(); });
  if (chatStrip) {
    svg.addEventListener('click', (e) => {
      if (!e.target.classList.contains('chat-hit')) return;
      const c = chatAt(e.clientX - svg.getBoundingClientRect().left);
      if (!c) return;
      hideTip();
      const box = svg.getBoundingClientRect();
      chatStrip.onPick(c.ev, box.left + c.x, Number(chatCross.getAttribute('y2')) + box.top);
    });
  }

  root.append(svg);
}

const CHAT_KINDS = {
  chat: { label: 'Chat message', color: 'var(--series-2)' },
  say: { label: '/say', color: 'var(--series-2)' },
  emote: { label: '/me', color: 'var(--series-2)' },
  death: { label: 'Died', color: 'var(--critical)' },
  advancement: { label: 'Advancement', color: 'var(--warning)' },
};

function starPath(cx, cy, r) {
  let d = '';
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    d += `${i ? 'L' : 'M'}${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`;
  }
  return `${d}Z`;
}

let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const [root, redraw] of redraws) {
      if (!root.isConnected) redraws.delete(root);
      else if (root.offsetParent && !tweens.has(root)) redraw();
    }
  }, 120);
}).observe(document.body);

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function withAlpha(hex, a) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/* ---------- time windows ---------- */

// A chart's window is `count` units ending at `end`, where end = null follows "now" (live).
//   unit 'sec'  — end is a timestamp
//   unit 'hour' — end is an hour boundary (exclusive); one bucket per hour
//   unit 'day'  — end is the last date shown (YYYY-MM-DD); one bucket per local day
// preset is the matching preset key, or 'custom'.

function zonedParts(ts) {
  const p = {};
  const f = formatter({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (const { type, value } of f.formatToParts(ts * 1000)) p[type] = value;
  return p;
}

// Timestamp of a wall-clock time in the dashboard's time zone.
function zonedTs(date, hour = 0, minute = 0) {
  const [y, mo, d] = date.split('-').map(Number);
  const want = Date.UTC(y, mo - 1, d, hour, minute) / 1000;
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(t);
    const got = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) / 1000;
    if (got === want) break;
    t += want - got;
  }
  return t;
}

// 'YYYY-MM-DDTHH:MM' for <input type="datetime-local">, in the dashboard's time zone.
function localInput(ts) {
  const p = zonedParts(ts);
  return `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, '0')}:${p.minute}`;
}

const currentHourEnd = () => (Math.floor(nowSec() / 3600) + 1) * 3600;

function resolveWindow(w) {
  if (w.unit === 'all') return { from: state.dataStart ?? 0, to: nowSec(), live: true };
  if (w.unit === 'day') {
    const last = w.end ?? todayStr();
    const buckets = [];
    for (let d = addDays(last, -(w.count - 1)); d <= last; d = addDays(d, 1)) {
      buckets.push({ key: d, date: d, start: zonedTs(d), end: zonedTs(addDays(d, 1)) });
    }
    return { from: buckets[0].start, to: buckets.at(-1).end, live: w.end == null, buckets };
  }
  if (w.unit === 'hour') {
    const to = w.end ?? currentHourEnd();
    const buckets = [];
    for (let i = w.count; i > 0; i--) {
      const start = to - i * 3600;
      buckets.push({ key: start, start, end: start + 3600, date: hourInfo(start).date });
    }
    return { from: buckets[0].start, to, live: w.end == null, buckets };
  }
  const to = w.end ?? nowSec();
  return { from: to - w.count, to, live: w.end == null };
}

function shiftWindow(w, dir) {
  if (w.unit === 'all') return w;
  if (w.byDay) {
    // live 24h -> yesterday -> the day before ...; stepping forward past yesterday returns to live 24h
    const last = w.unit === 'day' ? addDays(w.end, dir) : dir < 0 ? addDays(todayStr(), -1) : null;
    if (last == null || last >= todayStr()) return { unit: 'sec', count: 86400, end: null, preset: w.preset, byDay: true };
    return { unit: 'day', count: 1, end: last, preset: w.preset, byDay: true };
  }
  if (w.unit === 'day') {
    const last = addDays(w.end ?? todayStr(), dir * w.count);
    return { ...w, end: last >= todayStr() ? null : last };
  }
  const size = w.unit === 'hour' ? w.count * 3600 : w.count;
  const end = resolveWindow(w).to + dir * size;
  // the clock moves between clicks, so "within a couple of minutes of now" counts as now
  const liveEnd = w.unit === 'hour' ? currentHourEnd() : nowSec() - 120;
  return { ...w, end: end >= liveEnd ? null : end };
}

const presetWindow = (p) => ({ unit: p.unit, count: p.count, end: null, preset: p.v, ...(p.byDay && { byDay: true }) });
const windowKey = (w) => `${w.unit}:${w.count}:${w.end ?? 'live'}`;
const matchPreset = (presets, unit, count) => presets.find((p) => p.unit === unit && p.count === count)?.v ?? 'custom';

function windowLabel(w, r, presets) {
  const p = presets.find((x) => x.v === w.preset);
  if (r.live && p) return archived() ? finalLabel(p.long) : p.long;
  const md = { month: 'short', day: 'numeric' };
  if (w.unit === 'day') {
    const first = r.buckets[0].date, last = r.buckets.at(-1).date;
    return first === last ? fmtDay(first, md) : `${fmtDay(first, md)} – ${fmtDay(last, md)}`;
  }
  const full = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const start = fmt(r.from, full);
  if (r.live) return `${start} – ${archived() ? 'end' : 'now'}`;
  const sameDay = hourInfo(r.from).date === hourInfo(r.to - 1).date;
  return `${start} – ${fmt(r.to, sameDay ? { hour: 'numeric', minute: '2-digit' } : full)}`;
}

// In a finished season, "Last 7 days" are its final 7 days.
const finalLabel = (s) => (s === 'Today' ? 'Final day' : s.replace(/^Last /, 'Final '));

const TL_PRESETS = [
  { v: '6h', label: '6h', unit: 'sec', count: 6 * 3600, long: 'Last 6 hours' },
  // Live it's the last 24 hours; stepping back pages through whole days (midnight to midnight).
  { v: '24h', label: '24h', unit: 'sec', count: 86400, long: 'Last 24 hours', byDay: true },
  { v: '7d', label: '7d', unit: 'sec', count: 7 * 86400, long: 'Last 7 days' },
  { v: '30d', label: '30d', unit: 'sec', count: 30 * 86400, long: 'Last 30 days' },
  { v: '90d', label: '90d', unit: 'sec', count: 90 * 86400, long: 'Last 90 days' },
];
const dayPreset = (n) => ({ v: `${n}d`, label: `${n}d`, unit: 'day', count: n, long: `Last ${n} days` });
const DAILY_PRESETS = [7, 14, 30, 90].map(dayPreset);
const PLAYER_PRESETS = [
  { v: '6h', label: '6h', unit: 'hour', count: 6, long: 'Last 6 hours' },
  { v: '24h', label: '24h', unit: 'hour', count: 24, long: 'Last 24 hours' },
  ...[7, 14, 30].map(dayPreset),
];

// Custom ranges from the date picker. Each returns a window, or an error message.
function pickSeconds(presets) {
  return (from, to) => {
    if (to - from < 600) return 'Pick a range of at least 10 minutes.';
    const count = to - from;
    return { unit: 'sec', count, end: to >= nowSec() - 90 ? null : to, preset: matchPreset(presets, 'sec', count) };
  };
}

function pickDays(presets) {
  return (fromDate, toDate) => {
    const today = todayStr();
    const last = toDate > today ? today : toDate;
    if (fromDate > last) return 'The start date must be on or before the end date.';
    let count = 0;
    for (let d = fromDate; d <= last; d = addDays(d, 1)) count++;
    if (count > 366) return 'Pick a range of a year or less.';
    return { unit: 'day', count, end: last >= today ? null : last, preset: matchPreset(presets, 'day', count) };
  };
}

// Player chart: up to two days shows hourly bars, longer ranges daily bars.
function pickPlayerRange(from, to) {
  if (to <= from) return 'The end must be after the start.';
  if (to - from <= 48 * 3600) {
    const start = Math.floor(from / 3600) * 3600;
    const end = Math.ceil(to / 3600) * 3600;
    const count = (end - start) / 3600;
    return { unit: 'hour', count, end: end >= currentHourEnd() ? null : end, preset: matchPreset(PLAYER_PRESETS, 'hour', count) };
  }
  return pickDays(PLAYER_PRESETS)(hourInfo(from).date, hourInfo(to - 1).date);
}

/* ---------- range control: [calendar] [presets | Custom] [‹] [›] ---------- */

function icon(paths, size = 16) {
  const s = sv('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  for (const d of paths) s.append(sv('path', { d }));
  return s;
}
const calendarIcon = () => icon(['M2.5 4.5h11v9h-11z', 'M2.5 7.5h11', 'M5.5 2.5v3', 'M10.5 2.5v3']);
const chevronIcon = (dir) => icon([dir < 0 ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5']);

// picker: 'datetime' | 'date'. fromPicker(a, b) turns picked values into a window (or an error string).
function rangeControl(host, { presets, picker, fromPicker, onChange }) {
  let w = null;
  let pop = null;

  const cal = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Choose a date range', title: 'Choose a date range' }, calendarIcon());
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' });
  const presetBtns = presets.map((p) => {
    const b = el('button', { type: 'button', text: p.label });
    b.addEventListener('click', () => set(presetWindow(p), true));
    seg.append(b);
    return [p.v, b];
  });
  const custom = el('button', { type: 'button', text: 'Custom', hidden: '' });
  custom.addEventListener('click', () => toggle());
  seg.append(custom);
  const prev = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Earlier', title: 'Earlier' }, chevronIcon(-1));
  const next = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Later', title: 'Later' }, chevronIcon(1));
  prev.addEventListener('click', () => set(shiftWindow(w, -1), true, -1));
  next.addEventListener('click', () => set(shiftWindow(w, 1), true, 1));
  cal.addEventListener('click', () => toggle());
  host.replaceChildren(cal, seg, prev, next);

  // Re-check button states; time passing can change what's possible.
  function sync() {
    for (const [v, b] of presetBtns) b.setAttribute('aria-pressed', String(w?.preset === v));
    custom.hidden = w?.preset !== 'custom';
    custom.setAttribute('aria-pressed', String(w?.preset === 'custom'));
    if (!w) return;
    next.disabled = w.end == null;
    prev.disabled = state.dataStart != null && resolveWindow(w).from <= state.dataStart;
  }

  // dir: -1 / 1 when stepping with ‹ ›, so charts can scroll that way
  function set(nw, notify, dir = 0) {
    const prev = w;
    w = nw;
    close();
    sync();
    if (notify) onChange(w, dir, prev);
  }

  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey);
  }
  function onOutside(e) {
    if (!host.contains(e.target)) close();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  function toggle() {
    if (pop) return close();
    const r = resolveWindow(w);
    const dates = picker === 'date';
    const type = dates ? 'date' : 'datetime-local';
    const now = nowSec();
    const max = dates ? todayStr() : localInput(now);
    const min = state.dataStart ? (dates ? hourInfo(state.dataStart).date : localInput(state.dataStart)) : null;
    const fromIn = el('input', { type, max, min, value: dates ? r.buckets[0].date : localInput(r.from) });
    const toIn = el('input', { type, max, min, value: dates ? r.buckets.at(-1).date : localInput(Math.min(r.to, now)) });
    const error = el('div', { class: 'range-error', role: 'alert', hidden: '' });
    const apply = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Apply' });
    const cancel = el('button', { type: 'button', class: 'btn', text: 'Cancel' });
    cancel.addEventListener('click', close);

    pop = el('form', { class: 'range-pop', 'aria-label': 'Choose a date range' },
      el('label', {}, el('span', { text: 'From' }), fromIn),
      el('label', {}, el('span', { text: 'To' }), toIn),
      error,
      el('div', { class: 'range-actions' }, cancel, apply)
    );
    pop.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!fromIn.value || !toIn.value) {
        error.textContent = 'Pick both a start and an end.';
        error.hidden = false;
        return;
      }
      const parse = (v) => {
        if (dates) return v;
        const [d, t] = v.split('T');
        const [h, mi] = t.split(':').map(Number);
        return zonedTs(d, h, mi);
      };
      const res = fromPicker(parse(fromIn.value), parse(toIn.value));
      if (typeof res === 'string') {
        error.textContent = res;
        error.hidden = false;
        return;
      }
      set(res, true);
    });
    host.append(pop);
    fromIn.focus();
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey);
  }

  return { get: () => w, set: (nw) => set(nw, false), sync };
}

/* ---------- app state ---------- */

const state = {
  status: null,
  hourly: [], // [hour_ts, samples, up_samples, online_sum, peak]
  hourlyFrom: 0, // state.hourly covers hourlyFrom..now
  snaps: { since: 0, rows: [] }, // cached minute rows [ts, up, online] from `since` to now
  dataStart: null, // first recorded check (unix seconds)
  rangesChosen: false,
};

const HOURLY_DAYS = 92; // longest range anything on the page needs
const LB_PRESETS = [
  { v: '1d', label: '1d', unit: 'day', count: 1, long: 'Today' },
  { v: '24h', label: '24h', unit: 'sec', count: 86400, long: 'Last 24 hours' },
  { v: '7d', label: '7d', unit: 'sec', count: 7 * 86400, long: 'Last 7 days' },
  { v: 'all', label: 'All', unit: 'all', count: 0, long: 'All time' },
];

const dataSpan = () => (state.dataStart ? nowSec() - state.dataStart : 0);

// Default ranges: the smallest preset that shows all the data.
const presetByKey = (presets, v) => presets.find((p) => p.v === v);

function fittingTimelineWindow() {
  return presetWindow(presetByKey(TL_PRESETS, '24h'));
}

function daysCovered(since) {
  if (!since) return 1;
  let n = 0;
  for (let d = hourInfo(since).date, today = todayStr(); d <= today && n < 400; d = addDays(d, 1)) n++;
  return n;
}

function fittingDailyWindow() {
  const n = daysCovered(state.dataStart);
  return presetWindow(DAILY_PRESETS.find((p) => n <= p.count) || DAILY_PRESETS.at(-1));
}

const playerDefaultWindow = () => presetWindow(presetByKey(PLAYER_PRESETS, '24h'));

// Smallest leaderboard range that covers all the data.
// Smallest preset that covers all the data; wider ones get the red "Data starts on" note.
function fittingLeaderboardRange() {
  const span = dataSpan();
  return LB_PRESETS.find((p) => p.unit === 'all' || (p.unit === 'sec' && span <= p.count));
}

const defaultLeaderboardRange = () => presetByKey(LB_PRESETS, archived() ? 'all' : '1d');

function showError(msg) {
  const e = $('#error');
  e.textContent = msg;
  e.hidden = !msg;
}

/* ---------- live status ---------- */

// The server stops while nobody's on; the mod's last word before that is "Server stopped".
function pausedSince() {
  const st = state.status;
  const ev = st?.server_event;
  if (ev?.text !== 'Server stopped' || (st.last?.up && st.last.online > 0)) return null;
  return Math.floor(ev.ts / 1000);
}

function renderLive() {
  const st = state.status;
  const live = $('#live');
  const text = $('#live-text');
  const last = st.last;
  const paused = pausedSince();
  live.title = paused ? `Server stopped ${ago(paused)}` : '';
  if (archived()) {
    live.dataset.state = 'archived';
    text.textContent = `Ended ${fmt(clockStop, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    live.title = `Season ${SEASON} is over. This is how it ended.`;
  } else if (st.season && !st.season.started) {
    live.dataset.state = 'none';
    text.textContent = 'Not started';
  } else if (!last) {
    live.dataset.state = 'none';
    text.textContent = 'Waiting for first check';
  } else if (paused) {
    live.dataset.state = 'paused';
    text.textContent = 'Paused';
  } else if (nowSec() - last.ts > 300) {
    live.dataset.state = 'none';
    text.textContent = `No data since ${ago(last.ts)}`;
  } else if (!last.up) {
    live.dataset.state = 'down';
    text.textContent = 'Server offline';
  } else {
    live.dataset.state = 'up';
    text.textContent = `${last.online} online`;
  }

  const zone = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' })
    .formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value || TZ;
  $('#foot').replaceChildren(
    `Times in ${zone}`
      + (archived() ? ` · Season ${SEASON} archive` : last ? ` · updated ${fmt(last.ts, { hour: 'numeric', minute: '2-digit' })}` : '')
      + (DUMMY ? ' · sample data' : '') + ' · ',
    SEASON === CURRENT_SEASON
      ? el('a', { href: '/s1/', text: 'Season 1 archive' })
      : el('a', { href: '/', text: 'Current season' }));
  renderSeasonNote();
}

const seasonSpan = () => {
  const day = { month: 'short', day: 'numeric', year: 'numeric' };
  return state.dataStart ? `${fmt(state.dataStart, day)} – ${fmt(nowSec(), day)}` : '';
};

// The line at the top: sample data, no data yet this season, or which season's archive this is.
function renderSeasonNote() {
  const note = $('#season-note');
  const st = state.status;
  let kids = null;
  if (DUMMY) {
    kids = [el('strong', { text: 'Sample data.' }), ' This activity is made up, to show how the page looks. The chat log is left empty. ',
      el('a', { href: '/', text: 'Show real data' })];
  } else if (st && SEASON === CURRENT_SEASON && !st.data_start) {
    const s = st.season;
    const when = s?.start && !s.started
      ? ` It starts ${fmt(s.start, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : '';
    kids = [el('strong', { text: `No Season ${SEASON} data yet.` }), `${when} `,
      el('a', { href: `/s${SEASON - 1}/`, text: `See Season ${SEASON - 1}’s archived stats →` })];
  } else if (st && SEASON === CURRENT_SEASON && seasonOpens() && nowSec() < seasonOpens()) {
    kids = [el('strong', { text: `Season ${SEASON} starts ${fmt(seasonOpens(), { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` })];
  } else if (st && SEASON < CURRENT_SEASON && !$('#view-home').hidden) {
    kids = [el('strong', { text: `Season ${SEASON} archive` }),
      archived() ? ` · ${seasonSpan()}. ` : ` · still recording until Season ${SEASON + 1} starts. `,
      el('a', { href: SEASON + 1 === CURRENT_SEASON ? '/' : `/s${SEASON + 1}/`, text: `Go to Season ${SEASON + 1} →` })];
  }
  note.classList.toggle('dummy', DUMMY);
  note.hidden = !kids;
  if (kids) note.replaceChildren(...kids);
}

function makeChip(p) {
  knownNames.set(p.uuid, p.name);
  const chip = playerLink(el('a', { class: 'chip', title: otherName(p.name) },
    headImg(p.name, 24),
    colorName(el('span', { class: 'chip-name', text: shownName(p.name) }), p.uuid, p.name),
    el('span', { class: 'since', text: `since ${fmt(p.start_ts, { hour: 'numeric', minute: '2-digit' })}` })
  ), p.uuid, p.name);
  chip.addEventListener('focus', () => prefetchPlayer(p.uuid));
  return chip;
}

// The player disintegrates into the page in pixels, then the gap closes.
function removeChip(chip, bg) {
  chip.classList.add('leaving');
  const list = chip.parentNode;
  const muted = [cssVar('--ink-2'), cssVar('--muted'), cssVar('--axis')];
  pixelTiles({
    host: list, target: chip, mode: 'cover', color: cssVar(bg),
    tile: 3, pad: 2, duration: 700, sweep: 0.6,
    spark: { chance: 0.12, colors: muted, vx: [10, 50], vy: [-35, -5], life: [400, 800], size: [1, 2] },
    onDone: () => {
      chip.style.width = `${chip.offsetWidth}px`;
      chip.classList.add('collapsing');
      requestAnimationFrame(() => chip.classList.add('collapsed'));
      setTimeout(() => chip.remove(), 260);
    },
  });
}

// Keeps a row of chips in step with who's online; on live updates players pop in and pixel out.
// bg: the color behind the row, which leaving chips dissolve into.
function syncChips(list, players, bg = '--page') {
  const animate = live();
  const current = new Map([...list.querySelectorAll('.chip:not(.leaving)')].map((c) => [c.dataset.uuid, c]));
  const wanted = new Set(players.map((p) => p.uuid));

  for (const [uuid, chip] of current) {
    if (wanted.has(uuid)) continue;
    if (animate) removeChip(chip, bg);
    else chip.remove();
  }
  for (const p of players) {
    const existing = current.get(p.uuid);
    if (existing) {
      colorName(existing.querySelector('.chip-name'), p.uuid, p.name).textContent = shownName(p.name);
      if (otherName(p.name)) existing.title = otherName(p.name);
      else existing.removeAttribute('title');
      continue;
    }
    const chip = makeChip(p);
    list.append(chip);
    if (animate) chip.classList.add('chip-enter');
  }
}

function renderOnlineChips() {
  syncChips($('#online-list'), archived() ? [] : state.status.online);
  const warn = $('#sample-warning');
  const last = state.status.last;
  if (!archived() && last && last.up && last.online > last.listed) {
    warn.replaceChildren(
      `The server reports ${last.online} players but only lists ${last.listed} by name, so some playtime isn't being counted. `,
      'Installing mcstats-chat 1.7.0 or newer on the server gives the full list (the mod reports everyone in the tab list).'
    );
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}

/* ---------- home ---------- */

function renderTiles() {
  const st = state.status;
  if (archived()) return renderArchiveTiles();
  const last = st.last;
  const fresh = last && nowSec() - last.ts <= 300;
  const animate = live();
  setCounter($('#t-online'), fresh ? (last.up ? String(last.online) : 'Offline') : '–', fresh && last.up ? last.online : null, animate);
  $('#t-online-sub').textContent = fresh && last.up && last.max ? `of ${last.max} slots` : fresh ? '' : 'no recent data';

  const today = todayStr();
  const weekAgo = nowSec() - 7 * 86400;
  let peak = 0, weekMinutes = 0;
  for (const [ts, , , sum, pk] of state.hourly) {
    if (hourInfo(ts).date === today) peak = Math.max(peak, pk);
    if (ts >= weekAgo) weekMinutes += sum;
  }
  setCounter($('#t-peak'), String(peak), peak, animate);
  setCounter($('#t-week'), fmtHours(weekMinutes / 60), weekMinutes, animate);
  setCounter($('#t-players'), st.players_total.toLocaleString(), st.players_total, animate);
}

// A finished season: how long it ran, its busiest moment and its total.
function renderArchiveTiles() {
  const st = state.status;
  const days = state.dataStart ? daysCovered(state.dataStart) : 0;
  $('#t-online-label').textContent = 'Season length';
  setCounter($('#t-online'), `${days} ${days === 1 ? 'day' : 'days'}`, null, false);
  $('#t-online-sub').textContent = seasonSpan();
  $('#t-peak-label').textContent = 'Peak';
  setCounter($('#t-peak'), String(st.peak_ever), st.peak_ever, false);
  let minutes = 0;
  for (const [, , , sum] of state.hourly) minutes += sum;
  $('#t-week-label').textContent = 'Total played';
  setCounter($('#t-week'), fmtHours(minutes / 60), minutes, false);
  $('#t-week-sub').textContent = 'player-hours, whole season';
  setCounter($('#t-players'), st.players_total.toLocaleString(), st.players_total, false);
}

async function renderServerDaily(animate = false, slide = 0) {
  const w = dailyCtl.get();
  const r = resolveWindow(w);
  dailyCtl.sync();
  $('#daily-label').textContent = `player-hours per day · ${windowLabel(w, r, DAILY_PRESETS)}`;
  const rows = await getHourlyRange(r.from, r.to);
  if (dailyCtl.get() !== w) return; // another range was picked meanwhile
  const index = new Map(r.buckets.map((b, i) => [b.date, i]));
  const vals = r.buckets.map(() => 0);
  const peaks = r.buckets.map(() => 0);
  for (const [ts, , , sum, pk] of rows) {
    const i = index.get(hourInfo(ts).date);
    if (i === undefined) continue;
    vals[i] += sum / 60;
    peaks[i] = Math.max(peaks[i], pk);
  }
  const teams = await teamHoursPerBucket(r.buckets).catch(() => null);
  if (dailyCtl.get() !== w) return;
  // each team's share of the bar. The bar's height is the server's player count, which can run a little past
  // the time of the players it names (it doesn't always list everyone), so the teams fill it in proportion.
  const split = teams && r.buckets.map((b, i) => {
    const whole = teams.red[i] + teams.blue[i];
    return whole > 0 ? { red: teams.red[i] / whole, blue: teams.blue[i] / whole } : { red: 0, blue: 0 };
  });
  const teamRow = (team, i) => ({ value: fmtHours(teams[team][i]), label: TEAM_NAMES[team], color: `var(--team-${team})` });
  renderBars($('#heatmap'), {
    buckets: r.buckets, vals, windowKey: windowKey(w), labels: 'day', split,
    fmtTick: (v) => `${v}h`, dataStart: chartStart(),
    describe: (i) => [
      { value: vals[i] ? `${fmtHours(vals[i])} player-hours` : 'No activity' },
      ...(teams && vals[i] ? [teamRow('red', i), teamRow('blue', i)] : []),
      { label: `${fmtDay(r.buckets[i].date)}${peaks[i] ? ` · peak ${peaks[i]} online` : ''}` },
    ],
  }, { animate, slide });
}

// Hours each team played in every bucket ({ start, end }, in order), from everyone's sessions.
// null when the season has no teams.
async function teamHoursPerBucket(buckets) {
  if (!roster.size || !buckets.length) return null;
  const from = buckets[0].start, to = buckets[buckets.length - 1].end;
  // asked for up to now in ten-minute steps, so today's bar keeps up without a request per redraw
  const r = await memoApi(`/api/sessions?from=${from}&to=${Math.min(to, Math.ceil(nowSec() / 600) * 600)}`);
  const out = { red: buckets.map(() => 0), blue: buckets.map(() => 0) };
  const stop = Math.min(to, nowSec());
  for (const [, name, a0, b0] of r.rows) {
    const team = out[rosterOf(name)?.team];
    if (!team) continue;
    const a = Math.max(from, a0), b = Math.min(stop, b0 + r.poll_seconds);
    for (let i = 0; i < buckets.length && buckets[i].start < b; i++) {
      const over = Math.min(b, buckets[i].end) - Math.max(a, buckets[i].start);
      if (over > 0) team[i] += over / 3600;
    }
  }
  return out;
}

// Busiest times for everyone, one team, or both teams blended (red and blue mixed by their share).
const HEAT_MODES = ['all', 'red', 'blue', 'mix'];
let heatTeam = HEAT_MODES.includes(recall('heatTeam')) ? recall('heatTeam') : 'all';
let heatToken = 0;

function syncHeatToggle() {
  const t = $('#heat-team');
  t.hidden = !roster.size;
  for (const b of t.children) b.setAttribute('aria-pressed', String(b.dataset.v === heatTeam));
}

// Seconds each team spent online in every weekday-hour of [from, to), from everyone's sessions.
async function teamSeconds(from, to) {
  const r = await memoApi(`/api/sessions?from=${from}&to=${to}`);
  const secs = { red: emptyWeek(), blue: emptyWeek() };
  for (const [, name, a0, b0] of r.rows) {
    const team = secs[rosterOf(name)?.team];
    if (!team) continue;
    const b = Math.min(to, b0 + r.poll_seconds);
    for (let t = Math.max(from, a0); t < b;) {
      const end = Math.min(b, Math.floor(t / 3600) * 3600 + 3600);
      const { dow, hour } = hourInfo(t);
      team[dow][hour] += end - t;
      t = end;
    }
  }
  return secs;
}
const emptyWeek = () => Array.from({ length: 7 }, () => Array(24).fill(0));
const fmtAvg = (v) => v.toFixed(v < 10 ? 1 : 0);

async function renderServerWeekGrid() {
  const token = ++heatToken;
  const mode = roster.size ? heatTeam : 'all';
  const root = $('#weekgrid');
  syncHeatToggle();
  // Hours are whole so the sessions request stays the same (and cached) until the next hour.
  const now = nowSec();
  const to = mode === 'all' ? Infinity : Math.floor(now / 3600) * 3600;
  let since = archived() ? 0 : now - 90 * 86400;
  if (mode !== 'all') since = Math.floor(Math.max(since, (archived() ? now : to) - 119 * 86400, state.dataStart || 0) / 3600) * 3600;
  const sum = emptyWeek();
  const cnt = emptyWeek();
  for (const [ts, samples, , s] of state.hourly) {
    if (ts < since || ts >= to) continue;
    const { dow, hour } = hourInfo(ts);
    sum[dow][hour] += s;
    cnt[dow][hour] += samples;
  }
  const per = (g) => g.map((row, d) => row.map((v, h) => (cnt[d][h] ? v / cnt[d][h] : 0)));
  const span = archived() ? 'whole season' : 'last 90 days';
  root.className = mode === 'red' || mode === 'blue' ? `heat-${mode}` : '';

  if (mode === 'all') {
    renderWeekGrid(root, per(sum), (v, label) => [
      { value: `${fmtAvg(v)} players`, label: 'avg' },
      { label: `${label} · ${span}` },
    ], { animate: live() });
    return;
  }

  const secs = await teamSeconds(since, to);
  if (token !== heatToken) return; // the mode changed or a newer render started meanwhile
  // a player online for a whole hour shows up in every check of it, so seconds / POLL = their samples
  const red = per(secs.red.map((row) => row.map((v) => v / POLL)));
  const blue = per(secs.blue.map((row) => row.map((v) => v / POLL)));
  const tip = (rows, label) => [...rows, { label: `${label} · ${span}` }];
  const teamRow = (team, v) => ({ color: `var(--team-${team})`, value: `${fmtAvg(v)} ${team}`, label: 'avg' });

  if (mode !== 'mix') {
    const grid = mode === 'red' ? red : blue;
    renderWeekGrid(root, grid, (v, label) => tip([teamRow(mode, v)], label), { animate: live() });
    return;
  }

  // Blended: the hue is the red/blue share, the strength is how many are on in all (in five steps, like the others).
  const both = red.map((row, d) => row.map((v, h) => v + blue[d][h]));
  const max = Math.max(0, ...both.flat());
  const STRENGTH = [0, 30, 55, 78, 100];
  const mixColor = (pRed, strength) => `color-mix(in oklab, color-mix(in oklch, var(--team-red) ${pRed}%, var(--team-blue)) ${strength}%, var(--lv0))`;
  const legend = el('div', { class: 'scale' }, el('span', { class: 'lbl', text: 'Red' }));
  for (const p of [100, 75, 50, 25, 0]) legend.append(el('span', { class: 'sw', style: `background:${mixColor(p, 100)}` }));
  legend.append(el('span', { class: 'lbl', text: 'Blue' }));
  renderWeekGrid(root, both, (v, label, d, h) => tip([teamRow('red', red[d][h]), teamRow('blue', blue[d][h])], label), {
    animate: live(),
    legend,
    cellColor: (d, h) => {
      const v = both[d][h];
      if (v <= 0 || max <= 0) return 'var(--lv0)';
      return mixColor(Math.round((red[d][h] / v) * 100), STRENGTH[Math.min(4, Math.ceil((v / max) * 4))]);
    },
  });
}

// Centered moving average over `window` seconds, at the same timestamps as pts.
function rollingAverage(pts, window) {
  const half = window / 2;
  const out = [];
  let lo = 0, hi = 0, sum = 0;
  for (const p of pts) {
    while (hi < pts.length && pts[hi].t <= p.t + half) sum += pts[hi++].v;
    while (pts[lo].t < p.t - half) sum -= pts[lo++].v;
    out.push({ t: p.t, v: sum / (hi - lo) });
  }
  return out;
}

async function loadTimeline(slide = 0) {
  const w = tlCtl.get();
  const r = resolveWindow(w);
  const { from, to } = r;
  tlCtl.sync();
  $('#tl-label').textContent = windowLabel(w, r, TL_PRESETS);
  const c1 = 'var(--series-1)';
  const c2 = 'var(--series-2)';
  const c3 = 'var(--series-3)';
  const legend = $('#tl-legend');
  const key = (color, text) => el('span', {}, el('span', { class: 'key', style: `background:${color}` }), text);
  let opts;

  const minuteData = to - from <= 8 * 86400;
  const [rows, sessionsRes] = await Promise.all([
    minuteData
      ? (r.live ? loadSnapshots(from) : memoApi(`/api/snapshots?from=${from}&to=${to}`).then((x) => x.rows))
      : getHourlyRange(from, to),
    r.live ? api(`/api/sessions?from=${from}&to=${to}`) : memoApi(`/api/sessions?from=${from}&to=${to}`),
  ]);
  if (tlCtl.get() !== w) return; // another range was picked meanwhile
  const sessions = sessionsRes.rows.map(([, name, a, b]) => [name, a, b + sessionsRes.poll_seconds]);
  // names online at t (minute data), or at any point in the hour starting at t (hourly data)
  const whoAt = (t) => {
    const end = minuteData ? t + 1 : t + 3600;
    return [...new Set(sessions.filter(([, a, b]) => a < end && b > t).map(([name]) => name))];
  };

  if (minuteData) {
    const pts = rows.map(([t, up, v]) => ({ t, v, down: !up }));
    const series = [{ name: 'online', cls: '1', color: c1, area: true, pts }];
    // Trend line (1-hour average) for ranges longer than 6h.
    const trend = to - from > 6 * 3600 + 60;
    if (trend) series.push({ name: 'avg (1 hour)', cls: '2', color: c2, pts: rollingAverage(pts, 3600) });
    opts = {
      from, to, step: POLL, series, whoAt,
      fmtValue: (v) => (Number.isInteger(v) ? `${v} ${v === 1 ? 'player' : 'players'}` : v.toFixed(1)),
      fmtTime: (t) => fmt(t, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    };
    legend.replaceChildren(...(trend && pts.length ? [key(c1, 'Players online'), key(c2, 'Average online (1 hour)')] : []));
  } else {
    const rows = await getHourlyRange(from, to);
    if (tlCtl.get() !== w) return;
    opts = {
      from, to, step: 3600,
      series: [
        { name: 'average', cls: '1', color: c1, area: true, pts: rows.map(([t, n, , s]) => ({ t, v: n ? s / n : 0 })) },
        { name: 'peak', cls: '3', color: c3, pts: rows.map(([t, , , , pk]) => ({ t, v: pk })) },
      ],
      whoAt,
      fmtValue: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
      fmtTime: (t) => `${fmt(t, { weekday: 'short', month: 'short', day: 'numeric' })}, ${hourName(hourInfo(t).hour)}`,
    };
    legend.replaceChildren(key(c1, 'Average online'), key(c3, 'Peak online'));
  }
  opts.key = windowKey(w);
  opts.dataStart = chartStart();
  opts.yMin = state.status?.peak_ever; // same scale on every range: up to the most ever online
  renderLineChart($('#timeline'), opts, { animate: live(), slide });
}

const lbRowsBySize = new Map(); // range size -> most rows seen
const ROW_MOVE_MS = 380;

function reserveRows(root, n) {
  const row = root.querySelector('tbody tr');
  const head = root.querySelector('thead');
  const rowH = row ? row.getBoundingClientRect().height : 39;
  const headH = head ? head.getBoundingClientRect().height : 24;
  root.style.minHeight = `${Math.ceil(headH + n * rowH)}px`;
}

function rowTops(root) {
  const tops = new Map();
  for (const tr of root.querySelectorAll('tr[data-uuid]')) {
    const b = tr.querySelector('.bar');
    tops.set(tr.dataset.uuid, { top: tr.getBoundingClientRect().top, bar: b?.style.width });
  }
  return tops;
}

// Rows glide from where they were to their new rank; newcomers fade in; bars stretch to their new length.
function moveRows(root, oldTops) {
  if (reducedMotion() || !oldTops.size) return false;
  const ease = 'cubic-bezier(0.2, 0.8, 0.3, 1)';
  let moved = false;
  root.querySelectorAll('tr[data-uuid]').forEach((tr, i) => {
    const old = oldTops.get(tr.dataset.uuid);
    if (!old) {
      tr.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
        { duration: ROW_MOVE_MS, delay: Math.min(i, 10) * 15, easing: ease, fill: 'backwards' });
      return;
    }
    const dy = old.top - tr.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) {
      moved = true;
      tr.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: ROW_MOVE_MS, easing: ease });
    }
    const bar = tr.querySelector('.bar');
    if (bar && old.bar && old.bar !== bar.style.width) {
      bar.animate([{ width: old.bar }, { width: bar.style.width }], { duration: ROW_MOVE_MS, easing: ease });
    }
  });
  return moved;
}

// "Data starts on …" beside the heading; red with a warning icon when the range reaches back before it.
function renderLeaderboardNote() {
  const note = $('#lb-note');
  if (!state.dataStart) {
    note.replaceChildren();
    return;
  }
  const w = lbCtl.get();
  const r = resolveWindow(w);
  const fit = fittingLeaderboardRange();
  // Red when the range is wider than the smallest preset that covers all the data and reaches back before it.
  const warn = w.unit === 'all'
    ? fit.unit !== 'all'
    : fit.unit !== 'all' && r.from < state.dataStart && r.to - r.from > fit.count;
  const start = el('span', { class: `data-note${warn ? ' warn' : ''}`, text: `Data starts on ${fmt(state.dataStart, { month: 'short', day: 'numeric' })}` });
  if (warn) start.title = 'This range reaches back further than the data does, so totals cover less time than it suggests.';
  note.replaceChildren(`${windowLabel(w, r, LB_PRESETS)} · `, start);
}

async function loadLeaderboard() {
  const w = lbCtl.get();
  const win = resolveWindow(w);
  lbCtl.sync();
  renderLeaderboardNote();
  const from = w.unit === 'all' ? 1 : win.from;
  const path = `/api/leaderboard?from=${from}&to=${win.to}`;
  const r = win.live ? await api(path) : await memoApi(path);
  const root = $('#leaderboard');
  // Keep the card as tall as the most rows seen for this range size, so paging doesn't make the page jump.
  const sizeKey = `${w.unit}:${w.count}`;
  const rows = Math.min(25, r.players.length);
  const reserve = Math.max(rows, lbRowsBySize.get(sizeKey) || 0);
  lbRowsBySize.set(sizeKey, reserve);
  const oldTops = rowTops(root);
  if (!r.players.length) {
    root.replaceChildren(el('div', { class: 'empty', text: 'Nobody seen in this range yet.' }));
    reserveRows(root, reserve);
    return;
  }
  const top = r.players[0].secs || 1;
  const onlineNow = new Set(archived() ? [] : state.status.online.map((p) => p.uuid));
  const prev = state.lbPrev?.range === windowKey(w) ? state.lbPrev.secs : null;
  state.lbPrev = { range: windowKey(w), secs: new Map(r.players.map((p) => [p.uuid, p.secs])) };
  const changed = [];
  const tbody = el('tbody');
  r.players.slice(0, 25).forEach((p, i) => {
    const link = teamName(el('a', { href: `#/player/${p.uuid}`, text: shownName(p.name) }), p.name);
    const tr = el('tr', { class: 'link', 'data-uuid': p.uuid },
      el('td', { class: 'rank', text: String(i + 1) }),
      el('td', {},
        el('div', { class: 'pname' }, headImg(p.name, 22), link),
        el('div', { class: `bar${rosterOf(p.name) ? ` team-${rosterOf(p.name).team}` : ''}`, style: `width:${Math.max(1, (p.secs / top) * 100)}%` })
      ),
      el('td', { class: 'num', text: dur(p.secs) }),
      el('td', { class: 'num muted hide-sm', text: onlineNow.has(p.uuid) ? 'online' : ago(p.last_seen) })
    );
    tr.addEventListener('click', (e) => { if (e.target !== link) location.hash = `#/player/${p.uuid}`; });
    tr.addEventListener('pointerenter', () => prefetchPlayer(p.uuid));
    link.addEventListener('focus', () => prefetchPlayer(p.uuid));
    knownNames.set(p.uuid, p.name);
    tbody.append(tr);
    if (prev && prev.get(p.uuid) !== p.secs) changed.push(tr);
  });
  root.replaceChildren(el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}), el('th', { text: 'Player' }), el('th', { class: 'num', text: 'Played' }), el('th', { class: 'num hide-sm', text: 'Last seen' })
    )),
    tbody
  ));
  reserveRows(root, reserve);
  const moved = moveRows(root, oldTops);

  // Updated rows get a blue tint that dissolves away in sparkly pixels (after any reordering settles).
  if (!live()) return;
  const blue = cssVar('--series-1');
  for (const tr of changed) setTimeout(() => tr.isConnected && pixelTiles({
      host: root, target: tr, mode: 'clear', color: withAlpha(blue, 0.07),
      tile: 4, hold: 0, duration: 750, sweep: 0.3,
      spark: { chance: 0.04, colors: FX.blue, vx: [-15, 15], vy: [-45, -10], life: [400, 800], size: [1, 2] },
    }), moved ? ROW_MOVE_MS : 0);
}

async function loadStatus() {
  [state.status] = await Promise.all([api('/api/status'), rosterLoad]);
  const season = state.status.season;
  if (season?.ended && season.end) {
    clockStop = season.end - 1; // its end is the next season's first moment
    document.body.classList.add('archived');
  }
  setTz(state.status.tz);
  POLL = state.status.poll_seconds;
  state.dataStart = state.status.data_start;
  if (!state.rangesChosen) {
    state.rangesChosen = true;
    tlCtl.set(fittingTimelineWindow());
    dailyCtl.set(fittingDailyWindow());
    lbCtl.set(presetWindow(defaultLeaderboardRange()));
  }
  renderLive();
}

// After the first load, only rows from the latest (still-filling) hour onward are re-fetched.
async function loadHourly() {
  // a finished season keeps all of its hours, for its totals
  const since = archived() ? Math.min(state.dataStart ?? nowSec(), nowSec() - HOURLY_DAYS * 86400) : nowSec() - HOURLY_DAYS * 86400;
  state.hourlyFrom = since;
  if (!state.hourly.length) {
    state.hourly = (await api(`/api/hourly?from=${since}`)).rows;
    return;
  }
  const from = state.hourly.at(-1)[0];
  const fresh = (await api(`/api/hourly?from=${from}`)).rows;
  state.hourly = state.hourly.filter((r) => r[0] >= since && r[0] < from).concat(fresh);
}

// Responses for windows in the past don't change, so keep a few around.
const memo = new Map();
async function memoApi(path) {
  if (!memo.has(path)) {
    if (memo.size >= 8) memo.delete(memo.keys().next().value);
    memo.set(path, await api(path));
  }
  return memo.get(path);
}

// Hourly rows in [from, to): from the cache when it covers them, otherwise fetched.
async function getHourlyRange(from, to) {
  if (state.hourly.length && from >= state.hourlyFrom) return state.hourly.filter((r) => r[0] >= from && r[0] < to);
  return (await memoApi(`/api/hourly?from=${from}&to=${to - 1}`)).rows;
}

// Minute rows, fetching only what's newer than the cache unless the range grew.
async function loadSnapshots(from) {
  const s = state.snaps;
  if (!s.rows.length || from < s.since) {
    state.snaps = { since: from, rows: (await api(`/api/snapshots?from=${from}`)).rows };
  } else {
    const fresh = (await api(`/api/snapshots?from=${s.rows.at(-1)[0] + 1}`)).rows;
    s.rows.push(...fresh);
  }
  return state.snaps.rows.filter((r) => r[0] >= from);
}

// Shows one of the views ('home', 'player', 'chat', 'combat') and marks its tab.
function showView(name) {
  for (const v of ['home', 'player', 'chat', 'combat']) $(`#view-${v}`).hidden = v !== name;
  if (name !== 'player') clearPlayerModel();
  document.body.classList.toggle('chat-mode', name === 'chat');
  $('#search-btn').hidden = name !== 'chat';
  if (name !== 'chat') closeSearch();
  if (state.status) renderSeasonNote();
  const tab = name === 'chat' || name === 'combat' ? name : 'activity';
  for (const t of ['activity', 'chat', 'combat']) {
    if (t === tab) $(`#tab-${t}`).setAttribute('aria-current', 'page');
    else $(`#tab-${t}`).removeAttribute('aria-current');
  }
}

async function showHome() {
  showView('home');
  document.title = SITE;
  await loadStatus();
  await loadHourly();
  renderTiles();
  renderOnlineChips();
  renderServerWeekGrid().catch((e) => showError(e.message));
  await Promise.all([loadTimeline(), renderServerDaily(live()), loadLeaderboard()]);
}

/* ---------- player page ---------- */

const knownNames = new Map(); // uuid -> name, from the leaderboard and chips, for the loading header
const playerCache = new Map(); // uuid -> { at, promise }

// Player data is fetched on hover, so a click usually finds it ready.
function fetchPlayer(uuid, fresh = false) {
  const hit = playerCache.get(uuid);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.promise;
  const promise = api(`/api/player/${encodeURIComponent(uuid)}`);
  playerCache.set(uuid, { at: Date.now(), promise });
  promise.catch(() => playerCache.delete(uuid));
  return promise;
}
const prefetchPlayer = (uuid) => fetchPlayer(uuid).catch(() => {});

function setHead(img, name) {
  if (img.dataset.name === name) return;
  delete img.dataset.fellBack;
  img.dataset.name = name;
  img.dataset.size = 64;
  img.src = head(name, 64);
}

// Placeholders while a different player's data loads, so the last player never shows.
function showPlayerLoading(uuid) {
  const view = $('#view-player');
  view.classList.remove('reveal');
  view.classList.add('is-loading');
  const name = knownNames.get(uuid);
  $('#p-name').textContent = name ? shownName(name) : 'Loading…';
  $('#p-team').hidden = true;
  const ph = $('#p-head');
  if (name) setHead(ph, name);
  else { ph.removeAttribute('src'); delete ph.dataset.name; }
  $('#p-status').textContent = 'Loading…';
  for (const id of ['p-total', 'p-sessions', 'p-longest', 'p-chat']) {
    const n = $(`#${id}`);
    delete n.dataset.text;
    delete n.dataset.value;
    n.textContent = '–';
  }
  for (const id of ['p-total-sub', 'p-avg', 'p-longest-sub', 'p-chat-sub', 'pa-label']) $(`#${id}`).textContent = '';
  const chart = $('#p-heatmap');
  stopTween(chart);
  chartPrev.delete(chart);
  redraws.delete(chart);
  chart.replaceChildren(el('div', { class: 'empty-chart', text: 'Loading…' }));
  const empty = Array.from({ length: 7 }, () => Array(24).fill(0));
  renderWeekGrid($('#p-weekgrid'), empty, () => [{ value: 'Loading…' }]);
  weekPrev.delete($('#p-weekgrid'));
  $('#p-recent').replaceChildren(el('div', { class: 'empty', text: 'Loading…' }));
  $('#p-combat').replaceChildren(el('div', { class: 'empty', text: 'Loading…' }));
  $('#pcb-sub').textContent = '';
  $('#p-egg-card').hidden = true;
  $('#p-egg-combat').classList.add('no-egg');
  $('#p-adv-card').hidden = true;
  adv.key = null;
  adv.drawn = null;
}

let playerReq = 0;

async function showPlayer(uuid, { refresh = false } = {}) {
  showView('player');
  if (!refresh) window.scrollTo(0, 0);
  const switching = !refresh && state.playerShown !== uuid;
  const req = ++playerReq;
  if (switching) {
    state.playerShown = null;
    state.playerData = null;
    showPlayerLoading(uuid);
  }
  const [r, chatInfo] = await Promise.all([
    fetchPlayer(uuid, refresh),
    // the page still works if chat can't be loaded
    fetchPlayerChat(`uuid=${uuid}`, { events: true, fresh: refresh }).catch(() => null),
    refresh || !state.status ? loadStatus() : null,
  ]);
  if (req !== playerReq) return; // another player was opened meanwhile
  const { player } = r;
  knownNames.set(player.uuid, player.name);
  setHead($('#p-head'), player.name);

  const sessions = r.sessions.map(([s, e]) => [s, e + r.poll_seconds]);
  const lastTs = state.status.last?.ts;
  const isOnline = !archived() && lastTs != null && r.sessions.length && r.sessions.at(-1)[1] === lastTs;

  let total = 0, longest = [0, null];
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const [s, e] of sessions) {
    const len = e - s;
    total += len;
    if (len > longest[0]) longest = [len, s];
    eachHourChunk(s, e, (h, secs) => {
      const info = hourInfo(h);
      grid[info.dow][info.hour] += secs;
    });
  }

  const status = $('#p-status');
  status.replaceChildren();
  if (isOnline) status.append(el('span', { class: 'badge', text: 'Online' }), `since ${fmt(r.sessions.at(-1)[0], { hour: 'numeric', minute: '2-digit' })}`);
  else if (r.sessions.length) status.append(`Last seen ${ago(r.sessions.at(-1)[1])}`);
  else status.append('Not seen this season');
  if (player.first_seen) status.append(` · first seen ${fmt(player.first_seen, { month: 'short', day: 'numeric', year: 'numeric' })}`);

  const weekAgo = nowSec() - 7 * 86400;
  let week = 0;
  for (const [s, e] of sessions) if (e > weekAgo) week += e - Math.max(s, weekAgo);

  const animate = live() && state.playerShown === player.uuid;
  if (state.playerShown !== player.uuid) pCtl.set(playerDefaultWindow());
  state.playerShown = player.uuid;
  state.playerData = { name: player.name, sessions, liveSession: isOnline ? sessions.at(-1) : null, chat: chatInfo, gear: r.gear };
  renderPlayerName();
  renderPlayerModel(player.name, r.gear);
  renderPlayerEgg(player.name, r.gear).catch((e) => console.error('egg card:', e));
  renderPlayerCombat(player.name).catch((e) => console.error('combat card:', e));
  renderPlayerAdvancements(player.name).catch((e) => console.error('advancements card:', e));
  setCounter($('#p-total'), dur(total), total, animate);
  $('#p-total-sub').textContent = `${dur(week)} in the ${archived() ? 'final' : 'last'} 7 days`;
  setCounter($('#p-sessions'), sessions.length.toLocaleString(), sessions.length, animate);
  $('#p-avg').textContent = sessions.length ? `avg ${dur(total / sessions.length)}` : '';
  setCounter($('#p-longest'), dur(longest[0]), longest[0], animate);
  $('#p-longest-sub').textContent = longest[1] ? fmt(longest[1], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  renderPlayerChatTile(animate);

  // A newly opened player fades in, with the activity bars rising from zero.
  const view = $('#view-player');
  view.classList.remove('is-loading');
  if (switching && !reducedMotion()) {
    view.classList.remove('reveal');
    void view.offsetWidth; // restart the animations
    view.classList.add('reveal');
    clearTimeout(showPlayer.revealTimer);
    showPlayer.revealTimer = setTimeout(() => view.classList.remove('reveal'), 900);
  }

  renderPlayerActivity(animate, 0, switching);
  renderWeekGrid($('#p-weekgrid'), grid, (v, label) => [
    { value: v ? dur(v) : 'Never', label: v ? 'total' : null },
    { label },
  ], { animate });

  const recent = sessions.slice(-15).reverse();
  const root = $('#p-recent');
  if (!recent.length) {
    root.replaceChildren(el('div', { class: 'empty', text: 'No sessions yet.' }));
    return;
  }
  const tbody = el('tbody');
  recent.forEach(([s, e], i) => {
    const live = i === 0 && isOnline;
    const timeOpts = { hour: 'numeric', minute: '2-digit' };
    tbody.append(el('tr', {},
      el('td', { text: fmt(s, { weekday: 'short', month: 'short', day: 'numeric' }) }),
      el('td', { class: 'muted' }, `${fmt(s, timeOpts)} – `, live ? el('span', { class: 'badge', text: 'now' }) : fmt(e, timeOpts)),
      el('td', { class: 'num', text: dur(e - s) })
    ));
  });
  root.replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, el('th', { text: 'Date' }), el('th', { text: 'Time' }), el('th', { class: 'num', text: 'Length' }))),
    tbody
  ));
}

// The name as chat shows it, in its colors (or their real name), and their team.
function renderPlayerName() {
  const d = state.playerData;
  if (!d) return;
  $('#p-name').replaceChildren(...nameParts(d.chat?.display, d.name));
  document.title = `${shownName(d.name)} · ${SITE}`;
  const r = rosterOf(d.name);
  const team = $('#p-team');
  team.hidden = !r;
  if (r) {
    const egg = eggInfo(playerEggId(d.name, d.gear));
    team.replaceChildren(el('span', { class: `team-dot team-${r.team}` }),
      el('span', { class: `team-${r.team}`, text: TEAM_NAMES[r.team] || r.team }),
      el('span', { class: 'muted', text: `· ${nameMode === 'real' ? r.ign : r.name}` }),
      ...(egg ? [el('span', { class: 'p-egg', style: egg.color ? `--egg:${egg.color}` : '', text: `· ${egg.name}` })] : []));
  }
}

/* ---------- a player's advancements, as the game's advancements screen ---------- */

// The tree comes from the server mod with the game's own layout: x is the column, y the row.
// Drawn at twice the game's size: a 26-pixel frame every 28 pixels across and 27 down, joined by
// the game's elbow lines, on the tab's background. Hidden advancements only show once earned.
const ADV = { scale: 2, dx: 28, dy: 27, box: 26, pad: 9 };
const adv = { key: null, tab: recall('advTab') || null, data: null };
const advTexture = (path) => `/api/mc/textures/${path}.png`;
let mcIcons = null;
function setItemIcon(img, icon) {
  mcIcons ??= import('/mcicons.js');
  mcIcons.then((m) => m.itemIcon(icon.model || icon.id).then((url) => url || (icon.model ? m.itemIcon(icon.id) : null)))
    .then((url) => { if (url) img.src = url; else img.remove(); })
    .catch(() => img.remove());
}

async function renderPlayerAdvancements(name) {
  const card = $('#p-adv-card');
  const mine = (state.playerAdvReq = (state.playerAdvReq || 0) + 1);
  const data = await api(`/api/advancements?name=${encodeURIComponent(name)}`).catch(() => null);
  if (mine !== state.playerAdvReq || state.playerData?.name !== name) return;
  if (!data?.tree?.length) { card.hidden = true; adv.key = null; return; }
  const key = JSON.stringify([name, data.ts, data.tree.length, data.done, data.part]);
  $('#adv-sub').textContent = advSummary(data);
  if (key === adv.key) return; // nothing new: leave the tab and the scroll position alone
  adv.key = key;
  adv.data = data;
  card.hidden = false;
  drawAdvancements();
}

// Which advancements show: all of them, except hidden ones nobody has earned (or earned past) yet.
function advShown(data) {
  const kids = new Map();
  for (const a of data.tree) if (a.parent) kids.set(a.parent, [...(kids.get(a.parent) || []), a]);
  const earnedBelow = (a) => a.id in data.done || (kids.get(a.id) || []).some(earnedBelow);
  return data.tree.filter((a) => !a.hidden || earnedBelow(a));
}
function advSummary(data) {
  const shown = advShown(data);
  const got = shown.filter((a) => a.id in data.done).length;
  return `${got} of ${shown.length} · ${data.ts ? `updated ${ago(data.ts)}` : 'not reported yet'}`;
}

function drawAdvancements() {
  hideTip(); // the advancement it was for is about to be redrawn
  const data = adv.data;
  const shown = advShown(data);
  const byId = new Map(shown.map((a) => [a.id, a]));
  const rootOf = (a) => { let r = a; for (let i = 0; i < 64 && r.parent && byId.has(r.parent); i++) r = byId.get(r.parent); return r; };
  const tabs = new Map(); // root id -> its advancements
  for (const a of shown) {
    const r = rootOf(a);
    if (r.parent) continue; // its root isn't in the tree: nowhere to draw it
    if (!tabs.has(r.id)) tabs.set(r.id, []);
    tabs.get(r.id).push(a);
  }
  // the game's own tabs first, in the game's order; then any a data pack adds
  const ORDER = ['story/root', 'nether/root', 'end/root', 'adventure/root', 'husbandry/root'];
  const rank = (id) => (ORDER.indexOf(id) + 1 || ORDER.length + 1);
  const ordered = [...tabs].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  if (!tabs.has(adv.tab)) adv.tab = ordered[0]?.[0];
  const fresh = adv.drawn !== `${state.playerData?.name}/${adv.tab}`; // a tab not on screen yet starts on its root
  adv.drawn = `${state.playerData?.name}/${adv.tab}`;

  $('#adv-tabs').replaceChildren(...ordered.map(([id, list]) => {
    const root = byId.get(id);
    const icon = el('img', { class: 'adv-tab-icon', alt: '', width: 16, height: 16 });
    setItemIcon(icon, root.icon);
    const b = el('button', { type: 'button', role: 'tab', 'aria-selected': String(id === adv.tab), title: root.desc || null },
      icon, el('span', { text: root.title }),
      el('span', { class: 'adv-tab-n', text: `${list.filter((a) => a.id in data.done).length}/${list.length}` }));
    b.addEventListener('click', () => {
      if (adv.tab === id) return;
      adv.tab = id;
      remember('advTab', id);
      drawAdvancements();
    });
    return b;
  }));

  const list = tabs.get(adv.tab) || [];
  const root = byId.get(adv.tab);
  const { scale: S, dx, dy, box, pad } = ADV;
  const minX = Math.min(...list.map((a) => a.x)), minY = Math.min(...list.map((a) => a.y));
  const at = (a) => [Math.floor((a.x - minX) * dx) + pad, Math.floor((a.y - minY) * dy) + pad]; // in game pixels
  const w = Math.max(...list.map((a) => at(a)[0])) + box + pad, h = Math.max(...list.map((a) => at(a)[1])) + box + pad;

  const tree = $('#adv-tree');
  tree.style.width = `${w * S}px`;
  tree.style.height = `${h * S}px`;
  const view = $('#adv-view');
  view.style.backgroundImage = root?.bg ? `url("${advTexture(root.bg)}")` : '';

  // the lines: from the parent's middle to just past its frame, up or down, then to the child's middle
  const lines = sv('svg', { class: 'adv-lines', width: w * S, height: h * S, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' });
  const paths = { line: [], got: [] };
  for (const a of list) {
    const p = a.parent && byId.get(a.parent);
    if (!p) continue;
    const [px, py] = at(p), [cx, cy] = at(a);
    const mid = px + box + 4.5;
    paths.line.push(`M${px + 13} ${py + 13.5}H${mid}V${cy + 13.5}H${cx + 13}`);
  }
  lines.append(sv('path', { class: 'adv-line-edge', d: paths.line.join('') }), sv('path', { class: 'adv-line', d: paths.line.join('') }));

  const frames = { task: 'task', goal: 'goal', challenge: 'challenge' };
  const nodes = list.map((a) => {
    const [x, y] = at(a);
    const done = a.id in data.done;
    const part = data.part[a.id];
    const node = el('button', {
      type: 'button', class: `adv-node${done ? ' done' : ''}`, style: `left:${x * S}px;top:${y * S}px`,
      'aria-label': `${a.title}: ${a.desc}. ${done ? 'Earned' : part ? `${part.n} of ${part.of}` : 'Not earned'}`,
    },
      el('img', { class: 'adv-frame', alt: '', src: advTexture(`gui/sprites/advancements/${frames[a.frame] || 'task'}_frame_${done ? 'obtained' : 'unobtained'}`) }));
    const icon = el('img', { class: 'adv-icon', alt: '' });
    setItemIcon(icon, a.icon);
    node.append(icon);
    const tipNode = () => {
      const when = done && data.done[a.id]
        ? `Earned ${fmt(data.done[a.id], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : done ? 'Earned' : part && part.of > 1 ? `In progress: ${part.n}/${part.of}` : 'Not earned yet';
      return el('div', { class: `adv-tip${done ? ' done' : ''} adv-${a.frame}` },
        el('div', { class: 'adv-tip-title', text: a.title }),
        el('div', { class: 'adv-tip-body' },
          el('div', { class: 'adv-tip-desc', text: a.desc }),
          el('div', { class: 'adv-tip-when', text: `${a.frame === 'task' ? '' : `${a.frame === 'goal' ? 'Goal' : 'Challenge'} · `}${when}` })));
    };
    const show = (e) => showTip(e.clientX, e.clientY, [{ node: tipNode(), adv: true }]);
    node.addEventListener('pointerenter', show);
    node.addEventListener('pointermove', show);
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', () => {
      const r = node.getBoundingClientRect();
      showTip(r.right - 14, r.top + 6, [{ node: tipNode(), adv: true }]);
    });
    node.addEventListener('blur', hideTip);
    return node;
  });
  tree.replaceChildren(lines, ...nodes);
  // like the game, a tab opens with its root in view: at the left, halfway down
  if (fresh && root) view.scrollTo(0, Math.max(0, (at(root)[1] + box / 2) * S - view.clientHeight / 2));
}

// Dragging the tree with a mouse moves it around, like in the game (touch already scrolls it).
{
  const view = $('#adv-view');
  let drag = null;
  view.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button) return;
    drag = { x: e.clientX, y: e.clientY, left: view.scrollLeft, top: view.scrollTop, moved: false };
  });
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    drag.moved = true;
    view.classList.add('dragging');
    hideTip();
    view.scrollLeft = drag.left - dx;
    view.scrollTop = drag.top - dy;
  });
  addEventListener('pointerup', () => {
    drag = null;
    view.classList.remove('dragging');
  });
}

// The player in 3D, wearing their armor, with their best weapon and their egg (public/player3d.js).
let playerModel = null; // { key, abort, handle }
function clearPlayerModel() {
  if (!playerModel) return;
  playerModel.abort.abort();
  playerModel.handle?.dispose();
  playerModel = null;
  $('#p-model').replaceChildren();
}
function renderPlayerModel(name, gear) {
  const card = $('#p-model-card');
  const spec = {
    name,
    uuid: gear?.uuid ? gear.uuid.replace(/-/g, '') : null,
    armor: gear?.armor || {},
    mainhand: bestWeapon(gear),
    offhand: heldEgg(gear, playerEggId(name, gear)),
    // the egg's particle aura (a dim one when it has no energy left)
    aura: playerEggId(name, gear) ? { id: playerEggId(name, gear), cracked: gear?.egg?.energy === 0 } : null,
  };
  const key = JSON.stringify(spec);
  renderModelNote(spec, gear);
  if (playerModel?.key === key) return; // the same look: leave it turning
  clearPlayerModel();
  card.hidden = false;
  const abort = new AbortController();
  const mine = { key, abort, handle: null };
  playerModel = mine;
  const box = $('#p-model');
  box.classList.add('loading');
  import('/player3d.js')
    .then((m) => m.mountPlayer(box, { ...spec, signal: abort.signal }))
    .then((handle) => {
      if (playerModel !== mine) return handle.dispose();
      mine.handle = handle;
    })
    .catch((err) => {
      console.error('3D model:', err);
      if (playerModel === mine) card.hidden = true; // no WebGL, or the library couldn't load
    })
    .finally(() => box.classList.remove('loading'));
}
// Under the model: what they're holding, and when that was reported.
function renderModelNote(spec, gear) {
  const note = $('#p-model-note');
  const parts = [];
  if (spec.mainhand) parts.push(el('span', { text: itemName(spec.mainhand) }));
  const egg = eggInfo(playerEggId(state.playerData?.name, gear));
  if (egg) parts.push(el('span', { class: 'p-egg', style: egg.color ? `--egg:${egg.color}` : '', text: egg.name }));
  const when = gear?.ts ? `Gear updated ${ago(gear.ts)}` : 'No gear reported yet';
  note.replaceChildren(
    ...(parts.length ? [el('div', { class: 'p-model-held' }, ...parts.flatMap((p, i) => (i ? [' · ', p] : [p])))] : []),
    el('div', { class: 'muted', text: when }),
  );
}

// Chat messages sent, all time or today (the choice is remembered). A finished season shows its total.
const chatDataStartLabel = (ms) => {
  const t = Math.floor(ms / 1000);
  return `${fmt(t, { month: 'numeric', day: 'numeric' })} ${fmt(t, { hour: 'numeric' }).replace(/\s/g, '').toLowerCase()}`;
};
function renderPlayerChatTile(animate = false) {
  const c = state.playerData?.chat;
  const mode = archived() ? 'total' : $('#p-chat-mode').value;
  $('#p-chat-mode').hidden = archived();
  const node = $('#p-chat');
  if (!c) {
    node.textContent = '–';
    $('#p-chat-sub').textContent = 'Chat log unavailable';
    return;
  }
  const n = mode === 'today' ? c.today : c.total;
  setCounter(node, n.toLocaleString(), n, animate);
  $('#p-chat-sub').textContent = c.data_start ? `data starts ${chatDataStartLabel(c.data_start)}` : 'no chat logged yet';
}
$('#p-chat-mode').value = recall('playerChatMode') === 'today' ? 'today' : 'total';
$('#p-chat-mode').addEventListener('change', (e) => {
  remember('playerChatMode', e.target.value);
  renderPlayerChatTile(true);
});

// Bars of time played per hour or day, with the when-online strip underneath.
function renderPlayerActivity(animate = false, slide = 0, grow = false) {
  const d = state.playerData;
  if (!d) return;
  const w = pCtl.get();
  const r = resolveWindow(w);
  pCtl.sync();
  $('#pa-label').textContent = windowLabel(w, r, PLAYER_PRESETS);

  const hourly = w.unit === 'hour';
  const inWindow = d.sessions.filter(([a, e]) => e > r.from && a < r.to);
  const secs = r.buckets.map((b) => {
    let total = 0;
    for (const [a, e] of inWindow) {
      const overlap = Math.min(e, b.end) - Math.max(a, b.start);
      if (overlap > 0) total += overlap;
    }
    return total;
  });
  const hm = { hour: 'numeric', minute: '2-digit' };

  renderBars($('#p-heatmap'), {
    buckets: r.buckets,
    vals: secs.map((x) => (hourly ? x / 60 : x / 3600)),
    windowKey: windowKey(w),
    labels: hourly ? 'hour' : 'day',
    fmtTick: (v) => (hourly ? `${v}m` : `${v}h`),
    scale: hourly ? { ymax: 60, ystep: 15 } : null, // minutes per hour: always the full hour, for fair comparison
    dataStart: chartStart(),
    describe: (i) => {
      const b = r.buckets[i];
      const when = hourly
        ? `${fmt(b.start, { weekday: 'short', month: 'short', day: 'numeric' })}, ${hourName(hourInfo(b.start).hour)}–${hourName(hourInfo(b.end).hour)}`
        : fmtDay(b.date);
      return [{ value: secs[i] ? dur(secs[i]) : 'Offline' }, { label: when }];
    },
    strip: {
      intervals: inWindow,
      describe: (t, iv) => {
        const when = fmt(t, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        if (state.dataStart && t < state.dataStart) return [{ value: 'No data' }, { label: when }];
        if (!iv) return [{ value: 'Offline' }, { label: when }];
        const end = iv === d.liveSession ? 'now' : fmt(iv[1], hm);
        return [
          { value: 'Online', color: 'var(--series-1)' },
          { label: when },
          { label: `Session ${fmt(iv[0], hm)} – ${end} · ${dur(iv[1] - iv[0])}` },
        ];
      },
    },
    chatStrip: d.chat && {
      events: d.chat.events.filter(([, ts]) => ts >= r.from * 1000 && ts < r.to * 1000),
      dataStart: d.chat.data_start ? d.chat.data_start / 1000 : null,
      onPick: (ev, x, y) => openChatPeek(ev, x, y),
    },
  }, { animate, slide, grow });
}

/* ---------- chat log ---------- */

const CHAT_PAGE = 100; // messages per request
const CHAT_KEEP = 1200; // most messages kept on the page; past this the far end is dropped (and reloads on demand)
const CHAT_GROUP_MS = 5 * 60_000; // one player's lines within this of each other share a name header
const CHAT_POLL_MS = 10_000;

const chat = {
  messages: [], // in time order: { id, ts (ms), kind, uuid, name, text }
  lines: [], // one per message, in order: { el, ts, id } — for finding what's on screen
  moreBefore: false,
  moreAfter: false, // the newest messages aren't loaded (after jumping back in time)
  maxId: 0, // newest message id seen, for live updates
  loading: null, // 'older' | 'newer' | 'jump' while a request is out
  loaded: false,
  pinned: null, // a time picked on the graph; it stays the chat's time until the reader scrolls
  quietUntil: 0, // scroll events before this come from the page moving things, not the reader
  bottomGap: 0, // distance from the bottom, kept when the log's height changes
  unread: 0, // player messages newer than the last one seen at the bottom of the log, per the server
  seenId: (() => { try { const v = Number(localStorage.getItem('chatSeen')); return v > 0 ? v : null; } catch { return null; } })(),
  newFrom: null, // messages after this id get a "New" divider (unread when the page was opened)
  t: null, // the time the chat is scrolled to (seconds)
  win: null, // the graph's window: the live 24h, or one whole day
  sessions: [],
  geom: null, // the graph's geometry from its last drawing
  graphReq: 0,
  onlineKey: '',
  pendingJump: null, // { id, ts } to open the chat at, from a player's page
};
const chatScroll = $('#chat-scroll');

const clock = (t) => fmt(t, { hour: 'numeric', minute: '2-digit' });

function relativeDay(date, opts) {
  if (archived()) return fmtDay(date, opts);
  const today = todayStr();
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  return fmtDay(date, opts);
}
const cursorLabel = (t) => `${relativeDay(hourInfo(t).date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${clock(t)}`;

// Links in chat become clickable (http/https only).
const URL_RE = /\bhttps?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'}]/gi;
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(el('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer nofollow', text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Names as chat shows them, in their team colors: exact on the light page (pale ones get a shadow),
// lightened where needed on the dark page (the CSS picks).
const nameColors = new Map(); // uuid -> color of the name itself, for chips and lists elsewhere
const mcCache = new Map();

function luminance([r, g, b]) {
  const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

function mcStyle(hex) {
  let v = mcCache.get(hex);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    let dark = rgb;
    // dark page: lighten away from near-black
    for (let k = 0; k <= 1 && contrast(luminance(dark), 0.01) < 4; k += 0.05) dark = rgb.map((c) => c + (255 - c) * k);
    // light page: the exact color; ones too pale to read on white (white, yellow, aqua) get
    // Minecraft's own text shadow, the same color at a quarter brightness
    const shadow = contrast(luminance(rgb), 0.96) < 2 ? `1px 1px 0 ${toHex(rgb.map((c) => c / 4))}` : 'none';
    // the two team colors match the leaderboards on a dark page, which read better than the game's
    const team = { '#ff5555': '#f27a72', '#5555ff': '#6ea8f5' }[hex.toLowerCase()];
    v = `--cl:${hex};--cs:${shadow};--cd:${team || toHex(dark)}`;
    mcCache.set(hex, v);
  }
  return v;
}

function colorName(node, uuid, ign) {
  if (ign && rosterOf(ign)) { // on a team: the team's color, as everywhere else
    node.classList.remove('mc');
    node.removeAttribute('style');
    node.classList.add('team', `team-${rosterOf(ign).team}`);
    return node;
  }
  const c = nameColors.get(uuid);
  if (c) { node.classList.add('mc'); node.setAttribute('style', mcStyle(c)); }
  return node;
}

const displayText = (m) => (m.display ? m.display.map((p) => p.t).join('') : m.name || 'Server');

// Admins send chat from the dashboard without a player name; a yellow tag stands in for it.
const adminTag = () => el('span', { class: 'msg-name msg-admin', text: 'Admin', title: 'Sent by an admin from this dashboard' });

function chatName(m) {
  if (m.via === 'admin') return adminTag();
  const parts = m.display
    ? swapParts(m.display, m.name).map((p) => (p.c ? el('span', { class: 'mc', style: mcStyle(p.c), text: p.t }) : p.t))
    : [m.name ? shownName(m.name) : 'Server'];
  if (!m.uuid) return el('span', { class: 'msg-name' }, ...parts);
  knownNames.set(m.uuid, m.name);
  const own = m.display?.find((p) => p.c && p.t.includes(m.name));
  if (own) nameColors.set(m.uuid, own.c);
  return playerLink(el('a', { class: 'msg-name' }, ...parts), m.uuid, m.name);
}

// A link to a player that opens their card (plain click) or their page (new tab, etc.).
// Without a uuid (a name only seen in a message), the card looks the name up.
function playerLink(a, uuid, name) {
  a.href = uuid ? `#/player/${uuid}` : '#';
  a.dataset.card = '';
  if (uuid) {
    a.dataset.uuid = uuid;
    a.addEventListener('pointerenter', () => prefetchPlayer(uuid));
  } else a.dataset.name = name;
  return a;
}

const uuidForName = (name) => {
  const lower = name.toLowerCase();
  for (const [uuid, n] of knownNames) if (n && n.toLowerCase() === lower) return uuid;
  return null;
};

// A whole message as the game styles it (deaths, advancements): every player named in it is a
// link in their own colors, and item or advancement names keep theirs.
function richText(m) {
  const out = [];
  const pieces = m.rich;
  const colored = (p, t = p.t) => (p.c ? el('span', { class: 'mc', style: mcStyle(p.c), text: t }) : t);
  // The weapon's name: marked by the server mod (w); in older messages, the [bracketed] part of a death.
  let itemFrom = -1, itemTo = -1;
  if (!pieces.some((p) => p.w) && m.kind === 'death') {
    itemFrom = pieces.findIndex((p) => !p.p && p.t.trimStart().startsWith('['));
    if (itemFrom >= 0) {
      itemTo = pieces.findIndex((p, k) => k >= itemFrom && p.t.trimEnd().endsWith(']'));
      if (itemTo < 0 || pieces.slice(itemFrom, itemTo + 1).some((p) => p.p)) itemFrom = itemTo = -1;
    }
  }
  const isItem = (k) => pieces[k].w || (k >= itemFrom && k <= itemTo);
  for (let i = 0; i < pieces.length;) {
    const who = pieces[i].p;
    if (who) {
      const run = [];
      while (i < pieces.length && pieces[i].p === who) run.push(pieces[i++]);
      const uuid = who === m.name ? m.uuid : uuidForName(who);
      const shown = (t) => (shownName(who) === who ? noTag(t) : noTag(t).replace(who, shownName(who)));
      out.push(playerLink(el('a', { class: 'msg-name' }, ...run.map((p) => colored(p, shown(p.t)))), uuid, who));
    } else if (isItem(i)) {
      const run = [];
      while (i < pieces.length && !pieces[i].p && isItem(i)) run.push(pieces[i++]);
      out.push(itemSpan(run));
    } else out.push(colored(pieces[i++]));
  }
  return out;
}

// An item named in a message, a little bolder like the players' names. Hovering (or tapping) shows
// its tooltip as in game, when the server mod sent one.
function itemSpan(run) {
  const node = el('span', { class: 'msg-item' }, ...run.map((p) => (p.c ? el('span', { class: 'mc', style: mcStyle(p.c), text: p.t }) : p.t)));
  const lines = run.find((p) => p.i)?.i;
  if (!lines) return node;
  node.classList.add('has-tip');
  node.tabIndex = 0;
  const tipNode = () => el('div', { class: 'item-tip' }, ...lines.map((line, k) => el('div', { class: `it-line${k ? '' : ' it-name'}` },
    ...(line.length ? line.map((p) => el('span', { style: `${p.c ? `color:${p.c};` : ''}${p.i ? 'font-style:italic' : ''}`, text: p.t })) : ['\u00a0']))));
  const show = (e) => showTip(e.clientX, e.clientY, [{ node: tipNode() }]);
  node.addEventListener('pointerenter', show);
  node.addEventListener('pointermove', show);
  node.addEventListener('pointerleave', hideTip);
  node.addEventListener('focus', () => {
    const r = node.getBoundingClientRect();
    showTip(r.left, r.top, [{ node: tipNode() }]);
  });
  node.addEventListener('blur', hideTip);
  return node;
}

const chatAvatar = (m, size) => (m.name && (m.uuid || m.kind !== 'say')
  ? headImg(m.name, size, { width: size, height: size, class: 'chat-head' })
  : el('span', { class: 'logo chat-logo', style: `width:${size}px;height:${size}px` }));

const SYS_ICONS = {
  join: ['M7 4.5 10.5 8 7 11.5', 'M2.5 8h8', 'M9.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3'],
  leave: ['M10.5 4.5 14 8l-3.5 3.5', 'M6 8h8', 'M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3'],
  death: ['M3 7.2a5 5 0 0 1 10 0v2.3l-1.5 1v2.5h-7v-2.5L3 9.5z', 'M6.2 7.8h.01', 'M9.8 7.8h.01', 'M7 13v-1.5M9 13v-1.5'],
  advancement: ['M8 2.2l1.75 3.6 3.95.55-2.87 2.78.69 3.92L8 11.2l-3.52 1.85.69-3.92L2.3 6.35l3.95-.55z'],
  server: ['M8 2.2v5.3', 'M4.6 4.4a5 5 0 1 0 6.8 0'],
  system: ['M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z', 'M8 7.4v3.6', 'M8 5.1h.01'],
};

// Joins, leaves, deaths, advancements, /me and server messages: one line each.
function sysRow(m) {
  const lead = m.kind === 'emote' ? chatAvatar(m, 16) : icon(SYS_ICONS[m.kind] || SYS_ICONS.system, 14);
  const body = el('div', { class: 'sys-text' });
  if (m.kind === 'emote') body.append(chatName(m), ' ', el('i', {}, ...linkify(m.text)));
  // Join and leave lines are all yellow in game, which would tint the name; those use the name's own colors.
  else if (m.rich && m.kind !== 'join' && m.kind !== 'leave') body.append(...richText(m));
  else if (m.name && m.text.startsWith(displayText(m))) body.append(chatName(m), m.text.slice(displayText(m).length));
  else if (m.name && m.text.startsWith(m.name)) body.append(chatName({ ...m, display: null }), m.text.slice(m.name.length));
  else body.append(noTag(m.text));
  return el('div', { class: `msg-sys sys-${m.kind}` },
    el('span', { class: 'msg-lead' }, lead), body, el('time', { class: 'msg-time', text: clock(m.ts / 1000) }));
}

// A run of messages from one player: head and name once, then their lines.
function msgGroup(m) {
  const head = chatAvatar(m, 24);
  const lead = m.uuid
    ? playerLink(el('a', { class: 'msg-lead', tabindex: '-1', 'aria-hidden': 'true' }, head), m.uuid, m.name)
    : el('span', { class: 'msg-lead' }, head);
  return el('div', { class: 'msg-group' }, lead, el('div', { class: 'msg-body' },
    el('div', { class: 'msg-meta' },
      chatName(m),
      m.kind === 'say' ? el('span', { class: 'msg-tag', text: '/say' }) : null,
      m.via === 'web' ? el('span', { class: 'msg-tag', text: 'web', title: 'Sent from this dashboard' }) : null,
      el('time', { class: 'msg-time', text: clock(m.ts / 1000) }))));
}

const chatLine = (m) => el('div', { class: 'msg-line' },
  el('time', { class: 'msg-gutter', 'aria-hidden': 'true', text: clock(m.ts / 1000).replace(/\s?[AP]M$/, '') }),
  ...linkify(m.text));

function renderChat(fresh = new Set()) {
  const frag = document.createDocumentFragment();
  chat.lines = [];
  let prev = null, group = null, day = null;
  for (const m of chat.messages) {
    const d = hourInfo(m.ts / 1000).date;
    if (d !== day) {
      frag.append(el('div', { class: 'chat-day', role: 'separator' },
        el('span', { text: relativeDay(d, { weekday: 'long', month: 'long', day: 'numeric' }) })));
      day = d;
      group = null;
    }
    // what was unread when the page opened starts under a "New" line
    if (chat.newFrom != null && prev && prev.id <= chat.newFrom && m.id > chat.newFrom) {
      frag.append(el('div', { class: 'chat-new', role: 'separator' }, el('span', { text: 'New' })));
      group = null;
    }
    let node;
    if (m.kind === 'chat' || m.kind === 'say') {
      if (!group || prev.kind !== m.kind || prev.name !== m.name || prev.via !== m.via || m.ts - prev.ts > CHAT_GROUP_MS) {
        group = msgGroup(m);
        frag.append(group);
      }
      node = chatLine(m);
      group.lastChild.append(node);
    } else {
      group = null;
      node = sysRow(m);
      frag.append(node);
    }
    if (fresh.has(m.id)) node.classList.add('msg-new');
    chat.lines.push({ el: node, ts: m.ts, id: m.id });
    prev = m;
  }
  $('#chat-list').replaceChildren(frag);
  renderChatEdge();
}

function renderChatEdge() {
  const top = $('#chat-top');
  if (!chat.loaded) top.replaceChildren(el('div', { class: 'chat-note loading', text: 'Loading chat…' }));
  else if (!chat.messages.length) {
    top.replaceChildren(el('div', { class: 'chat-empty' },
      el('strong', { text: 'No chat yet' }),
      el('div', { text: 'Messages show up here once the mcstats-chat mod is running on the server.' })));
  } else if (chat.loading === 'older') top.replaceChildren(el('div', { class: 'chat-note loading', text: 'Loading older messages…' }));
  else if (!chat.moreBefore) top.replaceChildren(el('div', { class: 'chat-note', text: 'This is the start of the chat log.' }));
  else top.replaceChildren();
}

const fromBottom = () => chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight;

// Scrolls made by the page itself don't count as the reader scrolling.
function setScroll(top) {
  chat.quietUntil = performance.now() + 250;
  chatScroll.scrollTop = top;
}

// The last message at least partly on screen: the time the chat is scrolled to.
function lastVisibleLine() {
  const lines = chat.lines;
  if (!lines.length) return null;
  const bottom = chatScroll.scrollTop + chatScroll.clientHeight - 6;
  let lo = 0, hi = lines.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].el.offsetTop < bottom) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return lines[found];
}

// Keeps the bottom line where it is while messages are added or removed around it.
function chatAnchor() {
  const line = lastVisibleLine();
  return line && { id: line.id, off: line.el.offsetTop - chatScroll.scrollTop };
}
function restoreAnchor(a) {
  const line = a && chat.lines.find((l) => l.id === a.id);
  if (line) setScroll(line.el.offsetTop - a.off);
}

async function loadChatLatest() {
  const res = await api(`/api/chat?limit=${CHAT_PAGE}`);
  Object.assign(chat, {
    messages: res.messages, moreBefore: res.more_before, moreAfter: false,
    maxId: res.max_id, loaded: true, pinned: null,
  });
  renderChat();
  setScroll(chatScroll.scrollHeight);
  chat.bottomGap = 0;
}

async function loadOlder() {
  if (chat.loading || !chat.moreBefore || !chat.messages.length) return;
  chat.loading = 'older';
  renderChatEdge();
  try {
    const first = chat.messages[0];
    const res = await api(`/api/chat?before=${first.ts}:${first.id}&limit=${CHAT_PAGE}`);
    const anchor = chatAnchor();
    chat.messages = res.messages.concat(chat.messages);
    chat.moreBefore = res.more_before;
    if (chat.messages.length > CHAT_KEEP) {
      chat.messages.length = CHAT_KEEP;
      chat.moreAfter = true;
    }
    chat.loading = null;
    renderChat();
    restoreAnchor(anchor);
  } finally {
    chat.loading = null;
    renderChatEdge();
  }
  fillChat();
}

async function loadNewer() {
  if (chat.loading || !chat.moreAfter || !chat.messages.length) return;
  chat.loading = 'newer';
  try {
    const last = chat.messages.at(-1);
    const res = await api(`/api/chat?after=${last.ts}:${last.id}&limit=${CHAT_PAGE}`);
    const anchor = chatAnchor();
    chat.messages = chat.messages.concat(res.messages);
    chat.moreAfter = res.more_after;
    chat.maxId = Math.max(chat.maxId, res.max_id);
    if (chat.messages.length > CHAT_KEEP) {
      chat.messages.splice(0, chat.messages.length - CHAT_KEEP);
      chat.moreBefore = true;
    }
    renderChat();
    restoreAnchor(anchor);
  } finally {
    chat.loading = null;
  }
  updateChatJump();
}

// Loads more while the log doesn't fill its box (or the reader is near an end).
function fillChat() {
  if (chatScroll.scrollTop < 600) loadOlder().catch((e) => showError(e.message));
  if (fromBottom() < 600) loadNewer().catch((e) => showError(e.message));
}

// The graph jumps the chat: messages up to that moment end at the bottom of the log.
// With an id (a search result, a message picked on a player's page), that message is the one shown.
async function jumpChatTo(t, id = null) {
  if (chat.loading === 'jump') return;
  // let a load that's already out finish first, so it doesn't land on top of the jump
  for (let i = 0; chat.loading && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
  if (chat.loading) return;
  chat.loading = 'jump';
  let line = null;
  try {
    const res = await api(`/api/chat?at=${Math.round(t * 1000)}&limit=${CHAT_PAGE}`);
    Object.assign(chat, {
      messages: res.messages, moreBefore: res.more_before, moreAfter: res.more_after,
      maxId: Math.max(chat.maxId, res.max_id), loaded: true,
    });
    renderChat();
    line = (id != null && chat.lines.find((l) => l.id === id)) || chat.lines.findLast((l) => l.ts <= t * 1000) || null;
    // a picked message sits mid-log, clear of the jump button; a picked time ends the log
    const below = id != null ? chatScroll.clientHeight / 2 - line?.el.offsetHeight / 2 : 10;
    setScroll(line ? line.el.offsetTop + line.el.offsetHeight - chatScroll.clientHeight + below : 0);
    chat.bottomGap = fromBottom();
    chat.pinned = t;
  } finally {
    chat.loading = null;
    renderChatEdge();
  }
  if (line && !reducedMotion()) {
    line.el.animate([{ background: withAlpha(cssVar('--series-2'), 0.22) }, { background: 'transparent' }], { duration: 1400, easing: 'ease-out' });
  }
  updateChatJump();
  syncChatTime();
  fillChat();
}

// New messages since the last look. They're added at the bottom when the newest are loaded,
// and followed if the reader is already at the bottom.

// Everything up to the newest message counts as seen once the reader is at the bottom of the log.
function markSeen() {
  if (DUMMY || archived() || $('#view-chat').hidden || document.hidden || !chat.loaded || chat.moreAfter || fromBottom() > 60) return;
  if (chat.seenId == null || chat.maxId > chat.seenId) {
    chat.seenId = chat.maxId;
    remember('chatSeen', String(chat.maxId));
  }
  if (chat.unread) {
    chat.unread = 0;
    renderUnread();
  }
}

// Unread count in the Chat log tab, the page title and the jump button.
function renderUnread() {
  const n = chat.unread;
  const label = n > 99 ? '99+' : String(n);
  const badge = $('#tab-chat-badge');
  badge.hidden = !n;
  badge.textContent = label;
  $('#tab-chat').setAttribute('aria-label', n ? `Chat log, ${label} unread` : 'Chat log');
  document.title = `${n ? `(${label}) ` : ''}${document.title.replace(/^\(\d+\+?\) /, '')}`;
  if (!$('#view-chat').hidden) updateChatJump();
}

// From the other pages: just the count, every 30 seconds.
async function checkUnread() {
  if (DUMMY || archived()) return; // no new messages in sample data or a finished season
  if (chat.seenId == null) {
    const res = await api(`/api/chat?since_id=${Number.MAX_SAFE_INTEGER}&limit=1`);
    chat.seenId = res.max_id;
    remember('chatSeen', String(res.max_id));
    return;
  }
  const res = await api(`/api/chat?since_id=${Number.MAX_SAFE_INTEGER}&limit=1&unread_since=${chat.seenId}`);
  if (res.unread !== chat.unread) {
    chat.unread = res.unread;
    renderUnread();
  }
}

async function pollChat() {
  if (DUMMY || archived() || !chat.loaded || chat.loading || document.hidden || $('#view-chat').hidden) return;
  const res = await api(`/api/chat?since_id=${chat.maxId}&limit=200&unread_since=${chat.seenId ?? chat.maxId}`);
  if (res.more_after && !chat.moreAfter) return loadChatLatest().then(syncChatTime); // fell far behind
  // the chat log was reset while this page was open: start over with what came after
  if (res.start && chat.messages.length && chat.messages[0].ts < res.start) return loadChatLatest().then(syncChatTime);
  chat.maxId = Math.max(chat.maxId, res.max_id);
  chat.unread = res.unread ?? 0;
  renderUnread();
  if (!res.messages.length || chat.moreAfter || chat.loading) return;
  const known = new Set(chat.messages.map((m) => m.id));
  const fresh = res.messages.filter((m) => !known.has(m.id));
  if (!fresh.length) return;
  settlePending(fresh);
  const follow = fromBottom() < 60 && chat.pinned == null;
  const anchor = chatAnchor();
  chat.messages = chat.messages.concat(fresh).sort((a, b) => a.ts - b.ts || a.id - b.id);
  if (chat.messages.length > CHAT_KEEP) {
    chat.messages.splice(0, chat.messages.length - CHAT_KEEP);
    chat.moreBefore = true;
  }
  renderChat(new Set(fresh.map((m) => m.id)));
  if (follow) {
    chat.quietUntil = performance.now() + 800;
    chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
  } else {
    restoreAnchor(anchor);
  }
  markSeen();
  updateChatJump();
  syncChatTime();
}

/* ---------- sending chat into the game ---------- */

// Players whose login email is on the roster can send chat; the server mod shows it in game as
// "[Web] <name> message" and logs it, so it comes back into this log a few seconds later. Until
// the server says it showed it, it's faded under the log with a "sending…" tag; from then on it
// looks like any other message, and its logged copy takes its place when it arrives.
const compose = { me: null, sending: false, pending: [], checked: 0 };
const chatInput = $('#chat-input');

async function loadComposer() {
  const form = $('#chat-compose');
  if (DUMMY || archived() || SEASON !== CURRENT_SEASON) {
    form.hidden = true;
    return;
  }
  compose.checked = Date.now();
  try {
    compose.me = await api('/api/chat/me');
  } catch {
    compose.me = null;
  }
  renderComposer();
}

function renderComposer() {
  const me = compose.me;
  const form = $('#chat-compose');
  form.hidden = !me;
  if (!me) return;
  const can = !!((me.ign || me.admin) && me.linked);
  chatInput.disabled = !can;
  chatInput.placeholder = !me.ign && !me.admin
    ? (me.email ? `${me.email} isn't on the roster, so it can't send messages` : 'Sign in with your roster email to send messages')
    : !me.linked ? "The server isn't connected, so messages can't be sent right now"
    : `Message the server as ${me.admin ? 'Admin' : shownName(me.ign)}`;
  $('#chat-compose-me').replaceChildren(me.admin ? adminTag() : me.ign ? headImg(me.ign, 24) : '');
  updateComposeCount();
}

function updateComposeCount() {
  const max = compose.me?.max || 256;
  const n = chatInput.value.length;
  const left = $('#chat-count');
  left.textContent = n > max - 40 ? String(max - n) : '';
  left.classList.toggle('over', n > max);
  $('#chat-send').disabled = chatInput.disabled || compose.sending || !chatInput.value.trim() || n > max;
}

let composeErrTimer = 0;
function composeError(msg) {
  const box = $('#chat-compose-err');
  box.textContent = msg || '';
  box.hidden = !msg;
  clearTimeout(composeErrTimer);
  if (msg) composeErrTimer = setTimeout(() => { box.hidden = true; }, 6000);
}

function renderPending() {
  $('#chat-pending').replaceChildren(...compose.pending.map((p) => {
    const m = { kind: 'chat', name: p.name, ts: p.ts, text: p.text, uuid: null, via: p.admin ? 'admin' : 'web' };
    const group = msgGroup(m);
    if (!p.sent) {
      group.classList.add('msg-pending');
      group.querySelector('.msg-meta').append(el('span', { class: 'msg-tag', text: 'sending…' }));
    }
    group.lastChild.append(chatLine(m));
    return group;
  }));
}

// Messages that came back in the log replace their faded copies.
function settlePending(fresh) {
  if (!compose.pending.length) return;
  const before = compose.pending.length;
  for (const m of fresh) {
    if (m.via !== 'web' && m.via !== 'admin') continue;
    const i = compose.pending.findIndex((p) => p.text === m.text
      && (p.admin ? m.via === 'admin' : m.via === 'web' && p.name.toLowerCase() === (m.name || '').toLowerCase()));
    if (i >= 0) compose.pending.splice(i, 1);
  }
  if (compose.pending.length !== before) renderPending();
}

// Checks the log every second and a half until this message's logged copy has replaced it. If it
// hasn't after `ms`, it's taken down, and `missed` is called.
function watchPending(p, ms, missed) {
  const until = Date.now() + ms;
  const timer = setInterval(() => {
    if (!compose.pending.includes(p)) return clearInterval(timer);
    if (Date.now() < until) return void pollChat().catch(() => {});
    clearInterval(timer);
    compose.pending.splice(compose.pending.indexOf(p), 1);
    renderPending();
    missed?.();
  }, 1500);
}

async function sendChat() {
  const text = chatInput.value.trim();
  const me = compose.me;
  if (!text || compose.sending || !(me?.ign || me?.admin)) return;
  composeError('');
  compose.sending = true;
  const p = { name: me.admin ? null : me.ign, admin: !!me.admin, text, ts: Date.now(), sent: false };
  compose.pending.push(p);
  chatInput.value = '';
  updateComposeCount();
  if (chat.moreAfter) await loadChatLatest().catch(() => {});
  renderPending();
  chat.pinned = null;
  chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
  try {
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ text }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Your login expired; reload the page to sign in again.');
    if (!res.ok) {
      if (body.reason === 'offline') me.linked = false;
      throw new Error(body.error || `Couldn't send it (HTTP ${res.status}).`);
    }
    if (body.unsure) {
      // the server didn't answer in time, which isn't a no: it stays "sending…" while the log is watched for it
      watchPending(p, 20_000, () => {
        if (!chatInput.value) chatInput.value = text;
        updateComposeCount();
        composeError("The server didn't confirm that message and it hasn't shown up in the log, so it probably didn't arrive.");
      });
    } else {
      p.sent = true;
      renderPending();
      // the mod logs it right away; its logged copy is usually back within a few seconds
      watchPending(p, 60_000);
    }
  } catch (err) {
    compose.pending.splice(compose.pending.indexOf(p), 1);
    renderPending();
    if (!chatInput.value) chatInput.value = text; // give it back to try again
    composeError(err.message);
  } finally {
    compose.sending = false;
    renderComposer();
    if (!chatInput.disabled) chatInput.focus();
  }
}

$('#chat-compose').addEventListener('submit', (e) => {
  e.preventDefault();
  sendChat();
});
chatInput.addEventListener('input', () => {
  updateComposeCount();
  if (!$('#chat-compose-err').hidden) composeError('');
});

function updateChatJump() {
  const btn = $('#chat-jump');
  const n = chat.unread;
  btn.hidden = !n && !chat.moreAfter && fromBottom() < 400;
  btn.classList.toggle('unread', n > 0);
  btn.textContent = n ? `${n > 99 ? '99+' : n} unread ↓` : 'Jump to latest ↓';
}

$('#chat-jump').addEventListener('click', async () => {
  chat.pinned = null;
  if (chat.moreAfter) await loadChatLatest().catch((e) => showError(e.message));
  else chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
  updateChatJump();
  syncChatTime();
});

// Scroll events come at most once a frame, so everything that follows the scroll updates right here.
chatScroll.addEventListener('scroll', () => {
  if (performance.now() > chat.quietUntil) chat.pinned = null;
  chat.bottomGap = fromBottom();
  fillChat();
  markSeen();
  updateChatJump();
  syncChatTime();
}, { passive: true });

// When the log's box changes height (the graph folding, the window resizing), the bottom stays put.
new ResizeObserver(() => {
  if ($('#view-chat').hidden || !chat.loaded) return;
  setScroll(chatScroll.scrollHeight - chatScroll.clientHeight - chat.bottomGap);
  syncChatTime();
}).observe(chatScroll);

/* chat graph: players online, locked to the live 24h or one whole day, following the chat */

const liveDayWindow = () => presetWindow(presetByKey(TL_PRESETS, '24h'));

// The window showing t: the current one if t is on it, else the live 24h or t's whole day.
// The live window hands over to "yesterday" a little before t would slide off its left edge.
function chatWindowFor(t, cur) {
  const r = resolveWindow(cur);
  const margin = 600;
  if (cur.end == null ? t >= r.from + margin : t >= r.from && t < r.to) return cur;
  if (t >= nowSec() - 86400 + margin) return liveDayWindow();
  return { unit: 'day', count: 1, end: hourInfo(t).date, preset: '24h', byDay: true };
}

function syncChatPager() {
  const r = resolveWindow(chat.win);
  $('#cg-next').disabled = chat.win.end == null;
  $('#cg-prev').disabled = state.dataStart != null && r.from <= state.dataStart;
  $('#cg-label').textContent = windowLabel(chat.win, r, TL_PRESETS);
}

function setChatWindow(w, dir) {
  const prev = chat.win;
  chat.win = w;
  syncChatPager();
  loadChatGraph(pageShift(prev, w, dir)).catch((e) => showError(e.message));
}

$('#cg-prev').append(chevronIcon(-1));
$('#cg-next').append(chevronIcon(1));
$('#cg-prev').addEventListener('click', () => setChatWindow(shiftWindow(chat.win, -1), -1));
$('#cg-next').addEventListener('click', () => setChatWindow(shiftWindow(chat.win, 1), 1));

async function loadChatGraph(slide = 0) {
  const w = chat.win;
  const r = resolveWindow(w);
  const { from, to } = r;
  const req = ++chat.graphReq;
  syncChatPager();
  const [rows, ses] = await Promise.all([
    r.live ? loadSnapshots(from) : memoApi(`/api/snapshots?from=${from}&to=${to}`).then((x) => x.rows),
    r.live ? api(`/api/sessions?from=${from}&to=${to}`) : memoApi(`/api/sessions?from=${from}&to=${to}`),
  ]);
  if (req !== chat.graphReq) return; // the window moved on meanwhile
  chat.sessions = ses.rows.map(([uuid, name, a, b]) => ({ uuid, name, from: a, to: b + ses.poll_seconds }));
  const whoAt = (t) => [...new Set(chat.sessions.filter((s) => s.from < t + 1 && s.to > t).map((s) => s.name))];

  // While the graph pages, the cursor glides with it.
  const cursor = $('#cg-cursor');
  if (slide) {
    cursor.classList.add('sliding');
    clearTimeout(loadChatGraph.slideTimer);
    loadChatGraph.slideTimer = setTimeout(() => cursor.classList.remove('sliding'), SLIDE_MS);
  }
  renderLineChart($('#chat-chart'), {
    key: windowKey(w), from, to, step: POLL, ticks: 2, dataStart: chartStart(), whoAt,
    series: [{ name: 'online', cls: '1', color: 'var(--series-1)', area: true, pts: rows.map(([t, up, v]) => ({ t, v, down: !up })) }],
    fmtValue: (v) => `${v} ${v === 1 ? 'player' : 'players'}`,
    fmtTime: (t) => `${fmt(t, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · click to read`,
    onPick: (t) => jumpChatTo(t).catch((e) => showError(e.message)),
    onDraw: (g) => { chat.geom = g; placeCursor(); },
  }, { animate: live(), slide });
  renderOnlineThen(true);
}

// The cursor: a bold line at the chat's time, with a dot where it meets the players line.
function placeCursor() {
  const c = $('#cg-cursor');
  const g = chat.geom;
  // The live graph is redrawn once a minute, so anything newer than its last drawing is "now".
  const t = g && chat.win?.end == null && chat.t > g.to && chat.t <= nowSec() + 60 ? g.to : chat.t;
  if (!g || t == null || t < g.from || t > g.to) {
    c.classList.add('off');
    return;
  }
  c.classList.remove('off');
  c.style.transform = `translateX(${g.x(t)}px)`;
  c.style.top = `${g.top}px`;
  c.style.height = `${g.height}px`;
  const y = g.yAt(t);
  const dot = c.firstElementChild;
  dot.hidden = y == null;
  if (y != null) dot.style.top = `${y - g.top}px`;
}

const onlineHeads = new Map(); // reused so heads don't blink while scrolling
function renderOnlineThen(force = false) {
  const t = chat.t;
  if (t == null) return;
  const before = state.dataStart && t < state.dataStart;
  const people = before ? [] : [...new Map(chat.sessions.filter((s) => s.from <= t && s.to > t).map((s) => [s.uuid, s])).values()];
  const key = `${before}|${people.map((p) => p.uuid).join()}`;
  if (!force && key === chat.onlineKey) return;
  chat.onlineKey = key;
  $('#cg-online-n').textContent = people.length ? `· ${people.length}` : '';
  $('#cg-count').textContent = before ? '' : `${people.length} online`;
  const list = $('#cg-online-list');
  if (!people.length) {
    list.replaceChildren(el('div', { class: 'cg-online-none', text: before ? 'No data yet' : 'Nobody' }));
    return;
  }
  list.replaceChildren(...people.map((p) => {
    if (!onlineHeads.has(p.name)) onlineHeads.set(p.name, headImg(p.name, 16, { width: 16, height: 16, loading: 'eager' }));
    return playerLink(el('a', { class: 'cg-person' }, onlineHeads.get(p.name), colorName(el('span', { text: shownName(p.name) }), p.uuid, p.name)), p.uuid, p.name);
  }));
}

// Works out the chat's time from the scroll position and moves everything that follows it.
function syncChatTime() {
  if ($('#view-chat').hidden || !chat.win) return;
  const line = lastVisibleLine();
  const t = chat.pinned ?? (line ? line.ts / 1000 : nowSec());
  chat.t = t;
  $('#cg-time').textContent = cursorLabel(t);
  const w = chatWindowFor(t, chat.win);
  if (windowKey(w) !== windowKey(chat.win)) setChatWindow(w, t < resolveWindow(chat.win).from ? -1 : 1);
  placeCursor();
  renderOnlineThen();
}

/* folding the graph and the who's-online bar (remembered in the browser) */

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

$('#heat-team').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === heatTeam) return;
  heatTeam = b.dataset.v;
  remember('heatTeam', heatTeam);
  renderServerWeekGrid().catch((err) => showError(err.message));
});

function setGraphOpen(open) {
  $('#cg').classList.toggle('collapsed', !open);
  $('#cg-toggle').setAttribute('aria-expanded', String(open));
  remember('chatGraph', open ? 'open' : 'closed');
  if (open) requestAnimationFrame(() => redraws.get($('#chat-chart'))?.());
}
$('#cg-toggle').addEventListener('click', () => setGraphOpen($('#cg').classList.contains('collapsed')));
setGraphOpen(recall('chatGraph') !== 'closed');

function setOnlineBarOpen(open) {
  $('#chat-online').classList.toggle('collapsed', !open);
  $('#chat-online-pill').hidden = open;
  remember('chatOnline', open ? 'open' : 'closed');
}
$('#chat-online-close').addEventListener('click', () => setOnlineBarOpen(false));
$('#chat-online-pill').addEventListener('click', () => setOnlineBarOpen(true));
setOnlineBarOpen(recall('chatOnline') !== 'closed');

function renderChatOnline() {
  const st = state.status;
  const last = st.last;
  const fresh = last && nowSec() - last.ts <= 300;
  syncChips($('#chat-chips'), fresh ? st.online : [], '--surface');
  const empty = $('#chat-online-empty');
  const paused = pausedSince();
  empty.hidden = fresh && st.online.length > 0;
  empty.textContent = paused ? `Server paused since ${clock(paused)}`
    : !fresh ? 'No recent data' : !last.up ? 'Server offline' : 'Nobody online right now';
  const n = fresh && last.up ? last.online : 0;
  $('#chat-online-pill-text').textContent = paused ? 'Paused' : !fresh ? 'No data' : !last.up ? 'Offline' : `${n} online`;
  $('#chat-online-pill').classList.toggle('none', !n);
}

async function showChat({ refresh = false } = {}) {
  showView('chat');
  document.title = `Chat log · ${SITE}`;
  if (!refresh || Date.now() - compose.checked > 60_000) loadComposer();
  await loadStatus();
  renderChatOnline();
  if (refresh && chat.loaded) {
    if (chat.win?.end == null) await loadChatGraph();
    syncChatTime();
    return;
  }
  chat.loaded = false;
  chat.messages = [];
  chat.newFrom = chat.unread ? chat.seenId : null;
  renderChat();
  const jump = chat.pendingJump; // "Show in chat log" from a player's page
  chat.pendingJump = null;
  if (jump) await jumpChatTo(jump.ts / 1000, jump.id);
  else {
    await loadChatLatest();
    markSeen();
  }
  const line = lastVisibleLine();
  chat.t = chat.pinned ?? (line ? line.ts / 1000 : nowSec());
  chat.win = chatWindowFor(chat.t, liveDayWindow());
  await loadChatGraph();
  syncChatTime();
  updateChatJump();
  fillChat();
}

let chatTicks = 0;
setInterval(() => {
  if (document.hidden) return;
  if (!$('#view-chat').hidden) {
    pollChat().catch(() => {});
    // whether the server is connected, now and then (and sooner while it isn't)
    if (Date.now() - compose.checked > (compose.me?.linked ? 60_000 : 20_000)) loadComposer();
  } else if (chatTicks++ % 3 === 0) checkUnread().catch(() => {});
}, CHAT_POLL_MS);

/* ---------- player card: what a click on a name opens ---------- */

const pcard = el('div', { class: 'pcard', role: 'dialog', 'aria-label': 'Player', hidden: '' });
document.body.append(pcard);
let pcardFor = null;
let pcardReq = 0;
const playerChatCache = new Map(); // query -> { at, promise }

// key: "uuid=…" or "name=…"; events adds their messages, deaths and advancements.
function fetchPlayerChat(key, { events = false, fresh = false } = {}) {
  const k = `${key}|${events}`;
  const hit = playerChatCache.get(k);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.promise;
  const promise = api(`/api/chat/player?${key}&today=${startOfTodayTs()}${events ? '&events=1' : ''}`);
  playerChatCache.set(k, { at: Date.now(), promise });
  promise.catch(() => playerChatCache.delete(k));
  return promise;
}

const nameParts = (display, name) => (display
  ? swapParts(display, name).map((p) => (p.c ? el('span', { class: 'mc', style: mcStyle(p.c), text: p.t }) : p.t))
  : [shownName(name)]);

function playedBetween(sessions, from, to) {
  let total = 0;
  for (const [s, e] of sessions) {
    const overlap = Math.min(e, to) - Math.max(s, from);
    if (overlap > 0) total += overlap;
  }
  return total;
}

// Minutes online in each hour of the day, averaged over the last two weeks, as little bars.
function usualActivity(sessions) {
  // a finished season: averaged over all of it
  const days = archived() && state.dataStart ? Math.max(1, Math.round((nowSec() - state.dataStart) / 86400)) : 14;
  const from = nowSec() - days * 86400;
  const mins = Array(24).fill(0);
  for (const [s, e] of sessions) {
    if (e > from) eachHourChunk(Math.max(s, from), e, (h, secs) => { mins[hourInfo(h).hour] += secs / 60 / days; });
  }
  const W = 264, H = 58, top = 4, ph = 38, slot = W / 24;
  const max = Math.max(10, ...mins);
  const nowHour = hourInfo(nowSec()).hour;
  const svg = sv('svg', { width: '100%', height: H, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'pc-graph', role: 'img', 'aria-label': 'Usual activity by hour' });
  mins.forEach((v, h) => {
    const bh = Math.max(v > 0.5 ? 2 : 1, (v / max) * ph);
    const bar = sv('rect', { x: h * slot + 1, y: top + ph - bh, width: slot - 2, height: bh, rx: 1.5, class: `pc-bar${h === nowHour ? ' now' : ''}${v <= 0.5 ? ' zero' : ''}` });
    bar.dataset.h = h;
    svg.append(bar);
    if (h % 6 === 0) {
      const t = sv('text', { x: h * slot + 1, y: H - 2, class: 'axis-text' });
      t.textContent = hourName(h, true);
      svg.append(t);
    }
  });
  svg.addEventListener('pointermove', (e) => {
    const h = e.target.dataset?.h;
    if (h == null) return hideTip();
    const v = mins[h];
    showTip(e.clientX, e.clientY, [{ value: v < 1 ? 'Rarely on' : `${Math.round(v)} min`, label: v < 1 ? null : 'avg' },
      { label: `${hourName(Number(h))}–${hourName((Number(h) + 1) % 24)}, ${archived() ? 'whole season' : 'last 2 weeks'}` }]);
  });
  svg.addEventListener('pointerleave', hideTip);
  return svg;
}

function pcStat(value, label) {
  return el('div', { class: 'pc-stat' }, el('div', { class: 'pc-value', text: value }), el('div', { class: 'pc-label', text: label }));
}

function renderCard({ name, uuid, chatInfo, player, error }) {
  const display = chatInfo?.display;
  const headRow = el('div', { class: 'pc-head' },
    headImg(name || 'MHF_Steve', 48, { width: 48, height: 48, class: 'pc-avatar' }),
    el('div', { class: 'pc-who' },
      el('div', { class: 'pc-name' }, ...(rosterOf(name) ? [el('span', { class: `team-dot team-${rosterOf(name).team}`, title: TEAM_NAMES[rosterOf(name).team] || rosterOf(name).team })] : []),
        ...nameParts(display, name || '…')),
      el('div', { class: 'pc-status', id: 'pc-status' })));
  const kids = [headRow];
  if (error) {
    kids.push(el('div', { class: 'pc-note', text: error }));
  } else if (!player) {
    kids.push(el('div', { class: 'pc-note loading', text: 'Loading…' }));
  } else {
    const sessions = player.sessions.map(([s, e]) => [s, e + player.poll_seconds]);
    const lastTs = state.status?.last?.ts;
    const online = !archived() && lastTs != null && player.sessions.length && player.sessions.at(-1)[1] === lastTs;
    const status = headRow.querySelector('.pc-status');
    if (online) status.append(el('span', { class: 'pc-dot' }), `Online since ${clock(player.sessions.at(-1)[0])}`);
    else status.textContent = player.sessions.length ? `Last seen ${ago(player.sessions.at(-1)[1])}` : 'Not seen yet';
    const now = nowSec();
    kids.push(
      archived()
        ? el('div', { class: 'pc-stats' },
          pcStat(chatInfo.total.toLocaleString(), chatInfo.total === 1 ? 'message' : 'messages'),
          pcStat(dur(playedBetween(sessions, 0, now)), 'played'),
          pcStat(sessions.length.toLocaleString(), sessions.length === 1 ? 'session' : 'sessions'))
        : el('div', { class: 'pc-stats' },
          pcStat(chatInfo.today.toLocaleString(), chatInfo.today === 1 ? 'message today' : 'messages today'),
          pcStat(dur(playedBetween(sessions, startOfTodayTs(), now)), 'played today'),
          pcStat(dur(playedBetween(sessions, now - 7 * 86400, now)), 'last 7 days')),
      el('div', { class: 'pc-section', text: 'Usually on' }),
      usualActivity(sessions),
      el('a', { class: 'pc-open', href: `#/player/${uuid}` }, 'View profile', el('span', { 'aria-hidden': 'true', text: ' →' })),
    );
  }
  pcard.replaceChildren(...kids);
}

function placeCard() {
  if (!pcardFor || pcard.hidden) return;
  const r = pcardFor.getBoundingClientRect();
  const w = pcard.offsetWidth, h = pcard.offsetHeight;
  const x = Math.min(Math.max(8, r.left), innerWidth - w - 8);
  let y = r.bottom + 6;
  if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
  pcard.style.left = `${x}px`;
  pcard.style.top = `${y}px`;
}

async function openCard(a) {
  if (pcardFor === a && !pcard.hidden) return closeCard();
  hideTip();
  pcardFor = a;
  const req = ++pcardReq;
  let uuid = a.dataset.uuid || null;
  let name = a.dataset.name || knownNames.get(uuid) || '';
  renderCard({ name, uuid });
  pcard.hidden = false;
  if (!reducedMotion()) pcard.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 140, easing: 'ease-out' });
  placeCard();
  try {
    const chatInfo = await fetchPlayerChat(uuid ? `uuid=${uuid}` : `name=${encodeURIComponent(name)}`);
    uuid = chatInfo.uuid;
    name = chatInfo.name;
    knownNames.set(uuid, name);
    const player = await fetchPlayer(uuid);
    if (req !== pcardReq) return;
    renderCard({ name, uuid, chatInfo, player });
  } catch (err) {
    if (req !== pcardReq) return;
    renderCard({ name, uuid, error: /→ 404$/.test(err.message) ? 'Not seen on the server yet.' : 'Couldn’t load this player.' });
  }
  placeCard();
}

function closeCard() {
  pcard.hidden = true;
  pcardFor = null;
  pcardReq++;
  hideTip();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-card]');
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  openCard(a);
});
document.addEventListener('pointerdown', (e) => {
  if (!pcard.hidden && !pcard.contains(e.target) && !e.target.closest('[data-card]')) closeCard();
});
for (const type of ['wheel', 'touchmove']) {
  document.addEventListener(type, (e) => { if (!pcard.hidden && !pcard.contains(e.target)) closeCard(); }, { passive: true });
}
window.addEventListener('resize', () => { if (!pcard.hidden) closeCard(); });
window.addEventListener('scroll', () => { if (!pcard.hidden) closeCard(); }, { passive: true }); // the page, not the chat log
window.addEventListener('hashchange', closeCard);

// A chat mark picked on a player's activity strip: a look at it, and a way to it in the chat log.
function openChatPeek([id, ts, kind, text], x, y) {
  const anchor = { getBoundingClientRect: () => new DOMRect(x - 8, y, 0, 0) };
  if (pcardFor?.peek === id && !pcard.hidden) return closeCard();
  hideTip();
  pcardFor = anchor;
  anchor.peek = id;
  pcardReq++;
  const d = state.playerData;
  const name = knownNames.get(state.playerShown) || '';
  const what = CHAT_KINDS[kind] || CHAT_KINDS.chat;
  const talk = kind === 'chat' || kind === 'say' || kind === 'emote';
  const go = el('button', { type: 'button', class: 'pc-open', text: 'Show in chat log →' });
  go.addEventListener('click', () => {
    chat.pendingJump = { id, ts };
    closeCard();
    location.hash = '#/chat';
  });
  pcard.replaceChildren(
    el('div', { class: 'peek-head' },
      el('span', { class: 'key', style: `background:${what.color}` }),
      el('span', { class: 'peek-kind', text: what.label }),
      el('time', { text: fmt(ts / 1000, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) })),
    el('div', { class: `peek-text peek-${kind}` },
      ...(talk ? [el('span', { class: 'msg-name' }, ...nameParts(d?.chat?.display, name)), kind === 'emote' ? ' ' : ': '] : []),
      text.length >= 200 ? `${text}…` : text),
    go);
  pcard.hidden = false;
  placeCard();
}

/* ---------- chat search (⌘F / Ctrl+F on the chat page) ---------- */

const search = { q: '', in: 'all', from: '', kind: '', results: [], more: false, req: 0, players: null, timer: 0 };
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
$('#search-kbd').textContent = isMac ? '⌘F' : 'Ctrl F';

function openSearch() {
  closeCard();
  $('#search-pop').hidden = false;
  $('#search-btn').setAttribute('aria-expanded', 'true');
  const q = $('#search-q');
  q.focus();
  q.select();
  loadSearchPlayers().catch(() => {});
  if (!search.results.length) renderSearch();
}

function closeSearch() {
  $('#search-pop').hidden = true;
  $('#search-btn').setAttribute('aria-expanded', 'false');
}

async function loadSearchPlayers() {
  if (search.players) return;
  const { players } = await api('/api/chat/players');
  search.players = players;
  for (const p of players) knownNames.set(p.uuid, p.name);
  $('#sf-from').append(...players.map((p) => el('option', { value: p.uuid, text: p.n ? `${p.name} (${p.n.toLocaleString()})` : p.name })));
}

function syncSearchFilters() {
  for (const b of $('#sf-in').children) b.setAttribute('aria-pressed', String(b.dataset.v === search.in));
  const n = (search.in !== 'all') + !!search.from + !!search.kind;
  const badge = $('#search-filter-n');
  badge.hidden = !n;
  badge.textContent = n;
}

async function runSearch(more = false) {
  const q = search.q.trim();
  if (!q && !search.from && !search.kind) {
    search.results = [];
    search.more = false;
    search.req++;
    renderSearch();
    return;
  }
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (q && search.in !== 'all') params.set('in', search.in);
  if (search.from) params.set('from', search.from);
  if (search.kind) params.set('kind', search.kind);
  if (more) {
    const last = search.results.at(-1);
    params.set('before', `${last.ts}:${last.id}`);
  }
  const req = ++search.req;
  if (!more) $('#search-results').classList.add('busy');
  try {
    const res = await api(`/api/chat/search?${params}`);
    if (req !== search.req) return;
    search.results = more ? search.results.concat(res.results) : res.results;
    search.more = res.more;
    renderSearch();
    if (!more) $('#search-results').scrollTop = 0;
  } finally {
    if (req === search.req) $('#search-results').classList.remove('busy');
  }
}

// Where the words matched, marked.
function highlighted(text, q) {
  if (!q) return [text];
  const out = [];
  const lower = text.toLowerCase(), needle = q.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, at)) {
    if (i > at) out.push(text.slice(at, i));
    out.push(el('mark', { text: text.slice(i, i + needle.length) }));
    at = i + needle.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function searchItem(m) {
  const talk = m.kind === 'chat' || m.kind === 'say' || m.kind === 'emote';
  const q = search.q.trim();
  const shown = displayText(m);
  // a system line already starts with the name, which the header shows
  const text = talk || !m.text.startsWith(shown) ? m.text : m.text.slice(shown.length).trim();
  const own = m.display?.find((p) => p.c && m.name && p.t.includes(m.name));
  const item = el('button', { type: 'button', class: `sr-item sr-${m.kind}` },
    el('div', { class: 'sr-meta' },
      talk ? chatAvatar(m, 16) : el('span', { class: 'sr-icon' }, icon(SYS_ICONS[m.kind] || SYS_ICONS.system, 13)),
      el('span', { class: `sr-name${own ? ' mc' : ''}`, ...(own && { style: mcStyle(own.c) }) },
        ...highlighted(shown, search.in === 'text' ? '' : q)),
      el('time', { text: `${relativeDay(hourInfo(m.ts / 1000).date, { month: 'short', day: 'numeric' })} · ${clock(m.ts / 1000)}` })),
    el('div', { class: 'sr-text' }, ...highlighted(text, search.in === 'name' ? '' : q)));
  item.addEventListener('click', () => {
    for (const x of $('#search-results').querySelectorAll('.sr-item.current')) x.classList.remove('current');
    item.classList.add('current');
    jumpChatTo(m.ts / 1000, m.id).catch((e) => showError(e.message));
  });
  return item;
}

function renderSearch() {
  const root = $('#search-results');
  const q = search.q.trim();
  if (!q && !search.from && !search.kind) {
    root.replaceChildren(el('div', { class: 'sr-hint' },
      'Type to search messages and names. ',
      el('button', { type: 'button', class: 'link-btn', text: 'Filters' }), ' narrow it to one player or kind of message.'));
    root.querySelector('.link-btn').addEventListener('click', () => toggleFilters(true));
    return;
  }
  if (!search.results.length) {
    root.replaceChildren(el('div', { class: 'sr-hint', text: 'No messages found.' }));
    return;
  }
  const n = search.results.length;
  const kids = [el('div', { class: 'sr-count', text: `${n}${search.more ? '+' : ''} ${n === 1 ? 'result' : 'results'}, newest first` }), ...search.results.map(searchItem)];
  if (search.more) {
    const more = el('button', { type: 'button', class: 'sr-more', text: 'Show older results' });
    more.addEventListener('click', () => { more.disabled = true; runSearch(true).catch((e) => showError(e.message)); });
    kids.push(more);
  }
  root.replaceChildren(...kids);
}

function toggleFilters(open = $('#search-filters').hidden) {
  $('#search-filters').hidden = !open;
  $('#search-filter-btn').setAttribute('aria-expanded', String(open));
}

const searchSoon = () => {
  clearTimeout(search.timer);
  search.timer = setTimeout(() => runSearch().catch((e) => showError(e.message)), 220);
};
$('#search-btn').addEventListener('click', () => ($('#search-pop').hidden ? openSearch() : closeSearch()));
$('#search-close').addEventListener('click', closeSearch);
$('#search-filter-btn').addEventListener('click', () => toggleFilters());
$('#search-q').addEventListener('input', (e) => { search.q = e.target.value; searchSoon(); });
$('#search-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(search.timer); runSearch().catch((err) => showError(err.message)); }
  if (e.key === 'ArrowDown') { e.preventDefault(); $('#search-results .sr-item')?.focus(); }
});
$('#search-results').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...$('#search-results').querySelectorAll('.sr-item')];
  const i = items.indexOf(document.activeElement);
  if (i === -1) return;
  e.preventDefault();
  if (e.key === 'ArrowUp' && i === 0) $('#search-q').focus();
  else items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
});
$('#sf-in').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  search.in = b.dataset.v;
  syncSearchFilters();
  if (search.q.trim()) searchSoon();
});
$('#sf-from').addEventListener('change', (e) => { search.from = e.target.value; syncSearchFilters(); searchSoon(); });
$('#sf-kind').addEventListener('change', (e) => { search.kind = e.target.value; syncSearchFilters(); searchSoon(); });
syncSearchFilters();

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f' && !$('#view-chat').hidden) {
    e.preventDefault();
    openSearch();
  } else if (e.key === 'Escape') {
    if (!pcard.hidden) closeCard();
    else if (!$('#search-pop').hidden) closeSearch();
  }
});

/* ---------- combat: kills and deaths ---------- */

// Every death in the season comes from /api/combat once (then only what's new), and the Combat
// page and each player's combat card are worked out from it here, for whatever range is picked.

const CAUSE_LABELS = {
  melee: 'Slain', shot: 'Shot', explosion: 'Explosion', fall: 'Fall', fire: 'Fire', lava: 'Lava', drown: 'Drowning',
  void: 'The void', border: 'World border', magic: 'Magic', wither: 'Wither', sonic: 'Sonic boom', lightning: 'Lightning', crush: 'Crushed',
  suffocation: 'Suffocation', starve: 'Starvation', thorns: 'Thorns', freeze: 'Freezing', other: 'Other',
};
const mobLabel = (mob) => mob.replace(/^.*:/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
// What ended a death no player caused: the creature if there was one, else how.
const naturalCause = (d) => (d.mob ? mobLabel(d.mob) : CAUSE_LABELS[d.cause] || 'Other');
// a sword, point up and to the right: blade, crossguard, grip, pommel
const SWORD_ICON = ['M13.5 2.5 10.6 3 4.9 8.7', 'M13.5 2.5 13 5.4 7.3 11.1', 'M3.4 7.2l5.4 5.4', 'M6.1 9.9 3.4 12.6', 'M2.7 13.3h.01'];
const TEAMS = ['red', 'blue'];
const TEAM_SHORT = { red: 'Red', blue: 'Blue' };
const teamOf = (name) => rosterOf(name)?.team ?? null;

const combat = {
  rows: [], // every death this season, oldest first: { id, ts (seconds), victim, killer, cause, mob }
  uuids: new Map(), // lowercased name -> uuid, for the players named in them
  maxId: 0,
  loaded: false,
  pending: null,
  sort: (() => {
    const [key, dir] = (recall('combatSort') || '').split(':');
    return ['name', 'kills', 'deaths', 'kd'].includes(key) ? { key, dir: dir === '1' ? 1 : -1 } : { key: 'kills', dir: -1 };
  })(),
  chartMode: recall('combatChart') === 'total' ? 'total' : 'each',
  view: null, // what the page last drew: { from, to, rows, buckets, hourly }
};

// Loads the season's deaths; later calls fetch only what's been logged since.
function loadCombat() {
  if (combat.pending) return combat.pending;
  if (combat.loaded && archived()) return Promise.resolve();
  combat.pending = (async () => {
    const res = await api(combat.loaded ? `/api/combat?after=${combat.maxId}` : '/api/combat');
    for (const [name, uuid] of Object.entries(res.uuids || {})) combat.uuids.set(name, uuid);
    const have = new Set(combat.rows.map((d) => d.id));
    const fresh = res.rows.filter((r) => !have.has(r[0])).map(([id, ts, victim, killer, cause, mob]) => ({ id, ts, victim, killer, cause, mob }));
    for (const d of fresh) {
      for (const n of [d.victim, d.killer]) {
        const uuid = n && combat.uuids.get(n.toLowerCase());
        if (uuid && !knownNames.has(uuid)) knownNames.set(uuid, n);
      }
    }
    if (fresh.length) combat.rows = combat.rows.concat(fresh).sort((a, b) => a.ts - b.ts || a.id - b.id);
    combat.maxId = Math.max(combat.maxId, res.max_id || 0);
    combat.loaded = true;
    return fresh.length;
  })().finally(() => { combat.pending = null; });
  return combat.pending;
}

const combatUuid = (name) => combat.uuids.get(name.toLowerCase()) || uuidForName(name);

// Kills, deaths and K/D for everyone in these deaths (and everyone on the roster, even with none).
function combatPlayers(rows, { everyone = true } = {}) {
  const by = new Map();
  const get = (name) => {
    const key = name.toLowerCase();
    if (!by.has(key)) by.set(key, { key, name: rosterOf(name)?.ign || name, kills: 0, deaths: 0, pvpDeaths: 0 });
    return by.get(key);
  };
  if (everyone) for (const p of roster.values()) get(p.ign);
  for (const d of rows) {
    const v = get(d.victim);
    v.deaths++;
    if (d.killer) {
      v.pvpDeaths++;
      get(d.killer).kills++;
    }
  }
  for (const p of by.values()) p.kd = p.kills / Math.max(1, p.deaths);
  return [...by.values()];
}
const fmtKd = (p) => (p.kills + p.deaths === 0 ? '–' : p.kd.toFixed(2));

/* the range the whole page shows */

const COMBAT_PRESETS = [
  { v: '24h', label: '24h', unit: 'hour', count: 24, long: 'Last 24 hours' },
  dayPreset(7), dayPreset(30),
  { v: 'all', label: 'All', unit: 'all', count: 0, long: 'All time' },
];

// The picked range as { from, to, rows (the deaths in it), buckets, hourly }: one bucket per hour
// for up to two days, else one per day.
function combatView() {
  const w = cbCtl.get();
  let r = resolveWindow(w);
  if (w.unit === 'all') {
    const first = Math.min(state.dataStart ?? nowSec(), combat.rows[0]?.ts ?? nowSec());
    const now = nowSec();
    r = now - first <= 48 * 3600
      ? resolveWindow({ unit: 'hour', count: Math.max(6, Math.ceil((currentHourEnd() - first) / 3600)), end: null })
      : resolveWindow({ unit: 'day', count: Math.min(400, daysCovered(first)), end: null });
    r = { ...r, all: true };
  }
  const rows = r.all ? combat.rows : combat.rows.filter((d) => d.ts >= r.from && d.ts < r.to);
  return { ...r, w, rows, hourly: r.buckets[0].end - r.buckets[0].start <= 3600 };
}

/* Red vs Blue: each side's deaths, split by what caused them */

function factionTotals(rows) {
  const t = { red: { kills: 0, own: 0, other: 0, deaths: 0 }, blue: { kills: 0, own: 0, other: 0, deaths: 0 }, noTeam: 0 };
  for (const d of rows) {
    const vt = teamOf(d.victim);
    const kt = d.killer ? teamOf(d.killer) : null;
    if (!t[vt]) { t.noTeam++; continue; }
    t[vt].deaths++;
    if (kt && kt !== vt && t[kt]) t[kt].kills++;
    else if (kt === vt) t[vt].own++;
    else t[vt].other++;
  }
  return t;
}

// One long bar. Left of the divider is every Blue death: the ones nobody caused (hatched), then
// Blue's own team kills, then Red's kills, ending at the divider. Right of it, mirrored, is every
// Red death: Blue's kills from the divider out, then Red's team kills, then the rest.
function renderFactionBar() {
  const card = $('#cb-score-card');
  card.hidden = !roster.size;
  if (!roster.size || !combat.view) return;
  const root = $('#cb-score');
  const t = factionTotals(combat.view.rows);
  const total = t.red.deaths + t.blue.deaths;
  const seg = (cls, n, tipRows) => {
    if (!n) return null;
    const s = el('div', { class: `fb-seg ${cls}`, style: `flex-grow:${n}` }, n / total > 0.06 ? el('span', { text: String(n) }) : null);
    s.tipRows = tipRows;
    return s;
  };
  const tipRow = (n, what, color) => [{ value: n.toLocaleString(), label: what, color }];
  const segs = [
    seg('fb-other fb-blue', t.blue.other, tipRow(t.blue.other, 'Other Blue deaths: mobs, falls, lava…', 'var(--team-blue)')),
    seg('fb-own fb-blue', t.blue.own, tipRow(t.blue.own, 'Blue players killed by their own faction', 'var(--team-blue)')),
    seg('fb-kills fb-red', t.red.kills, tipRow(t.red.kills, 'Blue players killed by Red', 'var(--team-red)')),
    seg('fb-kills fb-blue', t.blue.kills, tipRow(t.blue.kills, 'Red players killed by Blue', 'var(--team-blue)')),
    seg('fb-own fb-red', t.red.own, tipRow(t.red.own, 'Red players killed by their own faction', 'var(--team-red)')),
    seg('fb-other fb-red', t.red.other, tipRow(t.red.other, 'Other Red deaths: mobs, falls, lava…', 'var(--team-red)')),
  ].filter(Boolean);

  // the divider sits where Blue's deaths end; the kill counts hang off it, kept on screen
  const split = total ? (t.blue.deaths / total) * 100 : 50;
  const room = Math.min(42, (118 / Math.max(280, root.clientWidth || 600)) * 100);
  const at = Math.min(100 - room, Math.max(room, split));
  const kills = (team, style) => el('div', { class: `fb-count fb-${team}`, style },
    el('strong', { text: t[team].kills.toLocaleString() }), el('span', { text: `${TEAM_SHORT[team]} ${t[team].kills === 1 ? 'kill' : 'kills'}` }));
  const end = (team) => el('div', { class: `fb-end fb-${team}` },
    el('strong', { text: t[team].deaths.toLocaleString() }), ` ${TEAM_SHORT[team]} ${t[team].deaths === 1 ? 'death' : 'deaths'}`);
  const key = (cls, text) => el('span', {}, el('i', { class: `fb-key ${cls}` }), text);

  const bar = el('div', { class: `fb-bar${total ? '' : ' empty'}` }, ...segs,
    total ? el('i', { class: 'fb-mid', style: `left:${split}%` }) : el('span', { class: 'fb-none', text: 'No deaths in this range yet' }));
  root.replaceChildren(
    el('div', { class: 'fb-counts' }, kills('red', `right:${100 - at}%`), kills('blue', `left:${at}%`)),
    bar,
    el('div', { class: 'fb-ends' }, end('blue'), end('red')),
    el('div', { class: 'legend fb-legend' },
      key('fb-kills fb-red', 'Red kills'), key('fb-kills fb-blue', 'Blue kills'),
      ...(t.red.own + t.blue.own ? [key('fb-own fb-mix', 'Killed by their own faction')] : []),
      key('fb-other fb-mix', 'Other deaths (mobs, falls, lava…)'),
      ...(t.noTeam ? [el('span', { class: 'muted', text: `${t.noTeam} by players without a faction not shown` })] : [])),
  );
  attachCellTips(bar, '.fb-seg', (s) => s.tipRows);
  redraws.set(root, renderFactionBar);
}

/* kills and deaths over time */

// The three things a death can be, for the chart: a kill by each faction, or anything else.
// Without factions (an earlier season) it's kills by players and everything else.
function combatSeries() {
  if (!roster.size) {
    return [
      { key: 'pvp', label: 'Killed by a player', color: 'var(--series-1)', is: (d) => !!d.killer },
      { key: 'other', label: 'Other deaths', color: 'var(--muted)', is: () => true },
    ];
  }
  const by = (team) => (d) => d.killer && teamOf(d.killer) === team && teamOf(d.victim) !== team;
  return [
    { key: 'red', label: 'Red kills', color: 'var(--team-red)', is: by('red') },
    { key: 'blue', label: 'Blue kills', color: 'var(--team-blue)', is: by('blue') },
    { key: 'other', label: 'Other deaths', color: 'var(--muted)', is: () => true },
  ];
}

function renderCombatChart() {
  const v = combat.view;
  if (!v) return;
  const root = $('#cb-chart');
  const series = combatSeries().map((s) => ({ ...s, vals: v.buckets.map(() => 0) }));
  let i = 0;
  for (const d of v.rows) {
    while (i < v.buckets.length - 1 && d.ts >= v.buckets[i].end) i++;
    if (d.ts < v.buckets[i].start) continue;
    series.find((s) => s.is(d)).vals[i]++;
  }
  const total = combat.chartMode === 'total';
  $('#cb-mode-each').textContent = v.hourly ? 'Per hour' : 'Per day';
  for (const b of $('#cb-chart-mode').children) b.setAttribute('aria-pressed', String(b.dataset.v === combat.chartMode));
  $('#cb-chart-label').textContent = total ? 'adding up since the start of the range' : v.hourly ? 'each hour' : 'each day';
  $('#cb-legend').replaceChildren(...series.map((s) => el('span', {},
    el('i', { class: `cb-key${total ? ' line' : ''}${s.key === 'other' ? ' other' : ''}`, style: `--c:${s.color}` }), s.label)));
  if (!v.rows.length) {
    redraws.delete(root);
    root.replaceChildren(el('div', { class: 'empty-chart', text: combat.rows.length ? 'No kills or deaths in this range.' : 'No kills or deaths yet this season.' }));
    return;
  }
  const spec = { buckets: v.buckets, hourly: v.hourly, series, total, start: chartStart() };
  redraws.set(root, () => drawCombatChart(root, spec));
  drawCombatChart(root, spec);
}

// Stacked bars per hour or day, or (total) one rising line per series.
function drawCombatChart(root, spec) {
  root.replaceChildren();
  const { buckets, series, total, hourly } = spec;
  const n = buckets.length;
  const W = Math.max(280, root.clientWidth);
  const H = root.clientHeight || 200;
  const m = { l: 30, r: total ? 10 : 4, t: 10, b: 24 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const slot = pw / n;
  const from = buckets[0].start, to = buckets[n - 1].end;

  // running totals per series, or the height of each bucket's stack
  const sums = series.map((s) => { let acc = 0; return s.vals.map((x) => (acc += x)); });
  const vmax = total ? Math.max(1, ...sums.map((a) => a[n - 1])) : Math.max(1, ...buckets.map((_, i) => series.reduce((a, s) => a + s.vals[i], 0)));
  const ystep = Math.max(1, niceStep(vmax / 4));
  const ymax = Math.max(ystep * 2, Math.ceil(vmax / ystep) * ystep);
  const y = (val) => m.t + ph - (val / ymax) * ph;
  const xAt = (t) => {
    if (t <= from) return m.l;
    if (t >= to) return m.l + pw;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (buckets[mid].start <= t) lo = mid; else hi = mid - 1;
    }
    return m.l + slot * (lo + (t - buckets[lo].start) / (buckets[lo].end - buckets[lo].start));
  };

  const svg = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Kills and deaths over time' });
  for (let val = 0; val <= ymax + 1e-9; val += ystep) {
    if (val > 0) svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(val), y2: y(val), class: 'gridline' }));
    const tx = sv('text', { x: m.l - 6, y: y(val) + 4, 'text-anchor': 'end', class: 'axis-text' });
    tx.textContent = String(val);
    svg.append(tx);
  }
  const firstBar = spec.start && (buckets.find((bk) => spec.start < bk.end)?.start ?? spec.start);
  if (spec.start && firstBar > from) noDataBlock(svg, svg, `${root.id}-hatch`, m.l, xAt(firstBar), m.t, ph);

  const labelEvery = hourly
    ? (slot >= 36 ? 1 : slot >= 18 ? 2 : slot >= 12 ? 3 : 6)
    : (slot >= 44 ? 1 : slot >= 22 ? 2 : slot >= 14 ? 3 : slot >= 7 ? 7 : 14);
  const gap = slot >= 8 ? 2 * Math.max(2, slot * 0.15) : slot * 0.3;
  const bw = Math.min(40, slot - gap);
  const stacks = [];
  buckets.forEach((b, i) => {
    const cx = m.l + slot * (i + 0.5);
    if (!total) {
      const g = sv('g', { class: 'cb-stack' });
      let acc = 0;
      const live = series.filter((s) => s.vals[i] > 0);
      live.forEach((s, k) => {
        const y1 = y(acc), y0 = y(acc + s.vals[i]);
        acc += s.vals[i];
        const x0 = cx - bw / 2, x1 = cx + bw / 2;
        const top = k === live.length - 1;
        const r = top ? Math.min(3, (y1 - y0) / 2, bw / 2) : 0;
        g.append(sv('path', {
          d: `M${x0},${y1 - (k ? 1 : 0)}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x1 - r}Q${x1},${y0} ${x1},${y0 + r}V${y1 - (k ? 1 : 0)}Z`,
          style: `fill:${s.color}`, class: s.key === 'other' ? 'cb-other' : '',
        }));
      });
      svg.append(g);
      stacks[i] = g;
    }
    if ((n - 1 - i) % labelEvery === 0) {
      const tx = sv('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'axis-text' });
      if (hourly) tx.textContent = hourName(hourInfo(b.start).hour, true);
      else {
        const day = Number(b.date.slice(8));
        tx.textContent = b.date === todayStr() && !archived() ? 'Today'
          : day === 1 || slot >= 44 || i < labelEvery || labelEvery >= 7 ? fmtDay(b.date, { month: 'short', day: 'numeric' })
          : String(day);
      }
      svg.append(tx);
    }
  });
  svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), class: 'baseline' }));

  let cross = null;
  const dots = [];
  if (total) {
    // "other" underneath, the factions on top
    for (const k of series.map((_, idx) => idx).reverse()) {
      const s = series[k];
      let d = `M${m.l},${y(0)}`;
      sums[k].forEach((val, i) => { d += `L${m.l + slot * (i + 1)},${y(val)}`; });
      svg.append(sv('path', { d, class: `cb-line${s.key === 'other' ? ' other' : ''}`, style: `stroke:${s.color}` }));
      const dot = sv('circle', { r: 3.5, class: 'cb-dot', style: `fill:${s.color}`, visibility: 'hidden' });
      dots[k] = dot;
    }
    cross = sv('line', { y1: m.t, y2: m.t + ph, class: 'crosshair', visibility: 'hidden' });
    svg.append(cross, ...dots.filter(Boolean));
  }

  const when = (b) => (hourly
    ? `${fmt(b.start, { weekday: 'short', month: 'short', day: 'numeric' })}, ${hourName(hourInfo(b.start).hour)}–${hourName(hourInfo(b.end).hour)}`
    : fmtDay(b.date));
  let hovered = null;
  const clear = () => {
    hovered?.classList.remove('hover');
    hovered = null;
    cross?.setAttribute('visibility', 'hidden');
    for (const d of dots) d?.setAttribute('visibility', 'hidden');
    hideTip();
  };
  const move = (e) => {
    const px = e.clientX - svg.getBoundingClientRect().left;
    if (px < m.l || px > m.l + pw) return clear();
    const i = Math.min(n - 1, Math.max(0, Math.floor((px - m.l) / slot)));
    const b = buckets[i];
    if (total) {
      const x = m.l + slot * (i + 1);
      cross.setAttribute('x1', x);
      cross.setAttribute('x2', x);
      cross.setAttribute('visibility', 'visible');
      dots.forEach((d, k) => {
        d.setAttribute('cx', x);
        d.setAttribute('cy', y(sums[k][i]));
        d.setAttribute('visibility', 'visible');
      });
    } else if (hovered !== stacks[i]) {
      hovered?.classList.remove('hover');
      hovered = stacks[i] || null;
      hovered?.classList.add('hover');
    }
    showTip(e.clientX, e.clientY, [
      { label: total ? `By the end of ${hourly ? hourName(hourInfo(b.start).hour) : fmtDay(b.date, { weekday: 'short', month: 'short', day: 'numeric' })}` : when(b) },
      ...series.map((s, k) => ({ value: String(total ? sums[k][i] : s.vals[i]), label: s.label, color: s.color })),
    ]);
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', clear);
  root.append(svg);
}

/* the leaderboard: click a column heading to sort by it */

const COMBAT_COLS = [
  { key: 'name', label: 'Player', first: 1, hint: 'Sort by name' },
  { key: 'kills', label: 'Kills', first: -1, hint: 'Players they killed' },
  { key: 'deaths', label: 'Deaths', first: -1, hint: 'Every time they died, to a player or not' },
  { key: 'kd', label: 'K/D', first: -1, hint: 'Kills for every death' },
];

function sortCombat(players) {
  const { key, dir } = combat.sort;
  const byName = (a, b) => shownName(a.name).localeCompare(shownName(b.name), undefined, { sensitivity: 'base' });
  return players.sort((a, b) => {
    if (key === 'name') return dir * byName(a, b);
    // players with no kills or deaths go last whichever way it's sorted
    const quietA = a.kills + a.deaths === 0, quietB = b.kills + b.deaths === 0;
    if (quietA !== quietB) return quietA ? 1 : -1;
    return dir * (a[key] - b[key]) || b.kills - a.kills || a.deaths - b.deaths || byName(a, b);
  });
}

function sortArrow(dir) {
  const s = sv('svg', { width: 10, height: 12, viewBox: '0 0 10 12', 'aria-hidden': 'true', class: 'sort-arrow' });
  s.append(sv('path', { d: 'M2 4.5 5 1.5l3 3', class: dir > 0 ? 'on' : '' }), sv('path', { d: 'M2 7.5l3 3 3-3', class: dir < 0 ? 'on' : '' }));
  return s;
}

function renderCombatLeaderboard() {
  const v = combat.view;
  if (!v) return;
  const root = $('#cb-leaderboard');
  const players = sortCombat(combatPlayers(v.rows));
  const { key, dir } = combat.sort;
  const active = players.filter((p) => p.kills + p.deaths > 0).length;
  $('#cb-lb-note').textContent = players.length
    ? `${active} of ${players.length} ${players.length === 1 ? 'player has' : 'players have'} a kill or death · sorted by ${key === 'kd' ? 'K/D' : COMBAT_COLS.find((c) => c.key === key).label.toLowerCase()}`
    : '';
  if (!players.length) {
    root.replaceChildren(el('div', { class: 'empty', text: 'No kills or deaths in this range yet.' }));
    return;
  }
  const oldTops = rowTops(root);
  // the bar under each name is the column it's sorted by
  const barKey = key === 'name' ? 'kills' : key;
  const top = Math.max(...players.map((p) => p[barKey]), 0) || 1;

  const head = el('tr', {}, el('th', {}));
  for (const c of COMBAT_COLS) {
    const on = c.key === key;
    const btn = el('button', { type: 'button', title: on ? `${c.hint} (click to reverse)` : c.hint }, el('span', { text: c.label }), sortArrow(on ? dir : 0));
    btn.addEventListener('click', () => {
      combat.sort = on ? { key, dir: -dir } : { key: c.key, dir: c.first };
      remember('combatSort', `${combat.sort.key}:${combat.sort.dir}`);
      renderCombatLeaderboard();
    });
    head.append(el('th', { class: `sortable${c.key === 'name' ? '' : ' num'}${on ? ' sorted' : ''}`, 'aria-sort': on ? (dir < 0 ? 'descending' : 'ascending') : 'none' }, btn));
  }

  const tbody = el('tbody');
  players.forEach((p, i) => {
    const uuid = combatUuid(p.name);
    const team = teamOf(p.name);
    const quiet = p.kills + p.deaths === 0;
    const link = teamName(playerLink(el('a', { text: shownName(p.name) }), uuid, p.name), p.name);
    delete link.dataset.card; // a click goes straight to their page, like the activity leaderboard
    const cell = (k, text, title) => el('td', { class: `num${k === key ? ' sorted' : ''}${quiet || text === '0' ? ' zero' : ''}`, text, ...(title && { title }) });
    const tr = el('tr', { class: `${uuid ? 'link' : ''}${quiet ? ' quiet' : ''}`, 'data-uuid': p.key },
      el('td', { class: 'rank', text: String(i + 1) }),
      el('td', { class: key === 'name' ? 'sorted' : '' },
        el('div', { class: 'pname' }, headImg(p.name, 22), link),
        el('div', { class: `bar${barKey === 'deaths' ? ' bar-deaths' : team ? ` team-${team}` : ''}`, style: `width:${quiet ? 0 : Math.max(1, (p[barKey] / top) * 100)}%` })),
      cell('kills', p.kills.toLocaleString()),
      cell('deaths', p.deaths.toLocaleString(), p.deaths ? `${p.pvpDeaths} by players · ${p.deaths - p.pvpDeaths} other` : null),
      cell('kd', fmtKd(p), quiet ? null : `${p.kills} ${p.kills === 1 ? 'kill' : 'kills'} ÷ ${p.deaths} ${p.deaths === 1 ? 'death' : 'deaths'}`));
    if (uuid) {
      tr.addEventListener('click', (e) => { if (e.target !== link) location.hash = `#/player/${uuid}`; });
      tr.addEventListener('pointerenter', () => prefetchPlayer(uuid));
    }
    tbody.append(tr);
  });
  root.replaceChildren(el('table', { class: 'cb-table' }, el('thead', {}, head), tbody));
  moveRows(root, oldTops);
}

/* the death log: every death message, oldest at the top and newest at the bottom, like the chat log */

const deathLog = {
  items: [], // newest first, as /api/combat/log gives them (drawn the other way up)
  more: false,
  busy: false,
  loaded: false,
  type: ['pvp', 'other'].includes(recall('deathLogType')) ? recall('deathLogType') : '',
  req: 0,
};
const DEATH_PAGE = 40;

// One death, as the game worded it: every name is a link in its own colors.
function deathRow(m, { when = clock(m.ts / 1000) } = {}) {
  const team = m.killer ? teamOf(m.killer) : null;
  const text = el('div', { class: 'dl-text' });
  if (m.rich) text.append(...richText(m));
  else text.append(noTag(m.text));
  const time = el('button', { type: 'button', class: 'dl-time', text: when,
    title: `${fmt(m.ts / 1000, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · open the chat log here` });
  time.addEventListener('click', () => {
    chat.pendingJump = { id: m.id, ts: m.ts };
    location.hash = '#/chat';
  });
  return el('div', { class: `dl-row${m.killer ? ' pvp' : ''}${team ? ` by-${team}` : ''}` },
    el('span', { class: 'dl-icon', title: m.killer ? 'Killed by a player' : naturalCause(m) }, icon(m.killer ? SWORD_ICON : SYS_ICONS.death, 14)),
    text, time);
}

function renderDeathLog(fresh = new Set()) {
  const frag = document.createDocumentFragment();
  let day = null;
  for (const m of deathLog.items.toReversed()) {
    const d = hourInfo(m.ts / 1000).date;
    if (d !== day) {
      frag.append(el('div', { class: 'chat-day dl-day', role: 'separator' }, el('span', { text: relativeDay(d, { weekday: 'short', month: 'short', day: 'numeric' }) })));
      day = d;
    }
    const row = deathRow(m);
    if (fresh.has(m.id)) row.classList.add('msg-new');
    frag.append(row);
  }
  $('#dl-list').replaceChildren(frag);
  const edge = $('#dl-edge');
  if (!deathLog.loaded) edge.replaceChildren(el('div', { class: 'chat-note loading', text: 'Loading deaths…' }));
  else if (!deathLog.items.length) {
    edge.replaceChildren(el('div', { class: 'chat-empty' },
      el('strong', { text: deathLog.type === 'pvp' ? 'No kills yet' : 'No deaths yet' }),
      el('div', { text: deathLog.type ? 'Nothing of this kind has been logged this season.' : 'Deaths show up here as the server logs them.' })));
  } else if (deathLog.busy) edge.replaceChildren(el('div', { class: 'chat-note loading', text: 'Loading older deaths…' }));
  else if (!deathLog.more) edge.replaceChildren(el('div', { class: 'chat-note', text: 'This is the first death of the season.' }));
  else edge.replaceChildren();
  for (const b of $('#dl-type').children) b.setAttribute('aria-pressed', String(b.dataset.v === deathLog.type));
}

const deathLogEnd = () => { const s = $('#dl-scroll'); s.scrollTop = s.scrollHeight; };
const deathLogPath = (extra) => `/api/combat/log?limit=${DEATH_PAGE}${deathLog.type ? `&type=${deathLog.type}` : ''}${extra}`;

// The latest page (or again after the filter changes), opened at the bottom, on the newest death.
async function loadDeathLog() {
  const req = ++deathLog.req;
  deathLog.busy = true;
  try {
    const res = await api(deathLogPath(''));
    if (req !== deathLog.req) return;
    deathLog.items = res.results;
    deathLog.more = res.more;
    deathLog.loaded = true;
  } finally {
    if (req === deathLog.req) {
      deathLog.busy = false;
      renderDeathLog();
      deathLogEnd();
    }
  }
}

// Scrolling up to the top loads older deaths above, without moving what's on screen.
async function loadOlderDeaths() {
  if (deathLog.busy || !deathLog.more || !deathLog.items.length) return;
  const req = deathLog.req;
  const last = deathLog.items.at(-1);
  deathLog.busy = true;
  renderDeathLog();
  try {
    const res = await api(deathLogPath(`&before=${last.ts}:${last.id}`));
    if (req !== deathLog.req) return;
    const have = new Set(deathLog.items.map((m) => m.id));
    deathLog.items = deathLog.items.concat(res.results.filter((m) => !have.has(m.id)));
    deathLog.more = res.more;
  } finally {
    if (req === deathLog.req) {
      const scroll = $('#dl-scroll');
      const fromEnd = scroll.scrollHeight - scroll.scrollTop;
      deathLog.busy = false;
      renderDeathLog();
      scroll.scrollTop = scroll.scrollHeight - fromEnd;
    }
  }
}

// New deaths since the latest one slide in under it; the log follows them if it was at the bottom.
async function refreshDeathLog() {
  if (!deathLog.loaded || deathLog.busy) return;
  if (!deathLog.items.length) return loadDeathLog();
  const req = deathLog.req;
  const first = deathLog.items[0];
  const res = await api(deathLogPath(`&after=${first.ts}:${first.id}`));
  if (req !== deathLog.req || !res.results.length) return;
  if (res.more) return loadDeathLog(); // more new ones than a page: start over from the latest
  const have = new Set(deathLog.items.map((m) => m.id));
  const fresh = res.results.filter((m) => !have.has(m.id));
  if (!fresh.length) return;
  const scroll = $('#dl-scroll');
  const atEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
  deathLog.items = fresh.concat(deathLog.items);
  renderDeathLog(new Set(fresh.map((m) => m.id)));
  if (atEnd) deathLogEnd(); // reading further up: stay put
}

$('#dl-scroll').addEventListener('scroll', () => {
  const s = $('#dl-scroll');
  if (s.scrollTop < 300) loadOlderDeaths().catch((e) => showError(e.message));
}, { passive: true });
$('#dl-type').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === deathLog.type) return;
  deathLog.type = b.dataset.v;
  remember('deathLogType', deathLog.type);
  deathLog.items = [];
  deathLog.loaded = false;
  renderDeathLog();
  loadDeathLog().catch((err) => showError(err.message));
});

// The log can be folded away (remembered); the rest of the page then takes the full width.
function setDeathLogOpen(open) {
  $('#combat').classList.toggle('log-closed', !open);
  $('#dl-open').hidden = open;
  remember('deathLog', open ? 'open' : 'closed');
  fitDeathLog();
  if (open) deathLogEnd();
  // the charts were measured at the other width
  for (const [root, redraw] of redraws) if (root.isConnected && root.offsetParent) redraw();
}
$('#dl-close').addEventListener('click', () => setDeathLogOpen(false));
$('#dl-open').addEventListener('click', () => {
  setDeathLogOpen(true);
  if (matchMedia('(max-width: 900px)').matches) $('#death-log').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
});

// Beside the page, the log is as tall as the window allows and stays in view while the page scrolls.
function fitDeathLog() {
  const log = $('#death-log');
  if ($('#view-combat').hidden) return;
  if (matchMedia('(max-width: 900px)').matches) {
    log.style.height = '';
    return;
  }
  const top = Math.max(12, $('#combat').getBoundingClientRect().top);
  log.style.height = `${Math.max(320, window.innerHeight - top - 12)}px`;
}
let fitQueued = false;
const queueFit = () => {
  if (fitQueued || $('#view-combat').hidden) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitDeathLog(); });
};
window.addEventListener('scroll', queueFit, { passive: true });
window.addEventListener('resize', queueFit);

function renderCombat() {
  const w = cbCtl.get();
  combat.view = combatView();
  cbCtl.sync();
  $('#cb-label').textContent = w.unit === 'all' ? (archived() ? 'The whole season' : 'All time') : windowLabel(w, combat.view, COMBAT_PRESETS);
  renderFactionBar();
  renderCombatChart();
  renderCombatLeaderboard();
}

async function showCombat({ refresh = false } = {}) {
  showView('combat');
  document.title = `Combat · ${SITE}`;
  await loadStatus();
  fitDeathLog();
  const first = !deathLog.loaded;
  if (first) renderDeathLog();
  await Promise.all([
    loadCombat().then(renderCombat),
    (first ? loadDeathLog() : refresh ? refreshDeathLog() : null),
  ]);
  fitDeathLog();
  if (!refresh) deathLogEnd(); // opening the page always lands on the newest death
}

/* a player's combat card */

async function renderPlayerCombat(name) {
  const root = $('#p-combat');
  const mine = (state.playerCombatReq = (state.playerCombatReq || 0) + 1);
  if (!combat.loaded) root.replaceChildren(el('div', { class: 'empty', text: 'Loading…' }));
  const [, log] = await Promise.all([
    loadCombat(),
    api(`/api/combat/log?player=${encodeURIComponent(name)}&limit=8`).catch(() => null),
  ]);
  if (mine !== state.playerCombatReq || state.playerData?.name !== name) return;
  const is = (n) => n && n.toLowerCase() === name.toLowerCase();
  const kills = combat.rows.filter((d) => is(d.killer));
  const deaths = combat.rows.filter((d) => is(d.victim));
  const me = { kills: kills.length, deaths: deaths.length, kd: kills.length / Math.max(1, deaths.length) };
  $('#pcb-sub').textContent = archived() ? 'the whole season' : 'this season';

  // where they stand among everyone with a kill or a death
  const everyone = combatPlayers(combat.rows).filter((p) => p.kills + p.deaths > 0);
  const rank = (key) => {
    if (!me[key] || everyone.length < 2) return '';
    return `#${1 + everyone.filter((p) => p[key] > me[key]).length} of ${everyone.length}`;
  };
  const stat = (label, value, sub, cls = '') => el('div', { class: `pcb-stat ${cls}` },
    el('div', { class: 'pcb-label', text: label }), el('div', { class: 'pcb-value', text: value }), el('div', { class: 'pcb-sub', text: sub }));
  const pvpDeaths = deaths.filter((d) => d.killer).length;
  const stats = el('div', { class: 'pcb-stats' },
    stat('Kills', me.kills.toLocaleString(), rank('kills'), 'kills'),
    stat('Deaths', me.deaths.toLocaleString(), me.deaths ? `${pvpDeaths} PvP · ${me.deaths - pvpDeaths} other` : "", "deaths"),
    stat('K/D', fmtKd(me), rank('kd')));

  if (!me.kills && !me.deaths) {
    root.replaceChildren(stats, el('div', { class: 'empty', text: 'No kills or deaths logged for them this season.' }));
    return;
  }

  // who they kill, who kills them, and what else does
  const tally = (list, keyOf) => {
    const counts = new Map();
    for (const d of list) {
      const k = keyOf(d);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]);
  };
  const person = ([who, n]) => {
    const a = teamName(playerLink(el('a', { class: 'pcb-who' }, headImg(who, 16, { width: 16, height: 16 }), el('span', { text: shownName(who) })), combatUuid(who), who), who);
    return el('li', {}, a, el('span', { class: 'pcb-n', text: `×${n}` }));
  };
  const thing = ([what, n]) => el('li', {}, el('span', { class: 'pcb-who', text: what }), el('span', { class: 'pcb-n', text: `×${n}` }));
  const list = (title, items, render, none) => el('div', { class: 'pcb-list' }, el('h3', { text: title }),
    items.length ? el('ul', {}, ...items.slice(0, 4).map(render)) : el('div', { class: 'muted pcb-none', text: none }));
  const lists = el('div', { class: 'pcb-lists' },
    list('Killed most', tally(kills, (d) => d.victim), person, 'No kills yet'),
    list('Killed by most', tally(deaths.filter((d) => d.killer), (d) => d.killer), person, 'Never killed by a player'),
    list('Other deaths', tally(deaths.filter((d) => !d.killer), naturalCause), thing, 'None'));

  const recent = el('div', { class: 'pcb-recent' }, el('h3', { text: 'Latest kills and deaths' }));
  if (log?.results.length) {
    for (const m of log.results) {
      const row = deathRow(m, { when: ago(m.ts / 1000) });
      row.classList.add(is(m.killer) ? 'is-kill' : 'is-death');
      row.querySelector('.dl-icon').title = is(m.killer) ? 'Their kill' : 'Their death';
      recent.append(row);
    }
  } else recent.append(el('div', { class: 'muted pcb-none', text: log ? 'None yet' : 'Couldn’t load the latest ones.' }));
  root.replaceChildren(stats, lists, recent);
}

/* a player's egg: what it does, and (from the server mod) its level and energy */

let eggInfoLoad = null;
const loadEggInfo = () => (eggInfoLoad ??= import('/eggdata.js').then((m) => m.EGG_INFO).catch(() => { eggInfoLoad = null; return {}; }));

async function renderPlayerEgg(name, gear) {
  const card = $('#p-egg-card');
  const live = gear?.egg && EGG_BY_ID[gear.egg.type] ? gear.egg : null;
  const id = (live && EGG_BY_ID[live.type]) || rosterOf(name)?.egg;
  const egg = eggInfo(id);
  $('#p-egg-combat').classList.toggle('no-egg', !egg);
  card.hidden = !egg;
  if (!egg) return;
  const info = (await loadEggInfo())[egg.id];
  if (state.playerData?.name !== name) return;

  const head = el('div', { class: 'egg-head' },
    el('img', { class: 'egg-icon', src: `/api/mc/textures/item/${egg.model}.png`, alt: '', width: 44, height: 44 }),
    el('div', { class: 'egg-title' },
      el('h2', { class: 'p-egg', style: egg.color ? `--egg:${egg.color}` : '' }, info?.symbol ? `${info.symbol} ` : '', egg.name),
      el('div', { class: 'card-sub', text: info?.theme || 'Egg SMP egg' })));

  const facts = el('div', { class: 'egg-facts' });
  if (live) {
    const tier = live.tier >= 2 ? 2 : 1;
    const energy = Math.max(0, Math.min(5, live.energy ?? 0));
    facts.append(
      el('div', { class: 'egg-fact' }, el('span', { class: 'egg-fact-label', text: 'Level' }), el('strong', { text: tier === 2 ? 'II' : 'I' })),
      el('div', { class: 'egg-fact', title: `${energy} of 5 energy. Dying costs 1; at 0 the egg is Cracked.` },
        el('span', { class: 'egg-fact-label', text: 'Energy' }),
        el('span', { class: 'egg-pips', role: 'img', 'aria-label': `${energy} of 5` },
          ...Array.from({ length: 5 }, (_, i) => el('i', { class: i < energy ? 'on' : '' }))),
        ...(energy === 0 ? [el('span', { class: 'egg-cracked', text: 'Cracked' })] : [])));
  }
  head.append(facts);

  const body = [head];
  if (!info) {
    body.push(el('div', { class: 'muted egg-none', text: 'This egg isn’t in the egg datapack yet, so its abilities aren’t listed.' }));
  } else {
    const locked = live && live.tier < 2;
    const row = (label, a, { second = false } = {}) => {
      if (a === undefined) return null;
      const off = second && locked && !a?.always;
      return el('div', { class: `egg-row${off ? ' locked' : ''}` },
        el('div', { class: 'egg-row-label' }, label, second && a && !a.always ? el('span', { class: 'egg-tag', text: off ? 'Locked · Level II' : 'Level II' }) : null),
        a
          ? el('div', { class: 'egg-row-text' }, ...(a.name ? [el('strong', { text: a.name }), ' '] : []), a.text,
            a.cost ? el('span', { class: 'egg-cost', text: a.cost }) : null)
          : el('div', { class: 'egg-row-text muted', text: 'None' }));
    };
    body.push(el('div', { class: 'egg-rows' },
      row('Passive', { text: info.passive }),
      row('Primary', info.primary),
      row('Secondary', info.secondary, { second: true })));
  }
  if (live && gear.ts) body.push(el('div', { class: 'egg-asof muted', text: `Level and energy as of ${ago(gear.ts)}` }));
  else if (!live) body.push(el('div', { class: 'egg-asof muted', text: 'Level and energy show once they’ve played with the server mod (1.4.0 or newer).' }));
  $('#p-egg-body').replaceChildren(...body);
}

/* ---------- the IGN / Name switch: redraw names where they're showing ---------- */

function rerenderNames() {
  hideTip();
  closeCard();
  if (!$('#view-home').hidden && state.status) {
    renderOnlineChips();
    loadLeaderboard().catch((e) => showError(e.message));
  } else if (!$('#view-player').hidden) {
    renderPlayerName();
    if (state.playerData) renderPlayerCombat(state.playerData.name).catch(() => {});
  } else if (!$('#view-combat').hidden && combat.loaded) {
    renderCombat();
    renderDeathLog();
  } else if (!$('#view-chat').hidden && chat.loaded) {
    const anchor = chatAnchor();
    renderChat();
    restoreAnchor(anchor);
    renderOnlineThen(true);
    renderPending();
    renderComposer();
    renderChatOnline();
  }
}

syncNameToggle();

/* ---------- routing & refresh ---------- */

async function route() {
  hideTip();
  showError('');
  const m = location.hash.match(/^#\/player\/([0-9a-fA-F-]{36})$/);
  try {
    if (m) await showPlayer(m[1]);
    else if (location.hash === '#/chat') await showChat();
    else if (location.hash === '#/combat') await showCombat();
    else await showHome();
    renderUnread();
  } catch (err) {
    console.error(err);
    if (err instanceof AuthError) {
      showError('Not signed in. Reload the page to log in through Cloudflare Access.');
    } else {
      showError(`Couldn’t load data (${err.message}).`);
    }
  }
}

/* ---------- light / dark ---------- */

// Follows the system until the switch is used, then remembers the choice.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const themeToggle = $('#theme-toggle');
const isDark = () => (document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light')) === 'dark';
const syncThemeToggle = () => themeToggle.setAttribute('aria-checked', String(isDark()));

themeToggle.addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  const apply = () => {
    document.documentElement.dataset.theme = next;
    syncThemeToggle();
  };
  // Cross-fade the whole page where supported.
  if (document.startViewTransition && !reducedMotion()) document.startViewTransition(apply);
  else apply();
  try { localStorage.setItem('theme', next); } catch {}
});
darkQuery.addEventListener('change', syncThemeToggle);
syncThemeToggle();
requestAnimationFrame(() => requestAnimationFrame(() => themeToggle.classList.add('ready'))); // no slide on page load

// How far paging moved the time axis, in widths of the old window (-1 = a whole width earlier).
function pageShift(prev, w, dir) {
  if (!dir || !prev) return 0;
  const a = resolveWindow(prev), b = resolveWindow(w);
  const shift = (b.from - a.from) / (a.to - a.from);
  return Math.max(-1, Math.min(1, shift)) || dir;
}

// Pinch to zoom a chart's time range around the point under the fingers: a trackpad pinch
// (Ctrl+wheel in most browsers, gesture events in Safari), Ctrl+scroll with a mouse, or two fingers.
// Each step is worked out from where the gesture started, so ranges that snap to whole hours
// or days don't drift. toWindow(from, to) gives the window for a span (or an error string).
function pinchZoom(root, { ctl, toWindow, render, min, max }) {
  let g = null;
  let idle = 0, timer = 0;
  const begin = (clientX) => {
    if (g) return;
    const r = resolveWindow(ctl.get());
    const box = root.getBoundingClientRect();
    const { l, r: right } = root.plotBox || { l: 0, r: 0 };
    const f = (clientX - box.left - l) / Math.max(1, box.width - l - right);
    g = { from: r.from, to: Math.min(r.to, nowSec()), f: Math.min(1, Math.max(0, f)), scale: 1 };
    drawn = null;
    hideTip();
  };
  // The span the fingers ask for right now (not yet snapped to whole hours or days).
  const wanted = () => {
    const span = Math.min(max, Math.max(min, (g.to - g.from) * g.scale));
    const at = g.from + g.f * (g.to - g.from);
    let from = at - g.f * span, to = from + span;
    const now = nowSec();
    if (to > now) { from -= to - now; to = now; }
    return { from, to };
  };
  // Every frame the chart already on screen is stretched to the wanted span, which costs almost
  // nothing, so the zoom follows the fingers. The chart is redrawn for real (new data, sharp
  // labels) one drawing at a time behind that, and the stretch then starts again from the new one.
  let drawn = null; // the span of the chart on screen
  let busy = false, again = false, frame = 0, last = null;
  const stretch = () => {
    frame = 0;
    if (!g || !drawn) return;
    const { from, to } = wanted();
    const { l, r: right } = root.plotBox || { l: 0, r: 0 };
    const pw = Math.max(1, root.clientWidth - l - right);
    const k = (drawn.to - drawn.from) / (to - from);
    const dx = l * (1 - k) + ((drawn.from - from) / (to - from)) * pw;
    const same = Math.abs(k - 1) < 1e-4 && Math.abs(dx) < 0.25;
    for (const child of root.children) {
      child.style.transformOrigin = '0 0';
      child.style.transform = same ? '' : `translateX(${dx}px) scaleX(${k})`;
    }
  };
  const unstretch = () => {
    for (const child of root.children) child.style.transform = '';
    root.style.overflow = '';
  };
  const shownSpan = () => {
    const r = resolveWindow(ctl.get()); // what the chart's x axis covers
    return { from: r.from, to: r.to };
  };
  const apply = () => {
    timer = 0;
    if (!g) return;
    if (busy) { again = true; return; }
    const { from, to } = wanted();
    const w = toWindow(Math.round(from), Math.round(to));
    if (typeof w === 'string' || windowKey(w) === windowKey(ctl.get())) return;
    ctl.set(w);
    busy = true;
    const mine = g;
    Promise.resolve(render()).catch(() => {}).then(() => {
      busy = false;
      if (g !== mine) { // the gesture ended meanwhile: draw where it ended, unstretched
        unstretch();
        if (last && typeof last !== 'string' && windowKey(last) !== windowKey(ctl.get())) {
          ctl.set(last);
          render();
        }
        last = null;
        return;
      }
      drawn = shownSpan();
      stretch();
      if (again) { again = false; apply(); }
    });
  };
  const zoomTo = (scale) => {
    const span = g.to - g.from;
    g.scale = Math.min(max / span, Math.max(min / span, scale));
    if (!drawn) {
      drawn = shownSpan();
      root.style.overflow = 'hidden';
    }
    if (!frame && !reducedMotion()) frame = requestAnimationFrame(stretch);
    if (!timer) timer = setTimeout(apply, 90);
  };
  const end = () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    frame = 0;
    again = false;
    if (g && busy) {
      const { from, to } = wanted();
      last = toWindow(Math.round(from), Math.round(to));
    } else if (g) apply();
    g = null;
    drawn = null;
    if (!busy) unstretch(); // otherwise the drawing in flight clears it when it lands
  };

  root.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    begin(e.clientX);
    zoomTo(g.scale * Math.exp(Math.max(-50, Math.min(50, e.deltaY)) * 0.01));
    clearTimeout(idle);
    idle = setTimeout(end, 300);
  }, { passive: false });

  root.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    begin(e.clientX);
  });
  root.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (g) zoomTo(1 / e.scale);
  });
  root.addEventListener('gestureend', (e) => {
    e.preventDefault();
    end();
  });

  let startDist = 0;
  const dist = ([a, b]) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  root.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    g = null;
    begin((e.touches[0].clientX + e.touches[1].clientX) / 2);
    startDist = dist(e.touches);
  }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !g || !startDist) return;
    e.preventDefault();
    zoomTo(startDist / Math.max(1, dist(e.touches)));
  }, { passive: false });
  root.addEventListener('touchend', (e) => {
    if (e.touches.length < 2 && startDist) {
      startDist = 0;
      end();
    }
  });
}

const tlCtl = rangeControl($('#tl-ctl'), {
  presets: TL_PRESETS, picker: 'datetime', fromPicker: pickSeconds(TL_PRESETS),
  onChange: (w, dir, prev) => loadTimeline(pageShift(prev, w, dir)).catch((e) => showError(e.message)),
});
const dailyCtl = rangeControl($('#daily-ctl'), {
  presets: DAILY_PRESETS, picker: 'date', fromPicker: pickDays(DAILY_PRESETS),
  onChange: (w, dir) => renderServerDaily(false, dir).catch((e) => showError(e.message)),
});
const pCtl = rangeControl($('#pa-ctl'), {
  presets: PLAYER_PRESETS, picker: 'datetime', fromPicker: pickPlayerRange,
  onChange: (w, dir) => renderPlayerActivity(false, dir),
});
tlCtl.set(presetWindow(TL_PRESETS[1]));
dailyCtl.set(presetWindow(DAILY_PRESETS[0]));
pCtl.set(playerDefaultWindow());
const lbCtl = rangeControl($('#lb-ctl'), {
  presets: LB_PRESETS, picker: 'datetime', fromPicker: pickSeconds(LB_PRESETS),
  onChange: () => loadLeaderboard().catch((e) => showError(e.message)),
});
lbCtl.set(presetWindow(LB_PRESETS[0]));
// Combat: one range for the whole page; up to two days is drawn by the hour, longer by the day.
const cbCtl = rangeControl($('#cb-ctl'), {
  presets: COMBAT_PRESETS, picker: 'datetime',
  fromPicker: (from, to) => {
    const w = pickPlayerRange(from, to);
    return typeof w === 'string' ? w : { ...w, preset: matchPreset(COMBAT_PRESETS, w.unit, w.count) };
  },
  onChange: () => renderCombat(),
});
cbCtl.set(presetWindow(COMBAT_PRESETS.at(-1)));
$('#cb-chart-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === combat.chartMode) return;
  combat.chartMode = b.dataset.v;
  remember('combatChart', combat.chartMode);
  renderCombatChart();
});
if (recall('deathLog') === 'closed') {
  $('#combat').classList.add('log-closed');
  $('#dl-open').hidden = false;
}

pinchZoom($('#timeline'), {
  ctl: tlCtl, toWindow: pickSeconds(TL_PRESETS), min: 30 * 60, max: 90 * 86400,
  render: () => loadTimeline().catch((e) => showError(e.message)),
});
pinchZoom($('#heatmap'), {
  ctl: dailyCtl, min: 86400, max: 90 * 86400,
  toWindow: (from, to) => pickDays(DAILY_PRESETS)(hourInfo(from).date, hourInfo(to - 1).date),
  render: () => renderServerDaily().catch((e) => showError(e.message)),
});
pinchZoom($('#p-heatmap'), {
  ctl: pCtl, toWindow: pickPlayerRange, min: 2 * 3600, max: 365 * 86400,
  render: () => renderPlayerActivity(),
});

window.addEventListener('hashchange', route);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!$('#view-home').hidden) loadTimeline().catch(() => {});
});

// Live updates: re-render everything shortly after each once-a-minute server check,
// while the tab is visible. Fetches are incremental, so this stays cheap.
let refreshing = false;
// Effects only play for automatic updates, not first loads or range changes.
function live() {
  return refreshing && !reducedMotion();
}
async function refresh() {
  if (document.hidden || refreshing || archived()) return; // a finished season doesn't change
  refreshing = true;
  try {
    const m = location.hash.match(/^#\/player\/([0-9a-fA-F-]{36})$/);
    if (m) await showPlayer(m[1], { refresh: true });
    else if (location.hash === '#/chat') await showChat({ refresh: true });
    else if (location.hash === '#/combat') await showCombat({ refresh: true });
    else await showHome();
    renderUnread();
    showError('');
  } catch (err) {
    if (err instanceof AuthError) showError('Your login expired. Reload the page to sign in again.');
    // other errors: keep showing the last good data; the next tick retries
  } finally {
    refreshing = false;
  }
}

function scheduleRefresh() {
  const ms = Date.now() % 60_000;
  const wait = (20_000 - ms + 60_000) % 60_000 || 60_000; // ~20s past each minute
  setTimeout(async () => { await refresh(); scheduleRefresh(); }, wait);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refresh();
  if (!$('#view-chat').hidden) pollChat().catch(() => {});
  else checkUnread().catch(() => {});
});
scheduleRefresh();

route().finally(() => checkUnread().catch(() => {}));
