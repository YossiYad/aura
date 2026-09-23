# Private self-hosted Aura

Serves Aura and the Invidious API on one HTTPS origin using your domain and reverse
proxy. Google sign-in and an email allowlist control access. Listeners need only a
browser, with no VPN or special networking app.

## Before installing

1. Prepare a Linux server with Docker Compose and a running Invidious instance. The
   default Docker network is `invidious_default` (start it with project name `invidious`).
2. Point a domain such as `music.example.com` at the server. Open ports 80 and 443.
   For a home server, forward those ports through the router to a publicly reachable
   connection. Install Caddy on the same host as Docker, or use your existing HTTPS proxy.
3. Copy `authenticated-emails.example.txt` to `authenticated-emails.txt` and put the
   Google addresses allowed to sign in there, one per line.
4. Copy `oauth.env.example` to `oauth.env` and configure the Google OAuth client and
   cookie secret. Register `https://music.example.com/oauth2/callback` with your actual
   domain. Both local files are git-ignored.

See the [full installation walkthrough](../../README.md#self-hosting) for Invidious,
OAuth credentials and HTTPS setup.

## Install

From the cloned repository root:

```sh
PUBLIC_HOST=music.example.com sh selfhost/private-app/setup.sh
```

Use your actual domain, without a scheme, port or path. The script saves it in `.env`
and generates `config.json`. It starts the app services but does not configure the
public HTTPS proxy.

Add the block from [Caddyfile.example](Caddyfile.example) to `/etc/caddy/Caddyfile`,
replace its domain and reload Caddy:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The proxy must send requests to `127.0.0.1:4180` (or your `OAUTH_PORT`), which enforces
Google sign-in. Never proxy directly to nginx on `APP_PORT`. An alternative proxy must
preserve the original Host and set `X-Forwarded-Proto: https`.

Open your HTTPS address in a browser and sign in. Add it to your phone's home screen
to install the PWA. Guest invitations use the same domain and their own approval flow.

## Updating

From the repository root:

```sh
git pull --ff-only
sh selfhost/private-app/setup.sh
```

The hostname and ports are read from the saved `.env`; explicit environment variables
override them. To change domains, run setup with the new `PUBLIC_HOST`, and update DNS,
your HTTPS proxy and Google's OAuth redirect URI to match. Browser storage belongs to
its origin, so export local data before switching domains.

`setup.sh` regenerates `config.json`. Keep custom configuration in mind before editing
that generated file. nginx serves the checkout read-only; backend or nginx changes need
a setup run to rebuild and recreate services.

For optional automatic updates, arrange for `auto-deploy.sh` to run periodically on a
dedicated deployment checkout. It fetches `origin/main`, updates the checkout and reruns
setup when service files change. Failed setup runs are retried on later polls. It also
resets the checkout if upstream history is rewritten, so do not use a development
checkout with local changes. If the repository is private, provide read access using
a deploy key or an authenticated Git client. No scheduler is installed by setup.

## Library sync

A small `aura-sync` container keeps one JSON copy of each signed-in user's data (library, playlists, likes, history, settings, queue) on a Docker volume. It holds metadata only - audio files are never uploaded and stay on the device that downloaded them. A typical copy is well under 1 MB and the server rejects anything over `SYNC_MAX_BYTES` (default 2 MB).

- The app pushes a fresh copy whenever something changes (a few seconds after), and pulls at startup when the server holds something newer. Clearing site data on any device therefore gets everything back on the next sign-in.
- The identity comes from oauth2-proxy's `X-Forwarded-Email` header, so there is nothing to configure or sign into inside the app. Requests only ever reach `aura-sync` through the authenticated proxy.
- If this device changed while another device pushed first, the newer remote copy wins and a copy of this device's version is kept on the server - Settings then shows "Recover other-device copy".
- Deleting the library in Settings also clears the synced copy, because sync means sync. Use Download backup first if you want a way back.
- To wipe stored data entirely: `docker volume rm private-app_aura-sync-data` (adjust the project prefix to yours), or `DELETE /api/sync/` while signed in.

## Shared playlists

Personal sync is one blob per identity that never crosses accounts. Shared playlists are
the deliberate opposite: one file per playlist under `shared/` in the same volume, visible
to everyone oauth2-proxy lets through. That is the point - a household builds a list
together from separate phones. They only exist on this self-hosted setup; the public app
has no server to share on and never shows the option.

- **Share a playlist**: its ⋯ menu in Library → Playlists → "Share with everyone on this
  server". A copy goes to the server; your own playlist stays yours.
- **Anyone can add.** Shared lists appear in the "Add to playlist" sheet for every signed-in
  listener, and adding appends to the server copy. Only the person who shared it can rename
  it, remove songs, or stop sharing - so one listener cannot quietly undo what the rest of
  the household put together.
- **"Update the shared copy"** pushes your local version, folding in anything others added
  since, so republishing never deletes their songs.
- Songs are metadata only, capped at `SYNC_SHARED_MAX_TRACKS` (default 600) per list, and
  the client keeps a local cache so a shared list still opens with no connection.
- Endpoints, all behind the same authenticated proxy: `GET /api/sync/shared` (index),
  `POST /api/sync/shared` (create), `GET|PUT|DELETE /api/sync/shared/<id>`,
  `POST /api/sync/shared/<id>/tracks` (the append anyone may do).

## AuraShare with QR invitations

The `aura-queue` container lets guests join from a QR without an app account. They enter
a name and wait for individual approval. The host sees requests and chooses each
participant's permission: free additions, approval required, or viewing and voting only.
Open **Create > share**. Playback starts with an empty session queue, prioritizes host and
guest contributions, and adds one related song whenever that queue runs out.
There is no per-guest song count limit. The QR expires after the chosen lifetime and can
be revoked immediately. Restarting this service also closes its temporary sessions.

Only the exact `/guest/` page, its three assets and its guest API methods bypass login.
The host API on `/api/queue/` keeps the existing sign-in requirement. Two separate internal
listeners keep guest requests away from host operations. The new routes and container
require running `setup.sh` after updating. See [shared queue](../../docs/shared-queue.md)
for behavior, permissions, verification and deployment details.

## Push notifications for followed artists & podcasts

Following an artist or podcast (from their page, in the app) works everywhere with no
setup - it's just local data, synced like everything else by `aura-sync` if it's running.
Real push notifications - ones that arrive even when the app isn't open - need a server,
which is what the `aura-push` container here is for. It only runs as part of this
self-hosted setup; the public app has no push behind it.

- Uses Web Push (VAPID), the same mechanism behind Chrome/Android push - no Google or Apple
  account, no native app. On iPhone it only works once the app is added to the Home Screen
  (Safari's rule for standalone PWAs since iOS 16.4); on Android/Galaxy phones it works from
  either the installed app or a normal browser tab.
- A VAPID keypair is generated on first start and kept in the `aura-push-data` volume
  (`vapid.json`) - it has to survive restarts, or every device that subscribed would need to
  subscribe again.
- Every `PUSH_POLL_MINUTES` (default 20), it reads each signed-in listener's follows list
  straight out of `aura-sync`'s data (mounted read-only - it never writes there), asks
  Invidious for each followed channel's newest upload and release, and pushes to every
  subscribed device when something changed. Following an artist never triggers a wall of
  pushes for their back catalog - only what shows up afterward does.
- With no `aura-sync` running (or no one signed in with anything followed), it just sits
  idle - there's nothing to check.
- To wipe stored subscriptions and state: `docker volume rm private-app_aura-push-data`
  (adjust the project prefix to yours).

| Variable | Default | Meaning |
|---|---|---|
| `PUSH_POLL_MINUTES` | `20` | How often followed channels are checked for something new |
| `PUSH_VAPID_SUBJECT` | `mailto:push@localhost` | Contact URI/email sent with every push, per the Web Push spec - doesn't need to be reachable |

## The nightly mix

Home's "Picked for you today" row is an AI request shaped by your own listening history.
The app can build it on the device - that's what the **Daily prep** settings do - but only
while a phone is awake at the right hour, and every device repeats the same work for
itself. The `aura-mix` container here does it once a night on this machine instead, and
every signed-in device picks up the finished mix as a single same-origin request.

### Whose key it uses

Everyone has their own AI key, so the mix is built with the key of the person it is for.
That happens on its own: when the app finds this server and has a key, it hands it over.
The switch is **Settings -> AI -> Daily prep -> Let the server use my key**, on by default,
and turning it off deletes the copy on the server rather than merely stopping the next
handoff. A device without a local key leaves the account's server key alone. Use the switch to remove that server copy explicitly.

This is the only place in the app where a key ever leaves a device, and it only ever goes
here: same origin, behind your own sign-in, to the service that builds your mix. The public
app has no such server and none of it runs there.

- Keys are stored per identity on the `aura-mix-data` volume, in the clear - the same
  standing as the VAPID private key `aura-push` keeps next door. Anyone who can read that
  volume can read them, which is exactly why this is worth doing only on a server you run
  yourself, and why the app never does it behind your back.
- They are kept out of everything else on purpose: not in `aura-sync`'s blob, so they never
  reach another device or a backup, and not in the mix file, which is content.
- A shared "house" key is optional. Copy `ai.env.example` to `ai.env` and fill it in if you
  want anyone who hasn't handed a key over to be covered anyway.
- With no key of either kind, nothing is built and every device falls back to building its
  own mix exactly as before. Nothing here is required.

### What the run does

At `MIX_HOUR` local time it reads each listener's listening profile out of `aura-sync`'s
data (mounted read-only - it never writes there), asks the model for about `MIX_SONGS`
songs, resolves each one to a real track through Invidious, and drops anything that isn't
music, is on that listener's blocked list, or falls outside the artists they actually play.
The result goes in the `aura-mix-data` volume, one file per identity.

Local time follows `TZ`, so 4 means 4 where the machine is. The run reschedules itself one
day at a time rather than every 24 hours, so a daylight saving change moves with the clock,
and a container that was down at 4am catches the missed slot up ~30 seconds after it starts
instead of skipping a day. Anyone with no key is skipped rather than reported as a failure.

- Rebuild for yourself, without waiting for tonight: `POST /api/mix/rebuild` while signed
  in (rate-limited to one every 10 minutes per person).
- To wipe stored mixes and keys: `docker volume rm private-app_aura-mix-data` (adjust the
  project prefix to yours).

| Variable | Default | Meaning |
|---|---|---|
| `TZ` | `Asia/Jerusalem` | Which clock `MIX_HOUR` is on |
| `MIX_HOUR` | `4` | Hour of the day the mixes are built, 0-23 |
| `MIX_SONGS` | `15` | Roughly how many songs to ask for |
| `GEMINI_KEYS` / `GROQ_KEYS` | *(unset)* | Optional shared fallback key, in `ai.env` |
| `GEMINI_MODEL` / `GROQ_MODEL` | as in the app | Override the model for the shared key |

## Resource usage

One extra nginx container, capped at 64 MB and typically using about 5 MB. `aura-push`
adds one more small Node container, capped at 96 MB, and `aura-mix` another, capped at
128 MB and asleep between nightly runs.

## Settings you can override

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_HOST` | *(required on first run)* | Public domain without scheme, port or path; saved for updates |
| `APP_PORT` | `8080` | Loopback port nginx listens on before oauth2-proxy |
| `OAUTH_PORT` | `4180` | Loopback port oauth2-proxy listens on before the HTTPS reverse proxy |
| `INVIDIOUS_NETWORK` | `invidious_default` | Docker network the Invidious container is on |

## Notes

- nginx and oauth2-proxy bind to loopback only. The HTTPS proxy publishes oauth2-proxy's
  port. App requests require Google authentication and the email allowlist; guest
  invitation routes and signed media have their own access checks.
- `/api/sync/`, `/api/push/` and `/api/mix/` go to their own containers; `/api/`,
  `/videoplayback`, `/latest_version` and `/vi/` are proxied to Invidious. The app and
  API share an origin, avoiding cross-origin browser requests.
- To stop the services, run `docker compose -f selfhost/private-app/docker-compose.yml down`.
  Remove this app's domain block from your HTTPS proxy and reload it to stop serving
  that address too.
