# AI providers for Ask AI and Create with AI

The AI features (the Ask AI tab, "Playlist with AI" under Create, and the "Picked for you today" row on Home) call the AI provider you set up directly from the browser, without going through a self-hosted server. Keys are stored only on the device: they are not synced and are not included in backups. The one exception is **Settings → Daily prep → Let the server use my key**, which stores a key on your own self-hosted server so it can build the nightly mix.

## Gemini (Google)

- Free key: https://aistudio.google.com/apikey
- The default is the pinned `gemini-2.5-flash`, which is stable and predictable. Google has announced that it will be retired starting October 16, 2026. When that happens, requests answered with 404 automatically continue to `gemini-flash-latest` (the rolling alias), so the app keeps working without an update.
- If the main model answers with a 5xx error (overload), it is retried once and then handed straight to the fallback. A model entered by hand in the Model field is never replaced.

**⚠️ Known network blocking issue (not caused by the code):** Extensive testing (home network, mobile data, VPN, several mobile carriers, a VPN exit point on and off, new keys) showed that on some networks in Israel, requests to `generativelanguage.googleapis.com` hang completely (a full timeout, not a quick error), while the very same key answers instantly from another network. The key and Gemini itself are fine; this is most likely a routing or DNS problem specific to that network path, and it cannot be fixed from the app. **That is why setting up a Groq key as well is recommended.** With "Both" (the default in Settings), a request always tries Gemini first and falls back to Groq only if it does not answer, so nothing needs to change if the blocking is ever resolved.

## Testing a key (Test)

In Settings → AI playlists, every saved key has a **Test** button. It follows the same path a real request takes, step by step, and reports each step as soon as it finishes:

1. **The device is online:** `navigator.onLine`.
2. **The provider's server is reachable:** a `no-cors` request to the provider's server *and, at the same time,* to the other provider's server. The second one is the control: "Gemini is unreachable" on its own could also mean a dead connection, and only the comparison tells the two apart.
3. **The key is accepted:** fetching the model list with the key itself (400/401/403 = invalid key, 429 = quota).
4. **The model is available to the key:** whether the model set in the Model field is actually in the list. A perfectly valid key can return 404 for a particular model, and this step tells the two apart.
5. **A real request comes back:** a small `generateContent` call on the normal path, including the response time.

At the end, a one-line conclusion points to the step that failed. The combination "the server is reachable and the list comes back, but the real request fails" is the signature of a network that filters the path instead of blocking it: a small request gets through, and a large one is silently dropped.

## Groq

- Free key (no credit card): https://console.groq.com/keys
- The default is `openai/gpt-oss-120b`. **Note:** `llama-3.3-70b-versatile` (a model name common in Groq's examples) is Enterprise-tier only and returns 404 on a free account; this was checked directly against the API.
- Quality: a good open-weight model, but less precise than Gemini on tasks with complex instructions (for example working out "how many songs are needed for X minutes", or telling a song from other content). The app makes up for this in code:
  - Every match goes through `Api.looksLikeMusic()` to filter out results that are not actually songs.
  - An "X-minute playlist" request that falls well short of the target after matching gets one automatic top-up round.
- **Cerebras** (runs exactly the same `gpt-oss-120b`, faster but not "smarter") and **OpenRouter** (its truly free tier is limited to 50 requests a day without buying credit, and its list of free models changes often) were also tested. Neither was a clear enough quality upgrade to justify a third provider for now.

## Transcribing voice requests on iPhone

On iPhone and iPad, Safari's speech recognition heard only the first voice request after the app opened; every recognition after it reported that the microphone had opened and received no sound at all. The page's own microphone, opened the usual way (with voice processing), also delivered no sound after music had played, until a microphone without voice processing had been opened first. So from the second request on, the app opens the microphone without voice processing first, and with it when the first one records only silence, and records the request. As soon as the microphone delivers sound, the built-in speech recognition listens alongside it: the words appear while you speak, as on the first request, and the recording is not sent anywhere. The request ends after about a second and a half of silence, or two seconds without new words. Only when speech recognition heard nothing is the recording sent to the provider in Settings for transcription:

- **Groq first:** `whisper-large-v3-turbo`, which is built for exactly this and answers in about a second. Groq goes first even when the provider is set to Both, because the route to Gemini hangs on some networks (see above) and a voice request cannot wait for a timeout.
- **Gemini** as the fallback, from the same recording. Choosing a single provider in Settings applies to transcription too.
- A recording in which no voice was detected is never sent: given background noise alone, a transcriber makes up words.
- Without a Groq or Gemini key, a request that speech recognition did not hear ends with a note under the orb saying that a key is missing.

The recording is sent to the provider directly from the device and is not saved by the app. On Android, the browser's speech recognition works on every request, and no recording is sent.

## Choosing a provider

Settings → AI playlists → **Provider**: Gemini only / Groq only / Both (automatic fallback, the default).
