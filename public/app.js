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

/* ---------- hour × weekday grid ---------- */

// grid[dow][hour] = number
function renderWeekGrid(root, grid, describe) {
  root.replaceChildren();
  const max = Math.max(0, ...grid.flat());
  const level = (v) => (v <= 0 || max <= 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)));
  const g = el('div', { class: 'weekgrid', role: 'img', 'aria-label': 'Activity by weekday and hour' });

  g.append(el('span'));
  for (let h = 0; h < 24; h += 3) g.append(el('span', { class: 'hlabel', text: hourName(h, true) }));
  for (let d = 0; d < 7; d++) {
    g.append(el('span', { class: 'dlabel', text: DOWS[d] }));
    for (let h = 0; h < 24; h++) {
      const c = el('span', { class: `wcell lv${level(grid[d][h])}` });
      c.dataset.d = d;
      c.dataset.h = h;
      g.append(c);
    }
  }
  root.append(g, scaleLegend());
  attachCellTips(root, '.wcell', (c) => {
    const d = Number(c.dataset.d), h = Number(c.dataset.h);
    return describe(grid[d][h], `${DOWS[d]} ${hourName(h)}–${hourName((h + 1) % 24)}`);
  });
}

/* ---------- line chart with crosshair ---------- */

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

// Charts sized to their container re-render on resize.
const redraws = new Map();

// opts: { from, to, step, series: [{ name, cls, color, area, pts: [{t, v, down}] }], fmtValue, fmtTime }
function renderLineChart(root, opts) {
  redraws.set(root, () => renderLineChart(root, opts));
  root.replaceChildren();
  const { from, to, step, series } = opts;
  const pts0 = series[0].pts;
  if (!pts0.length) {
    root.append(el('div', { class: 'empty-chart', text: 'No data in this range yet' }));
    return;
  }

  const W = Math.max(280, root.clientWidth);
  const H = root.clientHeight || 240;
  const m = { l: 30, r: 10, t: 10, b: 24 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;

  let vmax = 0;
  for (const s of series) for (const p of s.pts) if (p.v > vmax) vmax = p.v;
  const ystep = niceStep(Math.max(1, vmax / 4));
  const ymax = Math.max(ystep * 4, Math.ceil(vmax / ystep) * ystep);

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
  for (let h = Math.ceil(from / 3600) * 3600; h <= to; h += 3600) {
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

  // lines, broken wherever there is missing data
  for (const s of series) {
    let line = '', area = '', segStart = null, prev = null;
    const closeArea = () => {
      if (s.area && segStart !== null) area += `L${x(prev.t)},${y(0)}L${x(segStart.t)},${y(0)}Z`;
    };
    for (const p of s.pts) {
      const gap = !prev || p.t - prev.t > step * 2.5;
      if (gap) {
        closeArea();
        line += `M${x(p.t)},${y(p.v)}`;
        if (s.area) area += `M${x(p.t)},${y(p.v)}`;
        segStart = p;
      } else {
        line += `L${x(p.t)},${y(p.v)}`;
        if (s.area) area += `L${x(p.t)},${y(p.v)}`;
      }
      prev = p;
    }
    closeArea();
    if (s.area) svg.append(sv('path', { d: area, class: `area-${s.cls}` }));
    svg.append(sv('path', { d: line, class: `line-${s.cls}` }));
  }

  // crosshair + tooltip
  const cross = sv('line', { y1: m.t, y2: m.t + ph, class: 'crosshair', visibility: 'hidden' });
  const markers = series.map((s) => sv('circle', { r: 4, fill: s.color, class: 'marker', visibility: 'hidden' }));
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
      markers[k].setAttribute('cy', y(s.pts[i].v));
      markers[k].setAttribute('visibility', 'visible');
    });
    const rows = series.map((s) => ({
      value: s.pts[i].down ? 'Server offline' : opts.fmtValue(s.pts[i].v),
      label: s.pts[i].down ? null : s.name,
      color: series.length > 1 ? s.color : null,
    }));
    rows.push({ label: opts.fmtTime(p.t) });
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

  root.append(svg);
}

/* ---------- daily bar chart ---------- */

