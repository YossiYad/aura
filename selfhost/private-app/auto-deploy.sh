#!/bin/sh
# Polls origin/main and fast-forwards. nginx bind-mounts this repo read-only,
# so a plain git pull covers most changes - no rebuild, no restart.
#
# setup.sh itself is the exception: docker-compose.yml, nginx.conf and the
# service images are only read at container build/start, not on every request,
# so a pull that touches any of them needs setup.sh re-run to take effect.
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
LOCK="/tmp/aura-auto-deploy.lock"
# Written while setup.sh is owed and removed once it succeeds. The checkout moves before
# setup.sh runs, and nginx serves the new files from that moment, so a setup.sh that
# failed (a registry hiccup during the build) would otherwise leave new
# pages talking to old containers until someone noticed: the next poll would see nothing
# to do. This file makes it owed until it has actually happened.
SETUP_PENDING="$SCRIPT_DIR/.setup-pending"

exec 9>"$LOCK"
flock -n 9 || exit 0

cd "$REPO_DIR"
# A quiet credential failure here would freeze the deploy on an old commit
# forever while looking healthy (it did, on f3452b7, for the interruption
# fixes). Say so on every failed poll instead of dying silently under set -e.
git fetch --quiet origin main || {
  echo "$(date -Iseconds) fetch of origin/main failed; still serving $(git rev-parse --short HEAD)." \
    "If the repository is private, refresh this machine's read access (gh auth login or the deploy key)."
  exit 1
}

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

run_setup() {
  echo "$(date -Iseconds) re-running setup.sh:"
  cat "$SETUP_PENDING" | sed 's/^/  /'
  if sh "$SCRIPT_DIR/setup.sh"; then
    rm -f "$SETUP_PENDING"
  else
    echo "$(date -Iseconds) setup.sh failed, see above; it will be retried on the next poll"
  fi
}

if [ "$LOCAL" != "$REMOTE" ]; then
  CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE" -- selfhost/private-app/docker-compose.yml \
    selfhost/private-app/nginx.conf selfhost/private-app/setup.sh \
    selfhost/private-app/sync selfhost/private-app/push selfhost/private-app/mix selfhost/private-app/queue \
    selfhost/private-app/media)
  if git merge-base --is-ancestor "$LOCAL" "$REMOTE"; then
    git merge --quiet --ff-only origin/main
  else
    # main was rewritten upstream, so there is nothing to fast-forward to and --ff-only
    # would fail here every minute from now on, silently freezing the deploy on an old
    # commit. This machine only ever serves what main says and is never where work
    # happens, so matching origin exactly is the correct answer. Ignored files are left
    # alone: a hard reset does not touch config.json, oauth.env, ai.env or the allowlist.
    echo "$(date -Iseconds) history was rewritten upstream, resetting to match origin/main"
    git reset --hard --quiet origin/main
  fi
  echo "$(date -Iseconds) deployed $(git rev-parse --short HEAD)"
  if [ -n "$CHANGED" ]; then
    echo "$(date -Iseconds) deploy-relevant change, setup.sh is owed"
    { [ -f "$SETUP_PENDING" ] && cat "$SETUP_PENDING"; echo "$CHANGED"; } | sort -u > "$SETUP_PENDING.tmp"
    mv "$SETUP_PENDING.tmp" "$SETUP_PENDING"
  fi
fi
# The commit being served, for the app's service worker: while it is the one its last
# full comparison of the installed shell saw, this one small file tells it nothing has
# changed, instead of it reading every file again. Written once the checkout has moved,
# so it never names a commit whose files are not all in place, and swapped in whole.
REVISION=$(git rev-parse HEAD)
if [ "$(cat app-revision.txt 2>/dev/null)" != "$REVISION" ]; then
  echo "$REVISION" > app-revision.txt.tmp
  mv app-revision.txt.tmp app-revision.txt
fi
if [ -f "$SETUP_PENDING" ]; then
  run_setup
fi
