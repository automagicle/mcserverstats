import { poll } from './poll.js';
import { handleApi } from './api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(poll(env, Math.floor(controller.scheduledTime / 1000)));
  },
};