// days: Map<'YYYY-MM-DD', number>; one bar per day for the last n days, ending today.
function renderDailyBars(root, days, describe, { n = 14, fmtTick = (v) => String(v) } = {}) {
  redraws.set(root, () => renderDailyBars(root, days, describe, { n, fmtTick }));
  root.replaceChildren();

  const end = todayStr();
  const dates = [];
  for (let i = n - 1; i >= 0; i--) dates.push(addDays(end, -i));
  const vals = dates.map((d) => days.get(d) || 0);

  const W = Math.max(280, root.clientWidth);
  const H = root.clientHeight || 200;
  const m = { l: 34, r: 4, t: 10, b: 24 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;

  const vmax = Math.max(...vals);
  const ystep = vmax > 0 ? niceStep(vmax / 4) : 1;
  const ymax = vmax > 0 ? Math.ceil(vmax / ystep) * ystep : 4;
  const y = (v) => m.t + ph - (v / ymax) * ph;

  const svg = sv('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Activity per day, last ${n} days` });

  for (let v = 0; v <= ymax + 1e-9; v += ystep) {
    if (v > 0) svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'gridline' }));
    const t = sv('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' });
    t.textContent = fmtTick(Math.round(v * 100) / 100);
    svg.append(t);
  }

  const slot = pw / n;
  const bw = Math.max(4, Math.min(40, slot - 2 * Math.max(2, slot * 0.15)));
  const labelEvery = slot >= 44 ? 1 : slot >= 22 ? 2 : 3;
  const bars = [];

  dates.forEach((d, i) => {
    const cx = m.l + slot * (i + 0.5);
    const v = vals[i];
    const top = y(v), base = y(0);
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

    // Only every few days is labelled on narrow screens, counted back from today.
    if ((n - 1 - i) % labelEvery === 0) {
      const day = Number(d.slice(8));
      const t = sv('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'axis-text' });
      t.textContent = i === n - 1 ? 'Today' : day === 1 || slot >= 44 || i < labelEvery ? fmtDay(d, { month: 'short', day: 'numeric' }) : String(day);
      svg.append(t);
    }

    const hit = sv('rect', { x: cx - slot / 2, y: m.t, width: slot, height: ph + m.b, fill: 'transparent', class: 'dbar-hit' });
    hit.dataset.i = i;
    svg.append(hit);
  });
  svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), class: 'baseline' }));

  let hovered = null;
  const move = (e) => {
    const t = e.target.closest('.dbar-hit');
    if (!t) return;
    const i = Number(t.dataset.i);
    if (hovered !== bars[i]) {
      hovered?.classList.remove('hover');
      hovered = bars[i] || null;
      hovered?.classList.add('hover');
    }
    showTip(e.clientX, e.clientY, describe(dates[i], vals[i]));
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', () => { hovered?.classList.remove('hover'); hovered = null; hideTip(); });

  root.append(svg);
}

let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const [root, redraw] of redraws) {
      if (!root.isConnected) redraws.delete(root);
      else if (root.offsetParent) redraw();
    }
  }, 120);
}).observe(document.body);

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ---------- segmented controls ---------- */

function segmented(root, initial, onChange) {
  let value = initial;
  for (const b of root.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.v === value));
    b.addEventListener('click', () => {
      if (b.dataset.v === value) return;
      value = b.dataset.v;
      for (const o of root.querySelectorAll('button')) o.setAttribute('aria-pressed', String(o === b));
      onChange(value);
    });
  }
  return () => value;
}

/* ---------- app state ---------- */

const state = {
  status: null,
  hourly: [], // [hour_ts, samples, up_samples, online_sum, peak]
  snaps: { since: 0, rows: [] }, // cached minute rows [ts, up, online] from `since` to now
  tlRange: '24h',
  lbRange: '30d',
};

const TL_DAYS = { '6h': 0.25, '12h': 0.5, '24h': 1, '7d': 7, '30d': 30, '90d': 90 };
const LB_DAYS = { '24h': 1, '7d': 7, '30d': 30, all: null };
const HOURLY_DAYS = 92; // longest range anything on the page needs

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

function renderOnlineChips() {
  const list = $('#online-list');
  list.replaceChildren(
    ...state.status.online.map((p) =>
      el('a', { class: 'chip', href: `#/player/${p.uuid}` },
        headImg(p.name, 24),
        el('span', { text: p.name }),
        el('span', { class: 'since', text: `since ${fmt(p.start_ts, { hour: 'numeric', minute: '2-digit' })}` })
      )
    )
  );

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
  $('#t-online').textContent = fresh ? (last.up ? last.online : 'Offline') : '–';
  $('#t-online-sub').textContent = fresh && last.up && last.max ? `of ${last.max} slots` : fresh ? '' : 'no recent data';

  const today = todayStr();
  const weekAgo = nowSec() - 7 * 86400;
  let peak = 0, weekMinutes = 0;
  for (const [ts, , , sum, pk] of state.hourly) {
    if (hourInfo(ts).date === today) peak = Math.max(peak, pk);
    if (ts >= weekAgo) weekMinutes += sum;
  }
  $('#t-peak').textContent = peak;
  $('#t-week').textContent = fmtHours(weekMinutes / 60);
  $('#t-players').textContent = st.players_total.toLocaleString();
}

