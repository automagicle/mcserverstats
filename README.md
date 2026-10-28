# mcserverstats

Tracks who's on a Minecraft server and when, and shows it on a private dashboard.
It runs on Cloudflare's free plan, so nothing needs to stay on at home.

- **Collector**: a Cron-triggered Worker asks [mcstatus.io](https://mcstatus.io) about the server every minute and records the player count plus each named player's session in D1 (SQLite).
- **Dashboard**: static files in `public/`, served by the same Worker. It shows players online over time, a GitHub-style daily heatmap, a leaderboard, busiest hours, and a page for each player.
- **Privacy**: the server address is a Worker secret. Every `/api/*` request must carry a valid Cloudflare Access login token. Until Access is configured, the API refuses everyone.

## Deploy

```bash
npm install
npx wrangler login
npx wrangler d1 create mcstats             # paste the database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put MC_SERVER          # e.g. play.example.com or 1.2.3.4:25565
npm run deploy
```

Then, in the Cloudflare dashboard, open **Workers & Pages → mcstats → Settings → Domains & Routes**.
Enable **Cloudflare Access** on the `workers.dev` route and allow only your email. Copy the
**team domain** (`<team>.cloudflareaccess.com`) and the **Audience (AUD) tag** into `ACCESS_TEAM_DOMAIN`
and `ACCESS_AUD` in `wrangler.jsonc`, then run `npm run deploy` again.

## Local development

```bash
printf 'DEV_NO_AUTH=1\nMC_SERVER=demo.mcstatus.io\n' > .dev.vars
npm run db:migrate:local
npm run seed:local        # optional: 200 days of fake data
npm run dev               # http://localhost:8787, trigger a check at /__scheduled
```

## Dashboard

- **Home**: live status and online players, stat tiles, players online over time, daily activity bars,
  leaderboard, and busiest hours by weekday. The players online chart adds a 1-hour moving-average trend line
  for ranges over 6 hours, switches to hourly average/peak for longer ranges, and its
  tooltip lists who was online.
- **Player pages**: totals, an activity chart (hourly bars for 24h, daily bars for longer ranges) with a
  when-online strip underneath, when they usually play, and recent sessions.
- **Time ranges**: each chart and the leaderboard has presets, a date picker (custom ranges show a temporary "Custom" option),
  and ‹ › to step back or forward by the current range (charts scroll sideways as they page). Defaults are the smallest preset that covers all
  the data collected so far, and anything before tracking began is hatched out.
- **Live updates**: about 20 seconds after each minute's check, the page refreshes in place (only while the
  tab is visible), with animations that are skipped when the system's reduce-motion setting is on.
- Times are shown in `TZ_NAME` from `wrangler.jsonc` (Pacific by default).

## Notes

- If the server reports more players than it names, the dashboard shows a warning. Set
  `enable-query=true` in `server.properties` so mcstatus.io can read the full player list.
- Time played is counted in 1-minute steps. A player missing for up to 3.5 minutes stays in the same session.
- Usage on Cloudflare's free tier: about 1,440 Cron runs per day, plus a few D1 rows written per check (1 per player).