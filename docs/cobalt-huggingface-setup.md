# Setting up a private Cobalt server for Aura (free, no credit card) - Hugging Face Spaces

Koyeb has started asking for a credit card. **Hugging Face Spaces** is completely free, needs no credit card, and runs Docker. This is now the recommended way.

## Step 1 - Sign up

1. Go to https://huggingface.co/join
2. Sign up with an email address or GitHub. No credit card is needed.
3. Confirm your email address.

## Step 2 - Create a Space

1. Go to https://huggingface.co/new-space
2. **Space name:** `aura-cobalt` (or any name).
3. **License:** can be left empty, or mit.
4. **Select the SDK:** choose **Docker**, then **Blank** (the empty template).
5. **Hardware:** leave **CPU basic - free**.
6. **Visibility:** Public (free; Private needs extra setup).
7. Click **Create Space**.

## Step 3 - Add two files

In the new Space, open the **Files** tab → **Add file** → **Create a new file**. Create two files:

### File 1: `Dockerfile`
```
FROM ghcr.io/imputnet/cobalt:10

ENV API_PORT=7860
ENV API_LISTEN_ADDRESS=0.0.0.0

EXPOSE 7860
```

### File 2: `README.md`
```
---
title: Aura Cobalt
emoji: 🎵
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

Private Cobalt instance for Aura.
```

(Both files are ready in this repository under `deploy/cobalt-hf/`, so you can copy them from there.)

## Step 4 - Set API_URL

1. Once the files are created, the Space starts building. Wait for it to come up.
2. The Space's public URL looks like `https://<USERNAME>-aura-cobalt.hf.space`
   (shown under the **⋮** button → **Embed this Space**, or put it together yourself: user name, a hyphen, then the Space name).
3. Go to the Space's **Settings** → **Variables and secrets** → **New variable**:
   - **Name:** `API_URL`
   - **Value:** the full URL with a trailing `/`, for example `https://your-name-aura-cobalt.hf.space/`
4. **Restart** the Space (Settings → Factory reboot / Restart).

**Important:** `API_URL` must be exactly the public URL with a trailing `/`, or the tunnel will not work.

## Step 5 - Check it

Open `https://<USERNAME>-aura-cobalt.hf.space/` in a browser.
If you see JSON with `"cobalt"` and `"version"`, the server is working.

## Step 6 - Connect it to Aura

1. In Aura, open **Settings** and find the **"Your private Cobalt server"** field.
2. Paste the URL with the trailing `/`.
3. Click **Save**, play a song and open **Show logs**. You should see `[cobalt] stream OK via <your Space>`.

## Notes

- **Completely free, no card.** Enough for about 10 users.
- A free Space goes to sleep after about 48 hours without activity. The first request after it wakes is slow (about 30 seconds); after that it is fast.
- If YouTube starts blocking it after a few weeks (`youtube.login`), add YouTube cookies through an environment variable. The [cookie converter](../deploy/cobalt-hf/cookies-converter.html) turns an exported cookies.txt into the format Cobalt expects. Details: https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md

## Another option without a card: Render

https://render.com also offers a free web service without a credit card. It needs a repository containing the Dockerfile (you can split `deploy/cobalt-hf/` into its own repository and connect that). Hugging Face is simpler, which is why it is the recommended option.
