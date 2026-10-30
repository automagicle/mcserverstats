# mcstats-chat (server mod)

A small server-side Fabric mod that sends the server's public chat to the dashboard's **Chat log** page.
It's one jar with no other dependencies (the bits of Fabric API it uses are bundled inside), for
Minecraft **26.2** on Fabric Loader 0.18.4 or newer. Players don't install anything.

**Recorded:** public chat, `/say`, `/me`, joins, leaves, deaths, advancements, and server start/stop.
Names are sent as chat shows them (team prefix and colors), so the dashboard can match.
**Never recorded:** private messages (`/msg`, `/tell`, `/w`, `/teammsg`) and commands. Let players know chat is logged.

## How it gets to the dashboard

```
Minecraft server ── mod queues each message ──► every few seconds, one HTTPS POST
                                                 to /api/ingest/chat on the Worker
                    Cloudflare Access ──────────► lets it through only with the service token
                    Worker ─────────────────────► checks CHAT_INGEST_TOKEN, stores rows in D1 (chat table)
Dashboard ◄──────── /api/chat ◄────────────────── read by the Chat log page (behind your normal login)
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
   - Upload `mcstats-chat-1.0.1.jar` into the server's `mods` folder.
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
| `Couldn't send chat: …` | The rest of the line says which part is wrong (token, Access, or url). |

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

## Building

Needs JDK 25.

```bash
cd mod
./gradlew build      # → build/libs/mcstats-chat-1.0.1.jar
```

For another Minecraft version, update `minecraft_version` and `fabric_api_version` in `gradle.properties`
(see https://fabricmc.net/develop) and the `minecraft` range in `src/main/resources/fabric.mod.json`, then rebuild.
