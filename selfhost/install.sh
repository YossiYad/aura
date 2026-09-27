#!/bin/sh
# Installs the whole self-hosted Aura on one Linux server: Docker, Invidious, the app's
# services behind Google sign-in, and Caddy for HTTPS. INSTALL.md has the one block that
# runs it. Everything it asks for comes in as variables:
#
#   AURA_DOMAIN           the domain whose DNS points at this server, e.g. music.example.com
#   GOOGLE_CLIENT_ID      the Google OAuth client (Web application) for sign-in
#   GOOGLE_CLIENT_SECRET
#   AURA_EMAILS           the Google accounts allowed to sign in, separated by spaces
#   AURA_PROXY            caddy (default), or none to keep an HTTPS proxy of your own
#   AURA_AUTO_UPDATE      yes to pull and apply updates every minute; no (default)
#
# Running it again is safe. What an earlier run set up is kept: Invidious keeps its keys
# and database, and a sign-in configuration already on this machine is not overwritten,
# so the Google and email variables are only needed the first time.
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
APP_DIR="$REPO_DIR/selfhost/private-app"
INVIDIOUS_DIR="$REPO_DIR/.local/invidious"
# A later run finds the domain the first one saved.
AURA_DOMAIN="${AURA_DOMAIN:-$( [ -f "$APP_DIR/.env" ] && sed -n 's/^PUBLIC_HOST=//p' "$APP_DIR/.env" | tail -n 1 || true)}"
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}"
AURA_EMAILS="${AURA_EMAILS:-}"
AURA_PROXY="${AURA_PROXY:-caddy}"
AURA_AUTO_UPDATE="${AURA_AUTO_UPDATE:-no}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nInstall stopped: %s\n' "$*" >&2; exit 1; }

# ---- What the installer was given, checked before anything changes ----

[ "$(id -u)" -eq 0 ] || fail "run it as root, with sudo (see INSTALL.md)."
case "$AURA_DOMAIN" in
  http://*|https://*|*/*|*:*) fail "AURA_DOMAIN is only the name, such as music.example.com - no https://, port or path." ;;
  *[!A-Za-z0-9.-]*) fail "AURA_DOMAIN may hold only letters, digits, dots and hyphens." ;;
esac
if ! printf '%s\n' "$AURA_DOMAIN" | LC_ALL=C grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$' ||
   [ "${#AURA_DOMAIN}" -gt 253 ] || [ "$AURA_DOMAIN" = "music.example.com" ]; then
  fail "set AURA_DOMAIN to your own domain, such as music.example.com."
fi
if [ ! -f "$APP_DIR/oauth.env" ]; then
  case "$GOOGLE_CLIENT_ID" in
    ""|YOUR_*|*[!A-Za-z0-9._-]*) fail "set GOOGLE_CLIENT_ID to your Google OAuth client ID." ;;
  esac
  case "$GOOGLE_CLIENT_SECRET" in
    ""|YOUR_*|*[!A-Za-z0-9._-]*) fail "set GOOGLE_CLIENT_SECRET to your Google OAuth client secret." ;;
  esac
fi
if [ ! -f "$APP_DIR/authenticated-emails.txt" ]; then
  EMAILS=$(printf '%s\n' "$AURA_EMAILS" | tr ',' ' ' | tr -s ' ' '\n' | sed '/^$/d')
  [ -n "$EMAILS" ] || fail "set AURA_EMAILS to the Google accounts allowed to sign in."
  set -f
  for email in $EMAILS; do
    printf '%s\n' "$email" | LC_ALL=C grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' || fail "\"$email\" in AURA_EMAILS is not an email address."
    case "$email" in *@example.*) fail "replace the example address in AURA_EMAILS with your own." ;; esac
  done
  set +f
fi
case "$AURA_PROXY" in caddy|none) ;; *) fail "AURA_PROXY is caddy or none." ;; esac
case "$AURA_AUTO_UPDATE" in yes|no) ;; *) fail "AURA_AUTO_UPDATE is yes or no." ;; esac

# ---- The tools ----

apt_install() {
  command -v apt-get >/dev/null 2>&1 || fail "install $* yourself, then run this again (automatic installs need Debian or Ubuntu)."
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
}

step "Checking the tools"
MISSING=""
for tool in curl openssl git; do command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"; done
if [ "$AURA_AUTO_UPDATE" = yes ] && ! command -v crontab >/dev/null 2>&1; then MISSING="$MISSING cron"; fi
# shellcheck disable=SC2086
[ -z "$MISSING" ] || apt_install ca-certificates $MISSING

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  step "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker info >/dev/null 2>&1; then
  command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker >/dev/null 2>&1 || true
  docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Start it (systemctl start docker) and run this again."
fi

