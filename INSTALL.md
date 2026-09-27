# Install Aura on your own server

One block installs the whole self-hosted Aura on a Linux server: Docker, your own
Invidious for search and playback, the app with sync, shared listening, push and nightly
mixes behind Google sign-in, and Caddy for HTTPS with a certificate it renews by itself.

To try the app without a server, see [Quick start](README.md#quick-start) instead.

## Before you start

Three things only you can do, because they happen outside the server:

1. **A server.** Linux with systemd and at least 2 GB of memory, such as a small cloud
   server or a computer at home. On Debian or Ubuntu, anything missing - Git, Docker,
   Caddy - is installed for you; on other systems, install Git and Docker first. Ports
   **80 and 443** must reach it from the internet: open them in your cloud provider's
   firewall, or forward them on your router when hosting at home.
2. **A domain.** Point a DNS record for the name you want, such as `music.example.com`,
   at the server's public IP address (an `A` record, and `AAAA` for IPv6).
3. **Google sign-in.** In the
   [Google Cloud console](https://console.cloud.google.com/apis/credentials), create an
   **OAuth client ID** of type **Web application**, and add this **authorized redirect
   URI**, with your own domain:

   ```text
   https://music.example.com/oauth2/callback
   ```

   Keep the client ID and client secret it shows you. If Google asks you to configure the
   consent screen first, choose **External**; while it is in testing, add the Google
   accounts that will sign in as test users. See the
   [oauth2-proxy guide](https://oauth2-proxy.github.io/oauth2-proxy/configuration/providers/google/)
   for screenshots.

## Install

Fill in the first four lines, then paste the whole block into a terminal on the server.
The two lines after them are [options](#options) you can leave as they are:

```sh
AURA_DOMAIN=music.example.com
GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET
AURA_EMAILS="you@example.com"   # the Google accounts allowed in, separated by spaces
AURA_PROXY=caddy
AURA_AUTO_UPDATE=no

(
  set -e
  S=; [ "$(id -u)" -eq 0 ] || S=sudo
  command -v git >/dev/null || { $S apt-get update && $S apt-get install -y git; }
  if [ -d /opt/aura/.git ]; then $S git -C /opt/aura pull --ff-only
  else $S git clone https://github.com/YossiYad/aura.git /opt/aura; fi
  $S env AURA_DOMAIN="$AURA_DOMAIN" GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
    GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" AURA_EMAILS="$AURA_EMAILS" \
    AURA_PROXY="$AURA_PROXY" AURA_AUTO_UPDATE="$AURA_AUTO_UPDATE" \
    sh /opt/aura/selfhost/install.sh
)
```

It takes a few minutes, mostly downloading and building. When it finishes, open
`https://` and your domain, sign in with one of the allowed accounts, and add Aura to
your home screen. Guests you invite to shared listening need no account.

If a detail is missing or wrong, it stops before changing anything and says which one.
Pasting the block again is safe: it picks up where it stopped and keeps everything an
earlier run set up.

### What it does

1. Checks the details you filled in.
2. Installs whatever is missing: Git, Docker and Caddy.
3. Starts Invidious from [`selfhost/invidious/`](selfhost/invidious/README.md), with keys
   generated for this server and its port reachable only from the server itself. The
   configuration is kept in `/opt/aura/.local/invidious/`, apart from the repository, so
   updates never touch the keys.
4. Writes the sign-in configuration - your OAuth client, a new cookie secret and the
   allowed accounts - readable only by root, and never committed.
5. Builds and starts the app's services with
   [`selfhost/private-app/setup.sh`](selfhost/private-app/README.md).
6. Adds your domain to Caddy, which gets and renews the HTTPS certificate by itself.
   Other sites already in your Caddyfile are kept.
7. Checks that your domain answers over HTTPS.

### Options

| Variable | Default | What it does |
| --- | --- | --- |
| `AURA_PROXY` | `caddy` | `none` leaves HTTPS to a proxy you already run, such as nginx. At the end it says where to point it. |
| `AURA_AUTO_UPDATE` | `no` | `yes` checks this repository every minute and applies new versions by itself. |

## After installing

| To... | Run on the server |
| --- | --- |
| Update to the latest version | `cd /opt/aura && sudo git pull --ff-only && sudo sh selfhost/private-app/setup.sh` |
| Change who can sign in | Edit `/opt/aura/selfhost/private-app/authenticated-emails.txt`, one address per line, then `sudo sh /opt/aura/selfhost/private-app/setup.sh` |
| See whether everything is running | `sudo docker compose -f /opt/aura/selfhost/private-app/docker-compose.yml ps` |
| Read the app's logs | `sudo docker compose -f /opt/aura/selfhost/private-app/docker-compose.yml logs --tail=50` |
| Read Invidious's logs | `sudo docker compose -p invidious -f /opt/aura/.local/invidious/docker-compose.yml logs --tail=50` |

For the services, their settings and shared listening in detail, see the
[private server guide](selfhost/private-app/README.md).

## If something does not work

| What you see | What to check |
| --- | --- |
| The domain does not answer over HTTPS | The DNS record points at this server, and ports 80 and 443 reach it. Caddy's log: `sudo journalctl -u caddy --since -10min`. |
| Google says `redirect_uri_mismatch` | The redirect URI on your OAuth client is exactly `https://your-domain/oauth2/callback`. |
| Google signs you in, but Aura answers 403 | Your account is not on the sign-in list; see "Change who can sign in" above. |
| "port 80 is already used by ..." | Another web server is running. Stop it, or install with `AURA_PROXY=none` and point it at the app. |
| Songs do not play or search finds nothing | Invidious's log (above). YouTube sometimes refuses a server for a while; see the [Invidious guide](selfhost/invidious/README.md). |
