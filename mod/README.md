# mcstats-chat (server mod)

A small server-side Fabric mod that sends the server's public chat to the dashboard's **Chat log** page, every death
to its **Combat** page, what each player wears and carries to the **3D model** on their player page, and shows chat
sent from the dashboard in game.
It's one jar with no other dependencies (the bits of Fabric API it uses are bundled inside), for
Minecraft **26.2** on Fabric Loader 0.18.4 or newer. Players don't install anything.

**Recorded:** public chat, `/say`, `/me`, joins, leaves, deaths, advancements, and server start/stop.
Names are sent as chat shows them (team prefix and colors), so the dashboard can match. Deaths and
advancements are sent styled as a whole, so a killer's name, a named weapon or an advancement title keeps its color
(needs 1.1.0 or newer; older versions still work, with plainer death messages).
**Deaths** (1.4.0 or newer): each death message also says how it happened, for the Combat page: the game's own name for
the cause (`death.attack.player.item`, `death.fell.accident.generic`, …), who the game credits with it (a player's name
and UUID, or a creature's type like `zombie`) and the named item it was done with. All of it is read off the death
message the game already broadcasts, so nothing extra is tracked. Older versions' deaths still count: the dashboard
works out the killer from the message.
**Advancements** (1.6.0 or newer): the advancement tree as the game lays it out on its advancements screen (every
advancement's title, description, icon, frame, parent and position, data packs' included), sent when the server starts
and after a data pack reload; and each online player's progress in it (which they have and when they got each, and for
the ones they're partway through, how far and which criteria are done), checked every 15 seconds and sent only when it
changed, at most twice a minute per player. Both go to `/api/ingest/advancements` next to the chat url (same token, no
extra setup). The dashboard draws them as the tree at the bottom of each player's page.
**Who's online** (1.7.0 or newer): everyone in the server's tab list (UUID and name), sent to `/api/ingest/online` next
to the chat url (same token, no extra setup) whenever it changes and every 20 seconds regardless, plus an empty list when
the server shuts down. The dashboard adds these players to the ones the server-list ping names, which can leave some
out (it lists at most a sample, and players who turned off "Allow Server Listings" appear as "Anonymous Player").
**Weapon tooltips** (1.5.0 or newer): the item named in a death message (the weapon) is sent with the tooltip the game
shows for it (name, enchantments, attributes, lore), so the dashboard can show it on hover.

**Egg** (1.4.0 or newer): with the gear report, each player's Egg SMP egg type, level and energy, read from the egg
mod's scoreboard scores (`egg.type`, `egg.tier`, `egg.energy`); nothing is sent if those don't exist.
**Gear** (1.2.0 or newer): each online player's armor (with trims and dye), both hands, and the weapons, tools and Egg SMP
eggs in their inventory (nothing else from it). Checked every 10 seconds and sent only when it changed, at most once a
minute per player, to `/api/ingest/gear` next to the chat url (same token, no extra setup).
**Web chat** (1.3.0 or newer): players signed in to the dashboard with a roster email can type in the Chat log. The mod
keeps one WebSocket open to `/api/ingest/link` next to the chat url (same token and service token, no extra setup) and
shows each message to everyone as `[Web] <name> message`, the name in its team's colors. It's logged like other chat,
with a "web" tag on the dashboard. Admins (emails listed as admins on the dashboard's roster) show as `[Web] [Admin] message`, the tag in yellow. If the server isn't connected, the dashboard says so and nothing is queued.
**Whispers** (1.8.0 or newer): `/w Name text` (or `/msg`, `/tell`) typed on the dashboard comes down the same WebSocket and
is shown only to Name, the way the game shows a whisper, as `[Web] Sender whispers to you: text`. And a whisper typed in
game to someone who isn't on the server but has the dashboard open goes up to their page instead of failing with "No
player was found" (the dashboard sends the mod who's on it whenever that changes); the sender sees `[Web] You whisper to
Name: text`. In game, Tab after `/w`, `/msg` or `/tell` suggests those players too, marked `<web>`, along with everyone in
game (the server answers that argument's suggestions instead of the game's own tab list). This uses the mod's first mixin, on the game's command handler: it only steps in for a whisper to someone who's
on the dashboard and not in game, and if it ever can't apply, that's all that stops working. Whispers between players in
game are never recorded or sent anywhere.
From 1.6.1 the mod's answers can no longer get lost behind a ping, and a message the server was too busy to show within
4 seconds is dropped rather than shown after the sender was told it failed. If no answer comes in time, the dashboard keeps
the message as "sending…" and watches the log for it before saying it failed.
Set `web_chat=false` to turn it off.
**Never recorded:** private messages (`/msg`, `/tell`, `/w`, `/teammsg`) and commands. Let players know chat is logged.

## How it gets to the dashboard

```
Minecraft server ── mod queues each message ──► every few seconds, one HTTPS POST
                                                 to /api/ingest/chat on the Worker
                    Cloudflare Access ──────────► lets it through only with the service token
                    Worker ─────────────────────► checks CHAT_INGEST_TOKEN, stores rows in D1 (chat table)
Dashboard ◄──────── /api/chat ◄────────────────── read by the Chat log page (behind your normal login)

Dashboard ── POST /api/chat/send ──► Worker checks the login email is on the roster
                                     ──► Durable Object ──► the mod's WebSocket (/api/ingest/link)
                                     ──► mod shows "[Web] <name> …" in game, answers ok, logs it as chat
```

The upload runs on a background thread, so the game never waits on it. If the dashboard can't be
reached, messages wait and are retried with backoff. Anything still unsent at shutdown is saved to
`config/mcstats-chat-pending.json` and sent after the next start. Each message has a unique id, so a
retried batch is never stored twice.

## Setup (once)

1. **Make a token** (any long random string):

   ```bash
   openssl rand -hex 32
   ```

2. **Give it to the Worker** as a secret named `CHAT_INGEST_TOKEN`:

   ```bash
   npx wrangler secret put CHAT_INGEST_TOKEN
   ```

   You can also add it in the Cloudflare dashboard: **Workers & Pages → mcstats → Settings → Variables and Secrets → Add → Secret**.

3. **Create an Access service token**, so the mod can get past the login page. In Cloudflare
   **Zero Trust → Access → Service credentials → Service Tokens**, click **Create Service Token**,
   name it `mcstats-chat`, and pick **Non-expiring**. Copy the **Client ID** and **Client Secret**
   (the secret is only shown once).

4. **Allow that token on the dashboard's Access application.** Go to **Zero Trust → Access → Applications**,
   open the mcstats `workers.dev` application, then **Policies → Add a policy**:
   - Action: **Service Auth**
   - Include: **Service Token** → `mcstats-chat`

   Save. A service token can only post chat; the Worker won't show it any dashboard data.

5. **Deploy the dashboard.** Merging to `main` deploys it and creates the `chat` table.

6. **Install the mod on mcsh.io.**
   - Upload `mcstats-chat-1.8.0.jar` into the server's `mods` folder.
   - Start the server once. That creates `config/mcstats-chat.properties`.
   - Fill in that file (the template has comments):

     ```properties
     url=https://mcstats.<your-subdomain>.workers.dev/api/ingest/chat
     token=<the CHAT_INGEST_TOKEN from step 1>
     access_client_id=<Client ID from step 3>
     access_client_secret=<Client Secret from step 3>
     ```

     Saved changes are picked up within a few seconds; no restart needed. You can also upload a
     filled-in copy of the file to `config/` before the first start.

7. **Check it.** The server console should say `Sending chat to …`. Say something in chat; it shows up
   on the Chat log page within about 15 seconds. If anything is wrong, the console says what
   (wrong token, Access blocking it, wrong url), at most once every 10 minutes.

## Troubleshooting

Search the server console (latest.log) for `mcstats-chat`:

| Console says | Meaning |
| --- | --- |
| nothing at all | The mod didn't load. Check that the jar is in `mods/`, that the server runs Fabric (not Paper/Forge), and look for a Fabric error naming `mcstats_chat` near the top of the log. |
| `Created …/mcstats-chat.properties` on every start | The filled-in file isn't where the mod looks, or has a different name. It must be exactly `config/mcstats-chat.properties`. |
| `Not sending chat: url is blank` (or `token`) | The file was found but that value is empty. Check spelling of the keys (`url=`, `token=`). |
| `Sending chat to …` then `Chat log connected` | Working. |
| `Web chat connected` | Messages typed on the dashboard will show in game. |
| `The dashboard lost the web chat connection; reconnecting` | 1.7.1 or newer: the dashboard said for 40 seconds that it no longer has the connection (usually just after a deploy); it reconnects by itself. |
| `Web chat isn't connected: …` | Same reasons as below; the dashboard shows the message box as offline meanwhile. |
| `Couldn't send chat: …` | The rest of the line says which part is wrong. Note that Cloudflare Access answers 401 for a service token it doesn't recognise and 403 for one it knows but no Service Auth policy allows. |

To test a config file from your own computer, put a copy named `mcstats-chat.properties` in the repo root
(it's gitignored) and run `node scripts/test-chat-ingest.mjs`. It sends one test message the same way the
mod does and says what's wrong, without printing the secrets. Add `--check` to test without storing anything,
or pass another file's path.


| Key | |
| --- | --- |
| `url` | The dashboard address plus `/api/ingest/chat` |
| `token` | Must equal the Worker's `CHAT_INGEST_TOKEN` |
| `access_client_id`, `access_client_secret` | The Cloudflare Access service token |
| `system_messages` | `false` to send only chat, without joins, leaves, deaths and advancements (default `true`) |
| `web_chat` | `false` to stop showing chat sent from the dashboard (default `true`) |

## Building

Needs JDK 25.

```bash
cd mod
./gradlew build      # → build/libs/mcstats-chat-1.8.0.jar
```

For another Minecraft version, update `minecraft_version` and `fabric_api_version` in `gradle.properties`
(see https://fabricmc.net/develop) and the `minecraft` range in `src/main/resources/fabric.mod.json`, then rebuild.
