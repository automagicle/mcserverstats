# mcserverstats

Tracks who's on a Minecraft server and when, and shows it on a private dashboard.
It runs on Cloudflare's free plan, so nothing needs to stay on at home.

- **Collector**: a Cron-triggered Worker asks [mcstatus.io](https://mcstatus.io) about the server every minute and records the player count plus each named player's session in D1 (SQLite).
- **Dashboard**: static files in `public/`, served by the same Worker. It shows players online over time, a GitHub-style daily heatmap, a leaderboard, busiest hours, and a page for each player.
- **Chat log** (optional): a small Fabric server mod in `mod/` posts public chat to the Worker, which stores it in D1.
  See [mod/README.md](mod/README.md) for setup.
- **Seasons**: the main page shows the current season (season 2); `/s1/` is the season 1 archive. Seasons split the
  recorded data by time, so nothing is copied or deleted (see [Seasons](#seasons)).
- **Privacy**: the server address is a Worker secret. Every `/api/*` request must carry a valid Cloudflare Access login token. Until Access is configured, the API refuses everyone.
  The one exception is `POST /api/ingest/chat`, which takes the chat mod's `CHAT_INGEST_TOKEN` instead (and still needs the
  Access service token to get past Access). Service tokens can't read the dashboard.

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

## Seasons

Everything recorded before `SEASON2_START` (in `wrangler.jsonc`) is season 1, shown at `/s1/`; the main page shows only
what comes after. While it's empty, season 2 has no data (the main page says so and links to the archive) and season 1
keeps recording. When season 2 begins:

1. Set `SEASON2_START` to the moment it starts, with its offset, e.g. `"2026-11-08T16:00:00-08:00"` (on the hour is tidiest:
   hourly totals are per hour).
2. If it's on a new server, update the address: `npx wrangler secret put MC_SERVER`.
3. `npm run deploy`.

From then on `/s1/` is frozen at the end of season 1: its charts show its final days, the tiles show its length, peak and
total, the leaderboard opens on All, and it stops refreshing.

**Teams**: each season's teams and players' real names live in the database (the `roster` table), so they stay out of
this public repository. Keep them in `roster-s2.json` (git ignores `roster-*.json`; see `roster.example.json` for the
format) and run `npm run roster:remote` after each change; it replaces the season's roster, takes effect at once and
needs no deploy. `npm run roster:local` does the same for local development.

**Sample data**: `/?dummydata` fills the main page with made-up activity for the season's real players (from the roster), to
see the page full before there's real data. It's generated in the browser (`public/dummy.js`) and never stored; the chat
log is left empty.

## Local development

```bash
printf 'DEV_NO_AUTH=1\nMC_SERVER=demo.mcstatus.io\nCHAT_INGEST_TOKEN=local-dev-token-0123456789abcdef0123456789\n' > .dev.vars
npm run db:migrate:local
npm run seed:local        # optional: 200 days of fake data, plus two weeks of fake chat
npm run dev               # http://localhost:8787, trigger a check at /__scheduled
```

## Dashboard

- **Header**: S1 / S2 switch between seasons. When the season has a roster, **IGN / Name** switches every player's name
  (leaderboard, online chips, charts' who-was-online, chat, player pages and cards) between their in-game name and their
  real name, with the other one on hover; the choice is remembered in the browser. On the leaderboard, names are in
  their team's color (red or blue), and player pages show the team.

- **Home**: live status and online players, stat tiles, players online over time, daily activity bars,
  leaderboard (bars in each player's team color), and busiest hours as a week calendar (days across, hours down)
  that can show everyone, one team in its color, or both teams blended by their share. The players online chart adds a 1-hour moving-average trend line
  for ranges over 6 hours, switches to hourly average/peak for longer ranges, and its
  tooltip lists who was online. Its y-axis always reaches at least the most players ever online at once,
  so every range is drawn on the same scale.
- **Player pages**: the name as chat shows it, totals, chat messages sent (total or today), an activity chart (hourly bars
  on a fixed 0–60 min scale for 24h, daily bars for longer ranges) with an Online strip and a Chat strip underneath, when they
  usually play, and recent sessions. The Chat strip has an orange line per message, a red diamond per death and a yellow star
  per advancement; clicking one previews it, with a button to open the chat log there. It opens on the last 24 hours. Player data is fetched when you
  hover a leaderboard row or online chip, so pages usually open instantly; otherwise placeholders show until it loads.
- **Player cards**: clicking a player's name or head (in the chat log, the online chips, who was online) opens a small card:
  their name as chat shows it, online or last seen, messages and time played today, time played this week, a little
  graph of when they're usually on (the last two weeks, by hour), and a button to their page. The leaderboard still
  opens player pages directly, and ⌘/Ctrl-click opens the page in a new tab.
- **Time ranges**: each chart and the leaderboard has presets, a date picker (custom ranges show a temporary "Custom" option),
  and ‹ › to step back or forward by the current range (charts scroll sideways as they page). Players online
  defaults to the last 24 hours, and stepping back with ‹ pages through whole days (midnight to midnight).
  The leaderboard defaults to 1d (today since midnight; ‹ › steps a day at a time), and the other
  charts to the smallest preset that covers all the data so far. Anything before tracking began is hatched out.
- **Pinch to zoom**: on Players online, Daily activity and a player's Activity chart, a trackpad pinch (or Ctrl+scroll,
  or two fingers on a phone) zooms the time range in or out around the point under the fingers.
- **Leaderboard**: keeps the height of the most rows seen for the current range size, so paging doesn't
  shift the page, and rows glide to their new ranks.
- **Live updates**: about 20 seconds after each minute's check, the page refreshes in place (only while the
  tab is visible), with animations that are skipped when the system's reduce-motion setting is on.
- **Chat log**: the server's chat, newest at the bottom, loading older messages as you scroll up and new ones every
  10 seconds. Above it, a players online graph follows the chat. Its cursor marks the time of the bottom message on screen,
  and the graph pages back a day when that time leaves its left edge. Beside it is who was online at that moment.
  Clicking the graph jumps the chat to that time. Names show as they do in game chat, with team prefixes and colors
  (exact on the light page, with a Minecraft-style shadow on pale ones; lightened where needed on the dark page). Deaths and advancements show the whole message in its
  game colors: a killer's name, a named weapon, the advancement's title. Deaths are highlighted in red, as are leaves.
  **Search** (the button at the top, or ⌘F / Ctrl+F on the chat page) finds messages and names as you type; its filters
  narrow it to message text or names only, one player, or one kind of message (chat, deaths, advancements, joins and
  leaves). Picking a result opens the chat there. When the server shuts down (the mod logs "Server stopped"), the status
  at the top says **Paused** until it's back. Chat, deaths and advancements you haven't seen yet are counted in red
  on the Chat log tab and in the page title, and on the jump button while you're scrolled up. The count is remembered in
  the browser, and a "New" line marks where they start when you open the page. Both the graph and the bar of who's online now
  (along the bottom) fold away, and the page remembers that.
- **Theme**: the switch at the top picks light or dark and is remembered in the browser; until it's used,
  the page follows the system setting.
- Times are shown in `TZ_NAME` from `wrangler.jsonc` (Pacific by default).

## Notes

- If the server reports more players than it names, the dashboard shows a warning. Set
  `enable-query=true` in `server.properties` so mcstatus.io can read the full player list.
- Time played is counted in 1-minute steps. A player missing for up to 3.5 minutes stays in the same session.
- Occasionally a check wrongly reports nobody online for a minute. When the same players are seen again within
  3.5 minutes, that empty (or offline) reading is replaced by the number of players whose sessions span it.
  Smaller dips are left alone, since someone may really have relogged.
- Usage on Cloudflare's free tier: about 1,440 Cron runs per day, plus a few D1 rows written per check (1 per player).
  The chat mod adds at most one request every 3 seconds while people are talking (one row per message), and an open
  Chat log page checks for new messages every 10 seconds while it's visible.