# Caddy answers on 80 and 443 for the certificate. Something else already there - another
# web server - would make it fail halfway, so that is found out first.
port_owner() {
  command -v ss >/dev/null 2>&1 || return 0
  ss -Hltnp "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n 1
}
if [ "$AURA_PROXY" = caddy ]; then
  command -v systemctl >/dev/null 2>&1 || fail "setting up Caddy needs systemd. Run with AURA_PROXY=none and use an HTTPS proxy of your own (see INSTALL.md)."
  for port in 80 443; do
    owner=$(port_owner "$port")
    if [ -n "$owner" ] && [ "$owner" != caddy ]; then
      fail "port $port is already used by $owner. Stop it, or run with AURA_PROXY=none and point your own HTTPS proxy at the app (see INSTALL.md)."
    fi
  done
  if ! command -v caddy >/dev/null 2>&1; then
    step "Installing Caddy"
    apt_install debian-keyring debian-archive-keyring apt-transport-https gnupg
    # Caddy's own package repository, as its install guide sets it up.
    CADDY_KEY=$(mktemp)
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' -o "$CADDY_KEY" ||
      fail "could not download Caddy's signing key from dl.cloudsmith.io. Check this server's internet access and run this again."
    gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg "$CADDY_KEY"
    rm -f "$CADDY_KEY"
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list ||
      fail "could not download Caddy's package list from dl.cloudsmith.io. Check this server's internet access and run this again."
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt_install caddy
  fi
fi

# ---- Invidious ----

# A local copy of the compose file, with keys made for this machine. The one in the
# repository keeps its placeholders, so pulling updates never touches this machine's keys.
step "Starting Invidious"
if [ ! -f "$INVIDIOUS_DIR/docker-compose.yml" ]; then
  mkdir -p "$INVIDIOUS_DIR"
  COMPANION_KEY=$(openssl rand -hex 8)
  HMAC_KEY=$(openssl rand -hex 32)
  # The companion key is exactly 16 letters and digits, the same in both places; the raw
  # port stays on this machine, since the app reaches Invidious over Docker's own network.
  sed -e "s/CHANGEME16CHARS0/$COMPANION_KEY/g" -e "s/CHANGE_ME_HMAC_KEY/$HMAC_KEY/" \
      -e 's/"3000:3000"/"127.0.0.1:3000:3000"/' \
      "$REPO_DIR/selfhost/invidious/docker-compose.yml" > "$INVIDIOUS_DIR/docker-compose.yml.tmp"
  if grep -q 'CHANGEME16CHARS0\|CHANGE_ME_HMAC_KEY' "$INVIDIOUS_DIR/docker-compose.yml.tmp" ||
     ! grep -q '"127.0.0.1:3000:3000"' "$INVIDIOUS_DIR/docker-compose.yml.tmp"; then
    rm -f "$INVIDIOUS_DIR/docker-compose.yml.tmp"
    fail "selfhost/invidious/docker-compose.yml no longer has the placeholders this installer fills in."
  fi
  chmod 600 "$INVIDIOUS_DIR/docker-compose.yml.tmp"
  mv "$INVIDIOUS_DIR/docker-compose.yml.tmp" "$INVIDIOUS_DIR/docker-compose.yml"
  echo "Wrote $INVIDIOUS_DIR/docker-compose.yml with new keys (git-ignored, stays on this machine)"
fi
# The project name makes the network invidious_default, which the app's services join.
docker compose -p invidious -f "$INVIDIOUS_DIR/docker-compose.yml" up -d ||
  fail "Invidious could not start. If an image did not download, check this server's internet access to quay.io and docker.io, then run this again."
printf 'Waiting for Invidious to answer'
code=000; waited=0
while [ "$waited" -lt 300 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 'http://127.0.0.1:3000/api/v1/search?q=test' || true)
  [ "$code" = 000 ] || break
  printf '.'; sleep 5; waited=$((waited + 5))
done
echo
case "$code" in
  000) fail "Invidious did not start within five minutes. See: docker compose -p invidious -f $INVIDIOUS_DIR/docker-compose.yml logs --tail=50" ;;
  200) echo "Invidious answers searches." ;;
  401) fail "Invidious answers 401: its companion is not running. See: docker compose -p invidious -f $INVIDIOUS_DIR/docker-compose.yml logs --tail=20 invidious-companion" ;;
  *) echo "Invidious is up, but a test search answered $code. YouTube may be refusing this server for now; the install carries on, and playback works once searches do." ;;
esac

# ---- Sign-in ----

step "Configuring Google sign-in"
if [ -f "$APP_DIR/oauth.env" ]; then
  echo "Keeping the existing $APP_DIR/oauth.env"
else
  COOKIE_SECRET=$(openssl rand -base64 32 | tr -- '+/' '-_')
  umask 077
  cat > "$APP_DIR/oauth.env" <<EOF
OAUTH2_PROXY_CLIENT_ID=$GOOGLE_CLIENT_ID
OAUTH2_PROXY_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
OAUTH2_PROXY_COOKIE_SECRET=$COOKIE_SECRET
EOF
  umask 022
  echo "Wrote $APP_DIR/oauth.env (git-ignored, stays on this machine)"
