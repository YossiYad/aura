# Setting up a private Cobalt server for Aura (free, on Koyeb)

This guide sets up your own private audio extraction server, so Aura plays without ads and in the background even when the public servers are blocked. It is completely free and easily handles 10 users.

> Koyeb has started asking for a credit card. To avoid that, use [Hugging Face Spaces](cobalt-huggingface-setup.md) instead.

## Why you need it

YouTube sometimes blocks all the public extraction servers (Piped / Invidious / Cobalt) at once. A private server with a clean IP address and little traffic is almost never blocked. Aura tries it first, and falls back to the public ones only if it fails.

## Step 1 - Sign up for Koyeb

1. Go to https://www.koyeb.com
2. Click **Sign up** and sign in with GitHub or Google.

## Step 2 - Create the service

1. In the dashboard, click **Create Service** (or **Create Web Service**).
2. For the source, choose **Docker**.
3. In the image field, paste:
   ```
   ghcr.io/imputnet/cobalt:10
   ```
4. **Ports / Exposing:** make sure the port is **9000** (Cobalt's default). If there is a health check path field, leave it as `/`.
5. **Instance type:** choose the free plan (**Free** / **Eco** / nano - the smallest one).
6. **Region:** choose the one closest to you (Frankfurt / Washington).

## Step 3 - Environment variables

Add these variables (Add variable):

| Key | Value |
|-----|-------|
| `API_URL` | `https://<APP-NAME>-<ORG>.koyeb.app/` |
| `API_PORT` | `9000` |

- You only know `API_URL` once the service has been created and given a URL. You can:
  1. Create it first with a temporary value, see which URL you got, then change `API_URL` to the right value and redeploy. `API_URL` **must** be exactly the service's public URL with a trailing `/`, or the tunnel will not work.

## Step 4 - Deploy

1. Click **Deploy**.
2. Wait 1-3 minutes until the status is **Healthy** (green).
3. Open the URL you got in a browser (for example `https://your-app-your-org.koyeb.app/`). If you see JSON with `"cobalt"` and `"version"`, the server is working.

## Step 5 - Connect it to Aura

1. Open Aura and go to **Settings** (the gear icon).
2. In the **"Your private Cobalt server"** field, paste the full URL (with the trailing `/`):
   ```
   https://your-app-your-org.koyeb.app/
   ```
3. Click **Save**.
4. Play a song and open **Show logs**. You should see `[cobalt] stream OK via <your server>`, and the song should be playing from it.

## If YouTube blocks your server (rare)

If `youtube.login` errors start appearing after a few weeks:

1. In Koyeb, edit the service and add a `COOKIE_PATH` environment variable pointing to a YouTube cookies file (exported with the "Get cookies.txt" extension). That gets the server working again.
2. Full details: https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md

## Cost

$0. Koyeb's free plan is enough for 10 users. The service may go to sleep after a long period without activity; the first request after that is slow (about 30 seconds), and after that it is fast.