function renderServerHeatmap() {
  const days = new Map();
  const peaks = new Map();
  for (const [ts, , , sum, pk] of state.hourly) {
    const d = hourInfo(ts).date;
    days.set(d, (days.get(d) || 0) + sum / 60);
    peaks.set(d, Math.max(peaks.get(d) || 0, pk));
  }
  // Bars for the last 14 days while history is short; renderHeatmap(days, …) is the year view.
  renderDailyBars($('#heatmap'), days, (d, v) => [
    { value: v ? `${fmtHours(v)} player-hours` : 'No activity' },
    { label: `${fmtDay(d)}${peaks.get(d) ? ` · peak ${peaks.get(d)} online` : ''}` },
  ], { fmtTick: (v) => `${v}h` });
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
  ]);
}

async function loadTimeline() {
  const days = TL_DAYS[state.tlRange];
  const to = nowSec();
  const from = to - days * 86400;
  const c1 = cssVar('--series-1');
  const c2 = cssVar('--series-2');
  const legend = $('#tl-legend');
  let opts;

  if (days <= 7) {
    const rows = await loadSnapshots(from);
    opts = {
      from, to, step: POLL,
      series: [{ name: 'online', cls: '1', color: c1, area: true, pts: rows.map(([t, up, v]) => ({ t, v, down: !up })) }],
      fmtValue: (v) => `${v} ${v === 1 ? 'player' : 'players'}`,
      fmtTime: (t) => fmt(t, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    };
    legend.replaceChildren();
  } else {
    const rows = state.hourly.filter((r) => r[0] >= from);
    opts = {
      from, to, step: 3600,
      series: [
        { name: 'average', cls: '1', color: c1, area: true, pts: rows.map(([t, n, , s]) => ({ t, v: n ? s / n : 0 })) },
        { name: 'peak', cls: '2', color: c2, pts: rows.map(([t, , , , pk]) => ({ t, v: pk })) },
      ],
      fmtValue: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
      fmtTime: (t) => `${fmt(t, { weekday: 'short', month: 'short', day: 'numeric' })}, ${hourName(hourInfo(t).hour)}`,
    };
    legend.replaceChildren(
      el('span', {}, el('span', { class: 'key', style: `background:${c1}` }), 'Average online'),
      el('span', {}, el('span', { class: 'key', style: `background:${c2}` }), 'Peak online')
    );
  }
  renderLineChart($('#timeline'), opts);
}

async function loadLeaderboard() {
  const days = LB_DAYS[state.lbRange];
  const from = days ? nowSec() - days * 86400 : 1;
  const r = await api(`/api/leaderboard?from=${from}`);
  const root = $('#leaderboard');
  if (!r.players.length) {
    root.replaceChildren(el('div', { class: 'empty', text: 'Nobody seen in this range yet.' }));
    return;
  }
  const top = r.players[0].secs || 1;
  const onlineNow = new Set(state.status.online.map((p) => p.uuid));
  const tbody = el('tbody');
  r.players.slice(0, 25).forEach((p, i) => {
    const link = el('a', { href: `#/player/${p.uuid}`, text: p.name });
    const tr = el('tr', { class: 'link' },
      el('td', { class: 'rank', text: String(i + 1) }),
      el('td', {},
        el('div', { class: 'pname' }, headImg(p.name, 22), link),
        el('div', { class: 'bar', style: `width:${Math.max(1, (p.secs / top) * 100)}%` })
      ),
      el('td', { class: 'num', text: dur(p.secs) }),
      el('td', { class: 'num muted hide-sm', text: onlineNow.has(p.uuid) ? 'online' : ago(p.last_seen) })
    );
    tr.addEventListener('click', (e) => { if (e.target !== link) location.hash = `#/player/${p.uuid}`; });
    tbody.append(tr);
  });
  root.replaceChildren(el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}), el('th', { text: 'Player' }), el('th', { class: 'num', text: 'Played' }), el('th', { class: 'num hide-sm', text: 'Last seen' })
    )),
    tbody
  ));
}

async function loadStatus() {
  state.status = await api('/api/status');
  setTz(state.status.tz);
  POLL = state.status.poll_seconds;
  renderLive();
}

