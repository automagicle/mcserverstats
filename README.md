# mcserverstats

Tracks who's on a Minecraft server and when, and shows it on a private dashboard.
It runs on Cloudflare's free plan, so nothing needs to stay on at home.

- **Collector**: a Cron-triggered Worker asks [mcstatus.io](https://mcstatus.io) about the server every minute and records the player count plus each named player's session in D1 (SQLite).
- **Dashboard**: static files in `public/`, served by the same Worker. It shows players online over time, a GitHub-style daily heatmap, a leaderboard, busiest hours, and a page for each player.
- **Chat log, combat, gear and advancements** (optional): a small Fabric server mod in `mod/` posts public chat, every death
  (who died, who or what did it, and how), what each player wears and carries, and their advancements, to the Worker,
  which stores them in D1. It also shows chat typed on the dashboard in game (web chat).
  See [mod/README.md](mod/README.md) for setup.
- **Seasons**: the main page shows the current season (season 2); `/s1/` is the season 1 archive. Seasons split the
  recorded data by time, so nothing is copied or deleted (see [Seasons](#seasons)).
- **Privacy**: the server address is a Worker secret. Every `/api/*` request must carry a valid Cloudflare Access login token. Until Access is configured, the API refuses everyone.
  The exceptions are the mod's `/api/ingest/*` endpoints, which take its `CHAT_INGEST_TOKEN` instead (and still need the
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

**Recording before the official start**: to test before a season opens, set `SEASON2_START` to when recording should
begin and `SEASON2_OPENS` to the official start. Everything from `SEASON2_START` on is season 2 and counts; charts hatch
the time before `SEASON2_OPENS` ("Season starts Sun 7:30 PM", then "Before the season") with what was recorded drawn
over it, and a line at the top says the season hasn't started. To drop the test data once the season is on, move
`SEASON2_START` to the official time (it then counts as the end of season 1) and remove `SEASON2_OPENS`.

From then on `/s1/` is frozen at the end of season 1: its charts show its final days, the tiles show its length, peak and
total, the leaderboard opens on All, and it stops refreshing.

**Chat resets**: `CHAT_RESETS` (in `wrangler.jsonc`) is a list of times, separated by commas, like
`"2026-11-15T18:00:00-08:00"`. At each one the chat log starts over: messages from before the latest reset that has
passed are no longer shown, searched or counted (the unread badge and each player's message count included). Nothing is
deleted: they stay in the database, and removing the time (and deploying) brings them back. A time in the future takes
effect by itself when it arrives. Deaths on the Combat page are not affected.

**Teams**: each season's teams, players' real names, their eggs and their login emails live in the database (the
`roster` and `roster_email` tables), so they stay out of this public repository. Keep them in `roster-s2.json` (git
ignores `roster-*.json`; see `roster.example.json` for the format:
`"IGN": { "name": "Real name", "egg": "gravity", "email": "them@example.org" }`, egg ids as in the Egg SMP datapack;
`email` can be a list) and run `npm run roster:remote` after each change; it replaces the season's roster, takes effect
at once and needs no deploy. `npm run roster:local` does the same for local development.
A player's emails are who may send chat from the dashboard as them; they're never shown on the page.
`"admins": ["someone@example.org"]` beside the teams lets people who aren't players send chat too; their messages show
with a yellow **Admin** tag instead of a name (in game: `[Web] [Admin] message`).

**Sample data**: `/?dummydata` fills the main page with made-up activity for the season's real players (from the roster), to
see the page full before there's real data. It's generated in the browser (`public/dummy.js`) and never stored; the chat
log is left empty.

## Admin page

`#/admin` (linked in the footer for admins only) edits the season's teams and eggs, hidden players and merged
accounts, and lists the deaths left out of Combat and the deleted chat messages so either can be undone. Admins can
also right-click a chat line or a death: **Delete message** takes it out of the chat log (and Combat), and
**Don't count in combat** leaves a death out of Combat while the chat log keeps it. Shift + right-click opens the
browser's own menu. Deleted lines are kept in `deleted_chat` and come back with Restore; a copy the mod resends
stays out.

Admins are the sign-in emails in the `ADMIN_EMAIL` secret (comma-separated), so they stay out of this repository:

```bash
npx wrangler secret put ADMIN_EMAIL
```

For local development, add `ADMIN_EMAIL=` with your `DEV_EMAIL` to `.dev.vars`. Roster changes made on the page are
replaced the next time `npm run roster:remote` runs, so copy lasting ones into the roster file (it also holds the real
names and chat emails, which the page doesn't show).

## Live online list

The charts and totals come from the once-a-minute check (mcstatus.io plus the server mod's list, below). What's online
*right now* is live instead: the online badges, the **Online now** count and the pill at the top (on the Activity page,
and the Chat log's online bar) change within a second or two of someone joining or leaving (`src/presence.js`).

- The server mod sends each join, leave and server start/stop line with the chat log, and its full tab list whenever it
  changes (and every 20 seconds regardless). The Worker hands both to a Durable Object, `Presence`, which pushes the
  result to every open page over a WebSocket (`GET /api/live`, signed in like the rest of `/api/`).
- A join line puts the badge up at once, with the time the player actually joined; a leave line takes it down. The tab
  list is the final word: whatever a line got wrong (one lost or sent late) the next list puts right.
- Hidden players are left out and other accounts are shown as the player they belong to, as everywhere else; the admin
  page's changes reach open pages at once.
- With no list for 75 seconds (the server asleep, the mod not running, or the connection down) a page goes back to the
  minute check's numbers, and keeps trying to reconnect (up to a minute apart). A shutdown shows as *Paused* at once.
- Cost: no database reads per page. The object sleeps between updates and keeps what it knows in its own storage; it reads
  the hidden players and aliases at most every 5 minutes and a newcomer's session start when there's no join line for
  them. A tab in the background lets go of its connection after a minute.

## Missed checks (outages)

If a minute's check can't be recorded (the database refusing queries, or the status API and the server mod both
unreachable), that minute is lost: nothing else keeps it. The server mod keeps the chat it couldn't send and sends it
later, though, so once an hour (at :07) the Worker fills such gaps in from the chat log's joins, leaves and server
starts/stops (`src/gapfill.js`): a check for each missing minute with whoever was on, sessions carried across the gap,
and the hourly figures recomputed. It waits until the chat log has caught up past the gap and the gap ended at least
15 minutes before, and looks back 2 days. The admin page's **Fill gaps now** runs it at once.

## Database reads

Cloudflare's free D1 plan allows 5 million rows read a day; past that every query is refused until midnight UTC (the
page then says so). Each open dashboard tab refreshes once a minute, so those queries must read only what changed:
sessions by the `end_ts` index, combat updates by row number, the latest server start/stop by `chat_kind`, and the
season's player total and peak kept for 5 minutes in the `cache` table. A refresh reads under ~100 rows, however long
the season gets.

## Hiding a player

A name in the `hidden_players` table is left out of the Activity and Combat pages as if it had never been on the
server: its playtime, its place in player counts, peaks and lists, its player page, its deaths. It covers everything
already recorded, and nothing more is recorded for it while it's listed. The chat log still shows its messages.
Nothing is deleted, so taking the name off brings back what was recorded before it was added.

The admin page does this, or:

```bash
npx wrangler d1 execute mcstats --remote --command "INSERT OR IGNORE INTO hidden_players (name, note) VALUES ('Name', 'why')"
npx wrangler d1 execute mcstats --remote --command "DELETE FROM hidden_players WHERE name = 'Name'"
```

## Merging a player's accounts

The server runs in offline mode, so a player who changes their name gets a new account (a new UUID). A row in
`player_aliases` merges the other account into the main one everywhere: playtime, player counts and lists, the player
page (both accounts' sessions, chat, gear and advancements), Combat and team colors. Like hidden players it applies to
everything already recorded and nothing is rewritten; delete the row and the accounts show apart again. Chat log
messages still show the name they were sent under (with the main account's team color). Put the main name in the
roster file. The admin page does this, or:

```bash
npx wrangler d1 execute mcstats --remote --command "INSERT OR REPLACE INTO player_aliases (alias, name) VALUES ('OldName', 'MainName')"
npx wrangler d1 execute mcstats --remote --command "DELETE FROM player_aliases WHERE alias = 'OldName'"
```

## Sign-in (Cloudflare Access)

The Access application's **Allow** policy decides who can open the dashboard. Its **Include** rules are OR'd, so one
policy can let in a whole email domain *and* individual addresses: add an **Emails ending in** rule (e.g.
`@school.org`) and an **Emails** rule (or an Access **List** of emails) for people outside it. Turn on the
**One-time PIN** login method (Zero Trust → Settings → Authentication) so any email address can sign in with a code;
a Google login works too for Google accounts. Keep the separate **Service Auth** policy for the mod's service token.

Being let in only allows reading. **Sending chat** also needs the email to be on the season's roster (see Teams above);
anyone else sees the message box disabled with the reason.

## Local development

```bash
printf 'DEV_NO_AUTH=1\nMC_SERVER=demo.mcstatus.io\nCHAT_INGEST_TOKEN=local-dev-token-0123456789abcdef0123456789\n' > .dev.vars
# optional: DEV_EMAIL=<a roster email> in .dev.vars to try sending chat as that player
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

- **Combat** (its own page): every death the mod logs, for the range picked at the top (all time by default; up to two
  days is drawn by the hour, longer by the day).
  - **Red vs Blue**: one bar. Left of the divider is every Blue death: the ones no enemy caused (hatched), Blue's own
    team kills, then Red's kills up to the divider. Right of it, mirrored, every Red death. Each side's kills hang off
    the divider.
  - **Kills and deaths over time**: stacked bars per hour or day (Red kills, Blue kills, other deaths), or running
    totals as lines.
  - **Leaderboard**: kills, deaths and K/D (kills ÷ deaths) for everyone on the roster. Click a heading to sort by it,
    again to reverse; the sorted column is highlighted and the bar under each name follows it. The sort is remembered.
  - **Death log** (beside the page, foldable): every death message, newest first, as the game worded it, with a bar in
    the killer's faction color; All / PvP / Other filters it, a row's time opens the chat log at that moment, and new
    deaths slide in as they're logged.
  A kill is a death the game credits to another player (being knocked off a cliff counts). Deaths logged before mod
  1.4.0 are worked out from the message itself.
- **Player pages: egg and combat**: an **egg card** (what the player's Egg SMP egg does: passive, primary, secondary
  and their cost, from `public/eggdata.js`, plus its level and energy as the mod last reported them) and a **combat
  card** (kills, deaths, K/D and where that ranks, who they kill most, who kills them most, what else kills them, and
  their latest kills and deaths).
- **3D player model**: player pages show the player in 3D with their skin, the armor they last wore (trims, leather dye
  and the enchantment shimmer included), their best weapon in the main hand (mace, then trident, sword, axe, pickaxe,
  shovel; better material first) and their egg in the off hand (the one they carry, else their roster egg). It turns a
  little toward the mouse. Gear comes from the server mod (1.2.0 or newer); until a player has been on with it, the model
  shows just their skin and roster egg. Armor and item textures are read on demand from Mojang's official game client
  for `MC_VERSION` (in `wrangler.jsonc`; set it to the server's version) by `/api/mc/…`, so none of Mojang's files are in
  this repository; skins come from Mojang through `/api/skin/<name>`. Drawn with three.js, loaded only on player pages.
- **Advancements**: the last card on a player's page is the game's advancements screen for that player: a tab per
  category (Minecraft, Nether, The End, Adventure, Husbandry, plus any a data pack adds) with how many they have, and the
  tree laid out exactly where the game puts each advancement, with the game's frames (gold once earned), connecting
  lines, tab background and inventory-style icons, at twice the game's size. Hover (or tap) one for its title,
  description, and when it was earned or how far along it is; drag or scroll to move around. Every advancement shows,
  earned or not, except hidden ones, which appear once earned as in the game. The tree and progress come from the server
  mod (1.6.0 or newer; the card stays hidden until the mod has sent the tree). Icons are drawn in the browser from the
  game's own item models and textures (`public/mcicons.js`, through `/api/mc/item/<id>.json` and `/api/mc/textures/…`),
  so blocks, chests, skulls and beds look as they do in an inventory.
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
  10 seconds. Players whose login email is on the roster can **send chat** from the box under the log: it shows in game
  as `[Web] <name> message` (needs mod 1.3.0 and the server online; the box says when it can't send) and comes back into
  the log with a "web" tag. At most one message every 1.5 seconds and 8 per 30 seconds per player, 256 characters each.
  Above it, a players online graph follows the chat. Its cursor marks the time of the bottom message on screen,
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

- Who's online comes from two places, merged each minute: the server-list ping (through mcstatus.io), and the server
  mod's list of everyone in the tab list (mod 1.7.0 or newer, sent every 20 seconds and whenever it changes). The ping
  can leave players out: it names at most a sample, and players who turned off "Allow Server Listings" show as
  "Anonymous Player". Each check counts everyone either one names, once. While the mod's list is recent (75 seconds),
  the player count is that union and the server counts as up even if the ping fails; a mod shutdown report marks it
  down. Without a recent list it's the ping alone, as before, and if the server reports more players than it names,
  the dashboard shows a warning.
- Minutes from before mod 1.7.0 where the server counted more players than it named can be filled in from the chat
  log's joins and leaves: `node scripts/backfill-presence.mjs` (a dry run that shows what it would do), then with
  `--apply`. It never names more players at a minute than the server counted then, pairs joins and leaves by name
  (ignoring case), skips hidden players, saves an undo file (`presence-undo-…-backup.sql`) first, and changes nothing
  on a second run.
- Time played is counted in 1-minute steps. A player missing for up to 3.5 minutes stays in the same session.
- Occasionally a check wrongly reports nobody online for a minute. When the same players are seen again within
  3.5 minutes, that empty (or offline) reading is replaced by the number of players whose sessions span it.
  Smaller dips are left alone, since someone may really have relogged.
- Usage on Cloudflare's free tier: about 1,440 Cron runs per day, plus a few D1 rows written per check (1 per player).
  The chat mod adds at most one request every 3 seconds while people are talking (one row per message), and an open
  Chat log page checks for new messages every 10 seconds while it's visible. The Combat page loads the season's deaths
  once, then only what's new each minute. Web chat uses one Durable Object holding
  the mod's WebSocket, which sleeps while idle (the mod's pings are answered without waking it).
  The live online list uses a second one (`Presence`), woken by the mod's reports (about every 20 seconds while the
  server's up) and holding the pages' WebSockets, which also sleep between updates.