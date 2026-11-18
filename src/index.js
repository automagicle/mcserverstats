import { poll } from './poll.js';
import { fillGaps } from './gapfill.js';
import { handleApi } from './api.js';
import { CURRENT_SEASON } from './seasons.js';

export { ServerLink } from './link.js';

// Cloudflare refuses every D1 query for the rest of the UTC day once the free plan's daily rows
// read (or written) limit is used up.
const isDbLimit = (err) => /free tier daily row (read|write) limit|exceeded D1's free tier/i.test(String(err?.message ?? err));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        if (!isDbLimit(err)) throw err;
        // The page shows a banner for this until the limit resets (midnight UTC).
        const resets = Math.ceil(Date.now() / 86_400_000) * 86_400;
        return new Response(JSON.stringify({ error: 'db_limit', resets_at: resets }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(resets - Math.floor(Date.now() / 1000)) },
        });
      }
    }

    // Past seasons: /s1/ is the same page as the main one; the page reads its season from the path.
    const past = url.pathname.match(/^\/s(\d{1,2})(\/.*)?$/);
    if (past) {
      const n = Number(past[1]);
      if (n < 1 || n >= CURRENT_SEASON) return new Response('Not found', { status: 404 });
      if (!past[2]) return Response.redirect(new URL(`/s${n}/${url.search}${url.hash}`, url), 301);
      if (past[2] !== '/') return new Response('Not found', { status: 404 });
      return env.ASSETS.fetch(new Request(new URL('/', url), request));
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    const now = Math.floor(controller.scheduledTime / 1000);
    ctx.waitUntil((async () => {
      await poll(env, now);
      // once an hour, fill in minutes an outage kept from being recorded (src/gapfill.js)
      if (Math.floor(now / 60) % 60 === 7) await fillGaps(env, now);
    })());
  },
};