fi
if [ -f "$APP_DIR/authenticated-emails.txt" ]; then
  echo "Keeping the existing sign-in list, $APP_DIR/authenticated-emails.txt"
else
  printf '%s\n' "$AURA_EMAILS" | tr ',' ' ' | tr -s ' ' '\n' | sed '/^$/d' > "$APP_DIR/authenticated-emails.txt"
  echo "Allowed to sign in: $(tr '\n' ' ' < "$APP_DIR/authenticated-emails.txt")"
fi

# ---- The app ----

step "Building and starting the app"
# Its output - the image builds, mostly - goes to a log, shown only if it fails.
if ! PUBLIC_HOST="$AURA_DOMAIN" sh "$APP_DIR/setup.sh" > "$REPO_DIR/.local/setup.log" 2>&1; then
  tail -n 40 "$REPO_DIR/.local/setup.log"
  fail "setup.sh failed; the full output is in $REPO_DIR/.local/setup.log."
fi
OAUTH_PORT=$(sed -n 's/^OAUTH_PORT=//p' "$APP_DIR/.env" | tail -n 1)
echo "The app is running behind sign-in on 127.0.0.1:$OAUTH_PORT."

# ---- HTTPS ----

if [ "$AURA_PROXY" = caddy ]; then
  step "Configuring HTTPS with Caddy"
  mkdir -p "$(dirname "$CADDYFILE")"
  touch "$CADDYFILE"
  # Caddy's package ships a placeholder page on port 80. It is replaced outright; any other
  # Caddyfile keeps its own sites, and only the block between the markers is Aura's.
  if [ "$(sed -e 's/#.*//' "$CADDYFILE" | tr -d ' \t\n')" = ":80{root*/usr/share/caddyfile_server}" ]; then
    : > "$CADDYFILE"
  fi
  awk '/^# BEGIN aura/{skip=1} !skip{print} /^# END aura/{skip=0}' "$CADDYFILE" > "$CADDYFILE.tmp"
  cat >> "$CADDYFILE.tmp" <<EOF
# BEGIN aura - written by selfhost/install.sh, rewritten on every run
$AURA_DOMAIN {
	reverse_proxy 127.0.0.1:$OAUTH_PORT
}
# END aura
EOF
  caddy validate --config "$CADDYFILE.tmp" --adapter caddyfile >/dev/null 2>&1 || {
    caddy validate --config "$CADDYFILE.tmp" --adapter caddyfile || true
    rm -f "$CADDYFILE.tmp"
    fail "the new Caddyfile does not validate; $CADDYFILE is unchanged."
  }
  mv "$CADDYFILE.tmp" "$CADDYFILE"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && echo "Opened ports 80 and 443 in ufw."
  fi
  if systemctl is-active --quiet caddy; then systemctl reload caddy; else systemctl enable --now caddy; fi
fi

# ---- Updates ----

if [ "$AURA_AUTO_UPDATE" = yes ]; then
  step "Turning on automatic updates"
  LINE="* * * * * sh $APP_DIR/auto-deploy.sh >> /var/log/aura-auto-deploy.log 2>&1"
  if crontab -l 2>/dev/null | grep -qF "$APP_DIR/auto-deploy.sh"; then
    echo "Already on."
  else
    { crontab -l 2>/dev/null || true; echo "$LINE"; } | crontab -
    echo "Every minute this server pulls origin/main and applies it; the log is /var/log/aura-auto-deploy.log."
  fi
fi

# ---- Done ----

if [ "$AURA_PROXY" = caddy ]; then
  step "Checking https://$AURA_DOMAIN"
  code=000; waited=0
  while [ "$waited" -lt 90 ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$AURA_DOMAIN/" || true)
    case "$code" in 2??|3??|401|403) break ;; esac
    sleep 5; waited=$((waited + 5))
  done
  case "$code" in
    2??|3??|401|403) echo "It answers over HTTPS." ;;
    *) echo "It does not answer over HTTPS yet. Check that $AURA_DOMAIN points at this server's public address and that ports 80 and 443 reach it; Caddy gets the certificate by itself once they do. Its log: journalctl -u caddy --since -10min" ;;
  esac
else
  step "Point your HTTPS proxy at the app"
  echo "Forward https://$AURA_DOMAIN to http://127.0.0.1:$OAUTH_PORT, keep the original Host header and set X-Forwarded-Proto: https."
fi

cat <<EOF

Aura is installed.
  Open:          https://$AURA_DOMAIN
  Google sign-in redirect URI (must be on your OAuth client exactly):
                 https://$AURA_DOMAIN/oauth2/callback
  Update later:  cd $REPO_DIR && sudo git pull --ff-only && sudo sh selfhost/private-app/setup.sh
EOF
