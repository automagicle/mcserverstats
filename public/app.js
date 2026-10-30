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

const nowSec = () => Math.floor(Date.now() / 1000);
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

async function api(path) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (res.status === 401) throw new AuthError('unauthorized');
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

/* ---------- tooltip ---------- */

const tip = $('#tooltip');

// rows: [{ value, label, color }]
function showTip(x, y, rows) {
  tip.replaceChildren(
    ...rows.map((r) => {
      if (r.players) return playerList(r.players);
      const row = el('div', { class: 'row' });
      if (r.color) row.append(el('span', { class: 'key', style: `background:${r.color}` }));
      if (r.value != null) row.append(el('span', { class: 'tv', text: r.value }));
      if (r.label) row.append(el('span', { class: 'tl', text: r.label }));
      return row;
    })
  );
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
  for (const name of names.slice(0, TIP_PLAYERS)) {
    if (!tipHeads.has(name)) tipHeads.set(name, headImg(name, 14, { width: 14, height: 14, loading: 'eager' }));
    list.append(el('div', { class: 'tip-player' }, tipHeads.get(name), el('span', { text: name })));
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
  // Earlier (negative shift) moves content right, like scrolling back along a timeline.
  old.animate([
    { transform: 'translateX(0)', opacity: 1 },
    { transform: `translateX(${-shift * W}px)`, opacity: fade ? 0 : 1 },
  ], opts);
  cur.animate([
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

/* ---------- hour × weekday grid ---------- */

const weekPrev = new Map();

// grid[dow][hour] = number
function renderWeekGrid(root, grid, describe, { animate = false } = {}) {
  root.replaceChildren();
  const max = Math.max(0, ...grid.flat());
  const level = (v) => (v <= 0 || max <= 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)));
  const g = el('div', { class: 'weekgrid', role: 'img', 'aria-label': 'Activity by weekday and hour' });

  g.append(el('span'));
  for (let h = 0; h < 24; h += 3) g.append(el('span', { class: 'hlabel', text: hourName(h, true) }));
  const cells = [];
  for (let d = 0; d < 7; d++) {
    g.append(el('span', { class: 'dlabel', text: DOWS[d] }));
    for (let h = 0; h < 24; h++) {
      const c = el('span', { class: `wcell lv${level(grid[d][h])}` });
      c.dataset.d = d;
      c.dataset.h = h;
      g.append(c);
      cells.push(c);
    }
  }
  root.append(g, scaleLegend());
  attachCellTips(root, '.wcell', (c) => {
    const d = Number(c.dataset.d), h = Number(c.dataset.h);
    return describe(grid[d][h], `${DOWS[d]} ${hourName(h)}–${hourName((h + 1) % 24)}`);
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

// A quiet grey rectangle with sparse diagonal lines, covering x0..x1 of a plot.
function noDataBlock(svg, parent, id, x0, x1, top, height, { label = true } = {}) {
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
    t.textContent = 'No data yet';
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
  let vmax = 0;
  for (const s of opts.series) for (const p of s.pts) if (p.v > vmax) vmax = p.v;
  const ystep = niceStep(Math.max(1, Math.max(vmax, 4) / (opts.ticks || 4)));
  const ymax = Math.max(4, Math.ceil(vmax / ystep) * ystep);
  return { from: opts.from, to: opts.to, ymax, ystep, vals: opts.series.map((s) => s.pts.map((p) => p.v)) };
}

// opts: { key, from, to, step, series: [{ name, cls, color, area, pts: [{t, v, down}] }], fmtValue, fmtTime,
//         ticks?, whoAt?(t), onPick?(t) when the plot is clicked, onDraw?(geometry) after every frame }
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
  const pw = W - m.l - m.r, ph = H - m.t - m.b;

  const x = (t) => m.l + ((t - from) / (to - from)) * pw;
  const y = (v) => m.t + ph - (v / ymax) * ph;

  const svg = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Players online over time' });

  for (let v = 0; v <= ymax + 1e-9; v += ystep) {
    if (v > 0) svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'gridline' }));
    const t = sv('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' });
    t.textContent = Number.isInteger(v) ? v : v.toFixed(1);
    svg.append(t);
  }
  svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), class: 'baseline' }));

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
    svg.append(t);
  });

  // lines, broken wherever there is missing data; clipped to the plot while the domain slides
  const clipId = `${root.id}-clip`;
  const clip = sv('clipPath', { id: clipId });
  clip.append(sv('rect', { x: m.l, y: 0, width: pw, height: m.t + ph + 1 }));
  svg.append(clip);
  const plot = sv('g', { 'clip-path': `url(#${clipId})` });
  svg.append(plot);

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
  svg.append(cross, ...markers);
  const hit = sv('rect', { x: m.l, y: 0, width: pw, height: H, fill: 'transparent' });
  svg.append(hit);

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
  const { buckets, fmtTick, strip } = spec;
  const n = buckets.length;
  const W = Math.max(280, root.clientWidth);
  const H = root.clientHeight || 200;
  const m = { l: 34, r: 4, t: 10, b: strip ? 48 : 24 };
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
  if (spec.dataStart && spec.dataStart > from) noDataBlock(svg, svg, hatchId, m.l, xAt(spec.dataStart), m.t, ph);

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
      // rounded top, square base
      const r = Math.min(4, h, bw / 2);
      const x0 = cx - bw / 2, x1 = cx + bw / 2;
      const bar = sv('path', {
        d: `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${base}Z`,
        class: 'dbar',
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
        t.textContent = b.date === todayStr() ? 'Today'
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
  let stripCross = null;
  if (strip) {
    const sy = m.t + ph + 8, sh = 14;
    svg.append(sv('rect', { x: m.l, y: sy, width: pw, height: sh, rx: 3, class: 'strip-bg' }));
    if (spec.dataStart && spec.dataStart > from) noDataBlock(svg, svg, hatchId, m.l, xAt(spec.dataStart), sy, sh, { label: false });
    for (const [a, e] of strip.intervals) {
      const x0 = xAt(Math.max(a, from));
      svg.append(sv('rect', { x: x0, y: sy, width: Math.max(1.5, xAt(Math.min(e, to)) - x0), height: sh, class: 'strip-on' }));
    }
    if (slot >= 4) {
      for (let i = 0; i <= n; i++) {
        const tx = m.l + slot * i;
        svg.append(sv('line', { x1: tx, x2: tx, y1: sy + sh + 1, y2: sy + sh + 5, class: 'strip-tick' }));
      }
    }
    stripCross = sv('line', { y1: sy - 3, y2: sy + sh + 3, class: 'crosshair strip-cross', visibility: 'hidden' });
    const stripHit = sv('rect', { x: m.l, y: sy - 5, width: pw, height: sh + 10, fill: 'transparent', class: 'strip-hit' });
    svg.append(stripCross, stripHit);
  }

  let hovered = null;
  const clearHover = () => {
    hovered?.classList.remove('hover');
    hovered = null;
    stripCross?.setAttribute('visibility', 'hidden');
  };
  const move = (e) => {
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

  root.append(svg);
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
  if (r.live && p) return p.long;
  const md = { month: 'short', day: 'numeric' };
  if (w.unit === 'day') {
    const first = r.buckets[0].date, last = r.buckets.at(-1).date;
    return first === last ? fmtDay(first, md) : `${fmtDay(first, md)} – ${fmtDay(last, md)}`;
  }
  const full = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const start = fmt(r.from, full);
  if (r.live) return `${start} – now`;
  const sameDay = hourInfo(r.from).date === hourInfo(r.to - 1).date;
  return `${start} – ${fmt(r.to, sameDay ? { hour: 'numeric', minute: '2-digit' } : full)}`;
}

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

function fittingPlayerWindow(firstSeen) {
  if (nowSec() - firstSeen <= 86400) return presetWindow(PLAYER_PRESETS[0]);
  const n = daysCovered(firstSeen);
  return presetWindow(PLAYER_PRESETS.find((p) => p.unit === 'day' && n <= p.count) || PLAYER_PRESETS.at(-1));
}

// Smallest leaderboard range that covers all the data.
// Smallest preset that covers all the data; wider ones get the red "Data starts on" note.
function fittingLeaderboardRange() {
  const span = dataSpan();
  return LB_PRESETS.find((p) => p.unit === 'all' || (p.unit === 'sec' && span <= p.count));
}

const defaultLeaderboardRange = () => presetByKey(LB_PRESETS, '1d');

function showError(msg) {
  const e = $('#error');
  e.textContent = msg;
  e.hidden = !msg;
}

/* ---------- live status ---------- */

function renderLive() {
  const st = state.status;
  const live = $('#live');
  const text = $('#live-text');
  const last = st.last;
  if (!last) {
    live.dataset.state = 'none';
    text.textContent = 'Waiting for first check';
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

  $('#foot').textContent = `Times shown in ${TZ.replace('_', ' ')} · checked every ${POLL / 60} min via mcstatus.io`
    + (last ? ` · last check ${fmt(last.ts, { hour: 'numeric', minute: '2-digit' })}` : '');
}

function makeChip(p) {
  knownNames.set(p.uuid, p.name);
  const chip = el('a', { class: 'chip', href: `#/player/${p.uuid}` },
    headImg(p.name, 24),
    colorName(el('span', { class: 'chip-name', text: p.name }), p.uuid),
    el('span', { class: 'since', text: `since ${fmt(p.start_ts, { hour: 'numeric', minute: '2-digit' })}` })
  );
  chip.dataset.uuid = p.uuid;
  chip.addEventListener('pointerenter', () => prefetchPlayer(p.uuid));
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
      colorName(existing.querySelector('.chip-name'), p.uuid).textContent = p.name;
      continue;
    }
    const chip = makeChip(p);
    list.append(chip);
    if (animate) chip.classList.add('chip-enter');
  }
}

function renderOnlineChips() {
  syncChips($('#online-list'), state.status.online);
  const warn = $('#sample-warning');
  const last = state.status.last;
  if (last && last.up && last.online > last.listed) {
    warn.replaceChildren(
      `The server reports ${last.online} players but only lists ${last.listed} by name, so some playtime isn't being counted. `,
      'Turning on ', el('code', { text: 'enable-query=true' }), ' in server.properties gives the full list.'
    );
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}

/* ---------- home ---------- */

function renderTiles() {
  const st = state.status;
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

async function renderServerDaily(animate = false, slide = 0) {
  const w = dailyCtl.get();
  const r = resolveWindow(w);
  dailyCtl.sync();
  $('#daily-label').textContent = `player-hours per day · ${windowLabel(w, r, DAILY_PRESETS)}`;
  const rows = await getHourlyRange(r.from, r.to);
  const index = new Map(r.buckets.map((b, i) => [b.date, i]));
  const vals = r.buckets.map(() => 0);
  const peaks = r.buckets.map(() => 0);
  for (const [ts, , , sum, pk] of rows) {
    const i = index.get(hourInfo(ts).date);
    if (i === undefined) continue;
    vals[i] += sum / 60;
    peaks[i] = Math.max(peaks[i], pk);
  }
  renderBars($('#heatmap'), {
    buckets: r.buckets, vals, windowKey: windowKey(w), labels: 'day',
    fmtTick: (v) => `${v}h`, dataStart: state.dataStart,
    describe: (i) => [
      { value: vals[i] ? `${fmtHours(vals[i])} player-hours` : 'No activity' },
      { label: `${fmtDay(r.buckets[i].date)}${peaks[i] ? ` · peak ${peaks[i]} online` : ''}` },
    ],
  }, { animate, slide });
}

function renderServerWeekGrid() {
  const sum = Array.from({ length: 7 }, () => Array(24).fill(0));
  const cnt = Array.from({ length: 7 }, () => Array(24).fill(0));
  const since = nowSec() - 90 * 86400;
  for (const [ts, samples, , s] of state.hourly) {
    if (ts < since) continue;
    const { dow, hour } = hourInfo(ts);
    sum[dow][hour] += s;
    cnt[dow][hour] += samples;
  }
  const avg = sum.map((row, d) => row.map((s, h) => (cnt[d][h] ? s / cnt[d][h] : 0)));
  renderWeekGrid($('#weekgrid'), avg, (v, label) => [
    { value: `${v.toFixed(v < 10 ? 1 : 0)} players`, label: 'avg' },
    { label: `${label} · last 90 days` },
  ], { animate: live() });
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
  opts.dataStart = state.dataStart;
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
  const onlineNow = new Set(state.status.online.map((p) => p.uuid));
  const prev = state.lbPrev?.range === windowKey(w) ? state.lbPrev.secs : null;
  state.lbPrev = { range: windowKey(w), secs: new Map(r.players.map((p) => [p.uuid, p.secs])) };
  const changed = [];
  const tbody = el('tbody');
  r.players.slice(0, 25).forEach((p, i) => {
    const link = el('a', { href: `#/player/${p.uuid}`, text: p.name });
    const tr = el('tr', { class: 'link', 'data-uuid': p.uuid },
      el('td', { class: 'rank', text: String(i + 1) }),
      el('td', {},
        el('div', { class: 'pname' }, headImg(p.name, 22), link),
        el('div', { class: 'bar', style: `width:${Math.max(1, (p.secs / top) * 100)}%` })
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
  state.status = await api('/api/status');
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
  const since = nowSec() - HOURLY_DAYS * 86400;
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

// Shows one of the views ('home', 'player', 'chat') and marks its tab.
function showView(name) {
  for (const v of ['home', 'player', 'chat']) $(`#view-${v}`).hidden = v !== name;
  document.body.classList.toggle('chat-mode', name === 'chat');
  const tab = name === 'chat' ? 'chat' : 'activity';
  for (const t of ['activity', 'chat']) {
    if (t === tab) $(`#tab-${t}`).setAttribute('aria-current', 'page');
    else $(`#tab-${t}`).removeAttribute('aria-current');
  }
}

async function showHome() {
  showView('home');
  document.title = 'Server Stats';
  await loadStatus();
  await loadHourly();
  renderTiles();
  renderOnlineChips();
  renderServerWeekGrid();
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
  $('#p-name').textContent = name || 'Loading…';
  const ph = $('#p-head');
  if (name) setHead(ph, name);
  else { ph.removeAttribute('src'); delete ph.dataset.name; }
  $('#p-status').textContent = 'Loading…';
  for (const id of ['p-total', 'p-sessions', 'p-longest', 'p-first']) {
    const n = $(`#${id}`);
    delete n.dataset.text;
    delete n.dataset.value;
    n.textContent = '–';
  }
  for (const id of ['p-total-sub', 'p-avg', 'p-longest-sub', 'p-last', 'pa-label']) $(`#${id}`).textContent = '';
  const chart = $('#p-heatmap');
  stopTween(chart);
  chartPrev.delete(chart);
  redraws.delete(chart);
  chart.replaceChildren(el('div', { class: 'empty-chart', text: 'Loading…' }));
  const empty = Array.from({ length: 7 }, () => Array(24).fill(0));
  renderWeekGrid($('#p-weekgrid'), empty, () => [{ value: 'Loading…' }]);
  weekPrev.delete($('#p-weekgrid'));
  $('#p-recent').replaceChildren(el('div', { class: 'empty', text: 'Loading…' }));
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
  const [r] = await Promise.all([
    fetchPlayer(uuid, refresh),
    refresh || !state.status ? loadStatus() : null,
  ]);
  if (req !== playerReq) return; // another player was opened meanwhile
  const { player } = r;
  knownNames.set(player.uuid, player.name);
  document.title = `${player.name} · Server Stats`;

  $('#p-name').textContent = player.name;
  setHead($('#p-head'), player.name);

  const sessions = r.sessions.map(([s, e]) => [s, e + r.poll_seconds]);
  const lastTs = state.status.last?.ts;
  const isOnline = lastTs != null && r.sessions.length && r.sessions.at(-1)[1] === lastTs;

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

  const weekAgo = nowSec() - 7 * 86400;
  let week = 0;
  for (const [s, e] of sessions) if (e > weekAgo) week += e - Math.max(s, weekAgo);

  const animate = live() && state.playerShown === player.uuid;
  if (state.playerShown !== player.uuid) pCtl.set(fittingPlayerWindow(player.first_seen));
  state.playerShown = player.uuid;
  state.playerData = { sessions, liveSession: isOnline ? sessions.at(-1) : null };
  setCounter($('#p-total'), dur(total), total, animate);
  $('#p-total-sub').textContent = `${dur(week)} in the last 7 days`;
  setCounter($('#p-sessions'), sessions.length.toLocaleString(), sessions.length, animate);
  $('#p-avg').textContent = sessions.length ? `avg ${dur(total / sessions.length)}` : '';
  setCounter($('#p-longest'), dur(longest[0]), longest[0], animate);
  $('#p-longest-sub').textContent = longest[1] ? fmt(longest[1], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  $('#p-first').textContent = fmt(player.first_seen, { month: 'short', day: 'numeric', year: 'numeric' });
  $('#p-last').textContent = fmt(player.first_seen, { hour: 'numeric', minute: '2-digit' });

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
    dataStart: state.dataStart,
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
};
const chatScroll = $('#chat-scroll');

const clock = (t) => fmt(t, { hour: 'numeric', minute: '2-digit' });

function relativeDay(date, opts) {
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

// Names as chat shows them, in their team colors. Minecraft's colors are made for its dark chat box,
// so each one gets a version that reads on the light page and one for the dark page (the CSS picks).
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
    let light = rgb, dark = rgb;
    // light page: darken until it stands out from near-white; dark page: lighten away from near-black
    for (let k = 1; k > 0 && contrast(luminance(light), 0.96) < 3.2; k -= 0.05) light = rgb.map((c) => c * k);
    for (let k = 0; k <= 1 && contrast(luminance(dark), 0.01) < 4; k += 0.05) dark = rgb.map((c) => c + (255 - c) * k);
    v = `--cl:${toHex(light)};--cd:${toHex(dark)}`;
    mcCache.set(hex, v);
  }
  return v;
}

function colorName(node, uuid) {
  const c = nameColors.get(uuid);
  if (c) { node.classList.add('mc'); node.setAttribute('style', mcStyle(c)); }
  return node;
}

const displayText = (m) => (m.display ? m.display.map((p) => p.t).join('') : m.name || 'Server');

function chatName(m) {
  const parts = m.display
    ? m.display.map((p) => (p.c ? el('span', { class: 'mc', style: mcStyle(p.c), text: p.t }) : p.t))
    : [m.name || 'Server'];
  if (!m.uuid) return el('span', { class: 'msg-name' }, ...parts);
  knownNames.set(m.uuid, m.name);
  const own = m.display?.find((p) => p.c && p.t.includes(m.name));
  if (own) nameColors.set(m.uuid, own.c);
  const a = el('a', { class: 'msg-name', href: `#/player/${m.uuid}` }, ...parts);
  a.addEventListener('pointerenter', () => prefetchPlayer(m.uuid));
  return a;
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
  else if (m.name && m.text.startsWith(displayText(m))) body.append(chatName(m), m.text.slice(displayText(m).length));
  else if (m.name && m.text.startsWith(m.name)) body.append(chatName({ ...m, display: null }), m.text.slice(m.name.length));
  else body.append(m.text);
  return el('div', { class: `msg-sys sys-${m.kind}` },
    el('span', { class: 'msg-lead' }, lead), body, el('time', { class: 'msg-time', text: clock(m.ts / 1000) }));
}

// A run of messages from one player: head and name once, then their lines.
function msgGroup(m) {
  const head = chatAvatar(m, 24);
  const lead = m.uuid
    ? el('a', { class: 'msg-lead', href: `#/player/${m.uuid}`, tabindex: '-1', 'aria-hidden': 'true' }, head)
    : el('span', { class: 'msg-lead' }, head);
  return el('div', { class: 'msg-group' }, lead, el('div', { class: 'msg-body' },
    el('div', { class: 'msg-meta' },
      chatName(m),
      m.kind === 'say' ? el('span', { class: 'msg-tag', text: '/say' }) : null,
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
      if (!group || prev.kind !== m.kind || prev.name !== m.name || m.ts - prev.ts > CHAT_GROUP_MS) {
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
async function jumpChatTo(t) {
  if (chat.loading) return;
  chat.loading = 'jump';
  let line = null;
  try {
    const res = await api(`/api/chat?at=${Math.round(t * 1000)}&limit=${CHAT_PAGE}`);
    Object.assign(chat, {
      messages: res.messages, moreBefore: res.more_before, moreAfter: res.more_after,
      maxId: Math.max(chat.maxId, res.max_id),
    });
    renderChat();
    line = chat.lines.findLast((l) => l.ts <= t * 1000) || null;
    setScroll(line ? line.el.offsetTop + line.el.offsetHeight - chatScroll.clientHeight + 10 : 0);
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
  if ($('#view-chat').hidden || document.hidden || !chat.loaded || chat.moreAfter || fromBottom() > 60) return;
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
  if (!chat.loaded || chat.loading || document.hidden || $('#view-chat').hidden) return;
  const res = await api(`/api/chat?since_id=${chat.maxId}&limit=200&unread_since=${chat.seenId ?? chat.maxId}`);
  if (res.more_after && !chat.moreAfter) return loadChatLatest().then(syncChatTime); // fell far behind
  chat.maxId = Math.max(chat.maxId, res.max_id);
  chat.unread = res.unread ?? 0;
  renderUnread();
  if (!res.messages.length || chat.moreAfter || chat.loading) return;
  const known = new Set(chat.messages.map((m) => m.id));
  const fresh = res.messages.filter((m) => !known.has(m.id));
  if (!fresh.length) return;
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
    key: windowKey(w), from, to, step: POLL, ticks: 2, dataStart: state.dataStart, whoAt,
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
  const t = chat.win?.end == null && chat.t > (g?.to ?? 0) && chat.t <= nowSec() + 60 ? g.to : chat.t;
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
    const a = el('a', { class: 'cg-person', href: `#/player/${p.uuid}` }, onlineHeads.get(p.name), colorName(el('span', { text: p.name }), p.uuid));
    a.addEventListener('pointerenter', () => prefetchPlayer(p.uuid));
    return a;
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
  empty.hidden = fresh && st.online.length > 0;
  empty.textContent = !fresh ? 'No recent data' : !last.up ? 'Server offline' : 'Nobody online right now';
  const n = fresh && last.up ? last.online : 0;
  $('#chat-online-pill-text').textContent = !fresh ? 'No data' : !last.up ? 'Offline' : `${n} online`;
  $('#chat-online-pill').classList.toggle('none', !n);
}

async function showChat({ refresh = false } = {}) {
  showView('chat');
  document.title = 'Chat log · Server Stats';
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
  await loadChatLatest();
  markSeen();
  const line = lastVisibleLine();
  chat.t = line ? line.ts / 1000 : nowSec();
  chat.win = chatWindowFor(chat.t, liveDayWindow());
  await loadChatGraph();
  syncChatTime();
  updateChatJump();
  fillChat();
}

let chatTicks = 0;
setInterval(() => {
  if (document.hidden) return;
  if (!$('#view-chat').hidden) pollChat().catch(() => {});
  else if (chatTicks++ % 3 === 0) checkUnread().catch(() => {});
}, CHAT_POLL_MS);

/* ---------- routing & refresh ---------- */

async function route() {
  hideTip();
  showError('');
  const m = location.hash.match(/^#\/player\/([0-9a-fA-F-]{36})$/);
  try {
    if (m) await showPlayer(m[1]);
    else if (location.hash === '#/chat') await showChat();
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
pCtl.set(presetWindow(PLAYER_PRESETS[0]));
const lbCtl = rangeControl($('#lb-ctl'), {
  presets: LB_PRESETS, picker: 'datetime', fromPicker: pickSeconds(LB_PRESETS),
  onChange: () => loadLeaderboard().catch((e) => showError(e.message)),
});
lbCtl.set(presetWindow(LB_PRESETS[0]));

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
  if (document.hidden || refreshing) return;
  refreshing = true;
  try {
    const m = location.hash.match(/^#\/player\/([0-9a-fA-F-]{36})$/);
    if (m) await showPlayer(m[1], { refresh: true });
    else if (location.hash === '#/chat') await showChat({ refresh: true });
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

route();
checkUnread().catch(() => {});
