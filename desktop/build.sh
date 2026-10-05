#!/bin/sh
# Builds the desktop app's installers inside a container, so the machine itself needs
# neither Node nor Electron:
#   linux (the default)  desktop/dist/Aura-x86_64.AppImage
#   all                  that, and desktop/dist/Aura-Setup-x64.exe for Windows. Windows
#                        needs Wine, which comes in a much larger image (about 5 GB).
# A server that has them offers them under Settings > About > "Get the desktop app" (see
# nginx.conf, /desktop/download/). With --if-changed it does nothing unless the app's own
# files have changed since the last attempt, which is how auto-deploy.sh calls it.
#   sh desktop/build.sh [--if-changed] [linux|all]
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
STAMP="$DIR/dist/.built-from"

IF_CHANGED=no
if [ "${1:-}" = "--if-changed" ]; then IF_CHANGED=yes; shift; fi
TARGETS="${1:-linux}"
case "$TARGETS" in linux|all) ;; *) echo "desktop/build.sh: build linux or all, not \"$TARGETS\""; exit 1 ;; esac

NOW=$( (cd "$DIR" && cat package.json package-lock.json ./*.js pages/* icons/* build/*; echo "$TARGETS") | sha256sum | cut -d' ' -f1)
if [ "$IF_CHANGED" = yes ] && [ "$(cat "$STAMP" 2>/dev/null || true)" = "$NOW" ]; then exit 0; fi

if command -v docker >/dev/null 2>&1; then RUN=docker
elif command -v podman >/dev/null 2>&1; then RUN=podman
else echo "desktop/build.sh needs docker or podman"; exit 1; fi
# Where SELinux is enforcing, a container may only read a folder that is labelled for it.
MOUNT="$DIR:/w"
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = Enforcing ]; then MOUNT="$MOUNT:Z"; fi

# The attempt is recorded before it is made: a build that fails is tried again when the
# files change or when this is run by hand, not once a minute for ever.
mkdir -p "$DIR/dist"
echo "$NOW" > "$STAMP"

echo "Building the Aura desktop app for Linux (downloads Electron the first time, a few minutes)..."
"$RUN" run --rm -v "$MOUNT" -w /w docker.io/library/node:22-bookworm-slim \
  sh -c 'npm ci --no-audit --no-fund && npx electron-builder --linux AppImage --x64'
ls -l "$DIR/dist/Aura-x86_64.AppImage"

if [ "$TARGETS" = all ]; then
  echo "Building the Aura desktop app for Windows (a large image the first time)..."
  "$RUN" run --rm -v "$MOUNT" -w /w docker.io/electronuserland/builder:wine \
    sh -c 'npm ci --no-audit --no-fund && npx electron-builder --win nsis --x64'
  ls -l "$DIR/dist/Aura-Setup-x64.exe"
fi
