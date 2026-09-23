# Self-hosted Invidious for aura-music

Running your own Invidious instance makes search and playback much faster and more reliable than relying on public instances.

## Resource usage

| Container | RAM (typical) | RAM (cap) |
|---|---|---|
| invidious | 300-500MB | 768MB |
| invidious-companion | 50-150MB | 256MB |
| invidious-db (postgres) | 50-100MB | 256MB |
| **Total** | **~0.5-0.8GB** | **1.25GB** |

Disk: ~1GB for images + a small metadata DB (no media is cached, streams are proxied).

## Setup

1. Generate two random keys:

```bash
openssl rand -hex 8
```

   Run it twice. Put one value in both `invidious_companion_key` (invidious service) and `SERVER_SECRET_KEY` (companion service) - these two must be identical. Put the other in `hmac_key`.

   The companion key must be **exactly 16 characters, letters and digits only**. `openssl rand -hex 8` gives exactly that. Paste it with no quotes, no spaces around it, and save the file with Unix line endings - an invisible trailing character is still part of the key, and the companion will refuse to start.

2. Start:

```bash
docker compose up -d
```

3. Verify. Both of these must answer `200`:

```bash
INV=$(docker compose port invidious 3000)
curl -s -o /dev/null -w "search: %{http_code}\n" "http://$INV/api/v1/search?q=test"
curl -s -o /dev/null -w "video:  %{http_code}\n" "http://$INV/api/v1/videos/dQw4w9WgXcQ?local=true"
```

   The address comes from `docker compose port` rather than being written out, because the published port is not always the one inside the container - and curling a port that something else answers on reads as Invidious failing when it is fine.

   `401` on either means the companion is not running. Invidious does not say so itself - it just answers 401, so read the companion's own log:

```bash
docker compose logs --tail=20 invidious-companion
```

   `String must contain exactly 16 character(s)` together with `contains invalid characters` means the key it received is not what you see in the file. Check for a stray character:

```bash
grep -n "SERVER_SECRET_KEY" docker-compose.yml | cat -A
```

   `^M` at the end is a Windows line ending, ` $` is a trailing space. Strip them and recreate the container:

```bash
sed -i 's/\r$//; s/[[:space:]]*$//' docker-compose.yml
docker compose up -d --force-recreate invidious-companion
```

4. Open `http://SERVER_IP:3000` in a browser and search for something.

## Connect aura-music

In the app: Settings -> Invidious instances -> add `http://SERVER_IP:3000` as the first line.

Notes:
- If the app itself is served over HTTPS, the browser will block calls to a plain `http://` instance (mixed content). Either serve the app over plain HTTP on the LAN, or put the instance behind HTTPS (reverse proxy, such as Caddy or nginx).
- To use the app away from home, the instance must be reachable from outside through an HTTPS endpoint. See the [Aura server guide](../private-app/README.md).
