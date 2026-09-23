---
title: Aura Cobalt
emoji: 🎵
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# Aura Cobalt

Private Cobalt audio-extraction instance for the Aura music app.

This Space runs the official `ghcr.io/imputnet/cobalt:10` image so Aura can
play ad-free and in the background even when public instances are blocked.

After the Space is running, set the environment variable **`API_URL`** (in the
Space Settings → Variables) to this Space's public URL with a trailing slash,
e.g. `https://your-name-aura-cobalt.hf.space/`, then restart the Space.
