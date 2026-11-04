// Seasons split the recorded data by time; nothing is copied or deleted.
// Season 1 is everything before SEASON2_START. Season n runs from SEASONn_START up to SEASON(n+1)_START.
// Until SEASONn_START is set (in wrangler.jsonc), season n hasn't started and has no data.

export const CURRENT_SEASON = 2; // the season the main page shows; earlier ones live under /s1/, /s2/, …

const FAR = 1e12; // "no end yet", in unix seconds (also used as the start of a season that hasn't begun)

// Unix seconds, or an ISO date like "2026-11-08T16:00:00-08:00". Empty or invalid means not set.
function parseStart(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s) / 1000;
  return Number.isFinite(t) ? Math.floor(t) : null;
}

const startOf = (env, n) => (n <= 1 ? 0 : parseStart(env[`SEASON${n}_START`]));

// The time bounds for a request's ?season=N, as [lo, hi) in unix seconds.
// Without ?season, nothing is filtered. Returns null for a malformed season.
export function seasonFor(env, url) {
  const raw = url.searchParams.get('season');
  if (raw == null) return { n: null, lo: 0, hi: FAR, info: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > CURRENT_SEASON) return null;
  const now = Date.now() / 1000;
  const start = startOf(env, n);
  const next = startOf(env, n + 1);
  const started = start != null && start <= now;
  const ended = started && next != null && next <= now;
  const info = {
    n,
    started,
    ended,
    start: start || null, // season 1 has no set start; its data starts at the first check
    end: next, // may be in the future: the season ends then
  };
  if (!started) return { n, lo: FAR, hi: FAR, info };
  return { n, lo: start, hi: next != null && next > start ? next : FAR, info };
}

// [from, to] narrowed to the season.
export const clampRange = (s, from, to) => [Math.max(from, s.lo), Math.min(to, s.hi)];

export const OPEN_ENDED = (s) => s.hi >= FAR;