// After the first load, only rows from the latest (still-filling) hour onward are re-fetched.
async function loadHourly() {
  const since = nowSec() - HOURLY_DAYS * 86400;
  if (!state.hourly.length) {
    state.hourly = (await api(`/api/hourly?from=${since}`)).rows;
    return;
  }
  const from = state.hourly.at(-1)[0];
  const fresh = (await api(`/api/hourly?from=${from}`)).rows;
  state.hourly = state.hourly.filter((r) => r[0] >= since && r[0] < from).concat(fresh);
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

async function showHome() {
  $('#view-player').hidden = true;
  $('#view-home').hidden = false;
  document.title = 'Server Stats';
  await loadStatus();
  await loadHourly();
  renderTiles();
  renderOnlineChips();
  renderServerHeatmap();
  renderServerWeekGrid();
  await Promise.all([loadTimeline(), loadLeaderboard()]);
}

/* ---------- player page ---------- */

async function showPlayer(uuid, { refresh = false } = {}) {
  $('#view-home').hidden = true;
  $('#view-player').hidden = false;
  if (!refresh) window.scrollTo(0, 0);
  await loadStatus();
  const r = await api(`/api/player/${encodeURIComponent(uuid)}`);
  const { player } = r;
  document.title = `${player.name} · Server Stats`;

  $('#p-name').textContent = player.name;
  const ph = $('#p-head');
  if (ph.dataset.name !== player.name) {
    delete ph.dataset.fellBack;
    ph.dataset.name = player.name;
    ph.dataset.size = 64;
    ph.src = head(player.name, 64);
  }

  const sessions = r.sessions.map(([s, e]) => [s, e + r.poll_seconds]);
  const lastTs = state.status.last?.ts;
  const isOnline = lastTs != null && r.sessions.length && r.sessions.at(-1)[1] === lastTs;

  let total = 0, longest = [0, null];
  const perDay = new Map();
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const [s, e] of sessions) {
    const len = e - s;
    total += len;
    if (len > longest[0]) longest = [len, s];
    eachHourChunk(s, e, (h, secs) => {
      const info = hourInfo(h);
      perDay.set(info.date, (perDay.get(info.date) || 0) + secs);
      grid[info.dow][info.hour] += secs;
    });
  }

  const status = $('#p-status');
  status.replaceChildren();
  if (isOnline) status.append(el('span', { class: 'badge', text: 'Online now' }), ` since ${fmt(r.sessions.at(-1)[0], { hour: 'numeric', minute: '2-digit' })}`);
  else if (r.sessions.length) status.append(`Last seen ${ago(r.sessions.at(-1)[1])}`);

  const weekAgo = nowSec() - 7 * 86400;
  let week = 0;
  for (const [s, e] of sessions) if (e > weekAgo) week += e - Math.max(s, weekAgo);

  $('#p-total').textContent = dur(total);
  $('#p-total-sub').textContent = `${dur(week)} in the last 7 days`;
  $('#p-sessions').textContent = sessions.length.toLocaleString();
  $('#p-avg').textContent = sessions.length ? `avg ${dur(total / sessions.length)}` : '';
  $('#p-longest').textContent = dur(longest[0]);
  $('#p-longest-sub').textContent = longest[1] ? fmt(longest[1], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  $('#p-first').textContent = fmt(player.first_seen, { month: 'short', day: 'numeric', year: 'numeric' });
  $('#p-last').textContent = fmt(player.first_seen, { hour: 'numeric', minute: '2-digit' });

  const perDayHours = new Map([...perDay].map(([d, secs]) => [d, secs / 3600]));
  renderDailyBars($('#p-heatmap'), perDayHours, (d, v) => [
    { value: v ? dur(v * 3600) : 'Didn’t play' },
    { label: fmtDay(d) },
  ], { fmtTick: (v) => `${v}h` });
  renderWeekGrid($('#p-weekgrid'), grid, (v, label) => [
    { value: v ? dur(v) : 'Never', label: v ? 'total' : null },
    { label },
  ]);

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

/* ---------- routing & refresh ---------- */

async function route() {
  hideTip();
  showError('');
  const m = location.hash.match(/^#\/player\/([0-9a-fA-F-]{36})$/);
  try {
    if (m) await showPlayer(m[1]);
    else await showHome();
  } catch (err) {
    console.error(err);
    if (err instanceof AuthError) {
      showError('Not signed in. Reload the page to log in through Cloudflare Access.');
    } else {
      showError(`Couldn’t load data (${err.message}).`);
    }
  }
}

segmented($('#tl-range'), state.tlRange, (v) => { state.tlRange = v; loadTimeline().catch((e) => showError(e.message)); });
segmented($('#lb-range'), state.lbRange, (v) => { state.lbRange = v; loadLeaderboard().catch((e) => showError(e.message)); });

window.addEventListener('hashchange', route);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!$('#view-home').hidden) loadTimeline().catch(() => {});
});

// Live updates: re-render everything shortly after each once-a-minute server check,
// while the tab is visible. Fetches are incremental, so this stays cheap.
let refreshing = false;
async function refresh() {
  if (document.hidden || refreshing) return;
  refreshing = true;
  try {
    const m = location.hash.match(/^#\/player\/([0-9a-fA-F-]{36})$/);
    if (m) await showPlayer(m[1], { refresh: true });
    else await showHome();
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

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
scheduleRefresh();

route();
