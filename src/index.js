import { poll } from './poll.js';
import { handleApi } from './api.js';
import { CURRENT_SEASON } from './seasons.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);

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
    ctx.waitUntil(poll(env, Math.floor(controller.scheduledTime / 1000)));
  },
};
