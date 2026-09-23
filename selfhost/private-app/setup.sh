#!/bin/sh
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# auto-deploy.sh re-runs this from cron with none of the variables the first run was
# given. What that run wrote to .env is the default here; a variable set now still wins.
saved() { if [ -f "$SCRIPT_DIR/.env" ]; then sed -n "s/^$1=//p" "$SCRIPT_DIR/.env" | tail -n 1; fi; }
APP_PORT="${APP_PORT:-$(saved APP_PORT)}"; APP_PORT="${APP_PORT:-8080}"
OAUTH_PORT="${OAUTH_PORT:-$(saved OAUTH_PORT)}"; OAUTH_PORT="${OAUTH_PORT:-4180}"
INVIDIOUS_NETWORK="${INVIDIOUS_NETWORK:-$(saved INVIDIOUS_NETWORK)}"; INVIDIOUS_NETWORK="${INVIDIOUS_NETWORK:-invidious_default}"
REPO_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)

for cmd in docker; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing: $cmd"; exit 1; }
done

# The public hostname belongs to the operator, independent of the HTTPS provider.
PUBLIC_HOST="${PUBLIC_HOST:-$(saved PUBLIC_HOST)}"
case "$PUBLIC_HOST" in
  *[!A-Za-z0-9.-]*) echo "PUBLIC_HOST must contain only a DNS hostname."; exit 1 ;;
esac
if ! printf '%s\n' "$PUBLIC_HOST" | LC_ALL=C grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$' || [ "${#PUBLIC_HOST}" -gt 253 ]; then
  echo "Set PUBLIC_HOST to your domain, without https://, a port or a path."
  echo "Example: PUBLIC_HOST=music.example.com sh selfhost/private-app/setup.sh"
  exit 1
fi
if [ ! -f "$SCRIPT_DIR/oauth.env" ]; then
  echo "Copy oauth.env.example to oauth.env and configure Google sign-in first."
  exit 1
fi

# The sign-in allowlist is this machine's own business, so it is git-ignored rather than
# committed. It used to be tracked, which means the commit that stopped tracking it also
# deletes the copy sitting on a machine that pulls - and oauth2-proxy will not start
# without an allowlist. Recover it once from the last commit that still had it, so that
# pull can never lock anyone out of their own server.
AE="$SCRIPT_DIR/authenticated-emails.txt"
if [ ! -f "$AE" ]; then
  REMOVED=$(git -C "$REPO_DIR" log --format=%H -1 -- selfhost/private-app/authenticated-emails.txt 2>/dev/null || true)
  RECOVERED=0
  if [ -n "$REMOVED" ] && git -C "$REPO_DIR" show "$REMOVED^:selfhost/private-app/authenticated-emails.txt" > "$AE.tmp" 2>/dev/null; then
    # Only accept it if it holds real addresses. History can be rewritten, and a rewrite
    # that redacts personal data leaves placeholders behind - restoring those would build
    # an allowlist nobody is on and lock you out of your own server without saying why.
    if grep -qE '^[^#[:space:]]+@[^#[:space:]]+' "$AE.tmp" && ! grep -qiE '@example\.' "$AE.tmp"; then
      mv "$AE.tmp" "$AE"
      RECOVERED=1
      echo "Recovered authenticated-emails.txt from git history - it is no longer tracked, and stays on this machine from now on."
    fi
  fi
  rm -f "$AE.tmp"
  if [ "$RECOVERED" -eq 0 ]; then
    cp "$SCRIPT_DIR/authenticated-emails.example.txt" "$AE"
    echo "Created $AE from the example."
    echo "Put the Google addresses allowed to sign in there, one per line, then run this again."
    exit 1
  fi
fi

if ! docker network inspect "$INVIDIOUS_NETWORK" >/dev/null 2>&1; then
  echo "Docker network '$INVIDIOUS_NETWORK' not found."
  echo "Start Invidious first, or set INVIDIOUS_NETWORK to the right name (docker network ls)."
  exit 1
fi

# textRelay points at this machine's own /relay endpoint, which reads a public playlist
# page on the app's behalf. Written here rather than by hand, because this file is
# regenerated on every run and anything added to it by hand would be lost.
cat > "$REPO_DIR/config.json" <<EOF
{
  "invidiousInstances": ["https://$PUBLIC_HOST"],
  "textRelay": "/relay?url=",
  "mediaTickets": "/api/media/ticket"
}
EOF
echo "Wrote $REPO_DIR/config.json (git-ignored, stays on this machine)"

# Written to .env rather than only exported, so that every later "docker compose logs",
# "ps" or "restart" run by hand resolves the same value. Passing it as an environment
# variable alone made compose refuse every command that was not this script.
# .env is git-ignored, like everything else here that describes this particular machine.
cat > "$SCRIPT_DIR/.env" <<EOF
PUBLIC_HOST=$PUBLIC_HOST
APP_PORT=$APP_PORT
OAUTH_PORT=$OAUTH_PORT
INVIDIOUS_NETWORK=$INVIDIOUS_NETWORK
EOF

docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d --build --force-recreate

echo
echo "App services started. Configure your HTTPS reverse proxy on this server:"
echo "  $PUBLIC_HOST {"
echo "      reverse_proxy 127.0.0.1:$OAUTH_PORT"
echo "  }"
echo "Use the block above with Caddy, or an equivalent configuration with your HTTPS proxy."
echo "Proxy to oauth2-proxy (port $OAUTH_PORT), not directly to nginx (port $APP_PORT)."
echo "Once HTTPS is configured, open https://$PUBLIC_HOST and sign in."
echo "Google OAuth redirect URI: https://$PUBLIC_HOST/oauth2/callback"
