# Third-party notices

Aura's own code is covered by [`LICENSE`](LICENSE). This file is about everything that is
not Aura's own: code that ships in this repository, packages and images that are fetched
when a server is built, and the services the app talks to while it runs.

## Code that ships in this repository

### thinking-orbs

- **What:** the dotted-orb engine in `src/vendor/thinking-orbs.js`. It is upstream's
  `src/engine/*` and `src/presets.ts`, version 0.3.1 at commit `de85557`, with the
  TypeScript types stripped and the modules joined into one file. The `<thinking-orb>`
  element in `src/orbs.js` is Aura's own.
- **From:** <https://github.com/Jakubantalik/thinking-orbs>
- **Licence:** MIT, Copyright (c) 2026 Jakub Antalik. The full text also sits at the top
  of `src/vendor/thinking-orbs.js`, so it travels with the file.

### spotify-clone (design reference)

- **What:** no code. The colour palette and the layout numbers (sizes, corner radii,
  header and navigation heights, artwork sizes) in `tokens.css` and in the last section of
  `src/app.css` were read from that project's React Native style sheets and written again
  as CSS custom properties.
- **From:** <https://github.com/dhunanyan/spotify-clone>
- **Licence:** MIT, Copyright (c) 2024 dhunanyan

### The MIT License, which covers both of the above

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Everything else in the repository - the icons, the artwork, the styles, the tests and the
server code under `selfhost/` - was made for Aura.

## Fetched when a server is built, not stored here

The optional self-hosted services install these from their registries. None of their code
is in this repository.

| Package or image | Used by | Licence |
|---|---|---|
| [`qrcode`](https://github.com/soldair/node-qrcode) 1.5.4 | `selfhost/private-app/queue` | MIT |
| [`web-push`](https://github.com/web-push-libs/web-push) 3.x | `selfhost/private-app/push` | MPL-2.0 |
| [`nginx`](https://nginx.org/) | `selfhost/private-app` | BSD-2-Clause |
| [`oauth2-proxy`](https://github.com/oauth2-proxy/oauth2-proxy) | `selfhost/private-app` | MIT |
| [Invidious](https://github.com/iv-org/invidious) and its companion | `selfhost/invidious` | AGPL-3.0 |
| [PostgreSQL](https://www.postgresql.org/) | `selfhost/invidious` | PostgreSQL Licence |
| [Cobalt](https://github.com/imputnet/cobalt) | `deploy/cobalt-hf` | AGPL-3.0 |

The compose files and Dockerfiles reference external packages and images. Their licenses
apply separately from Aura's license. Consult each upstream project's license when
modifying, redistributing or hosting it, including any source-sharing requirements.

## Services the app talks to while it runs

Nothing from these is bundled. Requests go from the listener's own device, or from a
server the listener set up, to a service somebody else runs.

- **[Invidious](https://invidious.io/), [Piped](https://github.com/TeamPiped/Piped) and
  [Cobalt](https://github.com/imputnet/cobalt) instances** - search results and streams.
  The built-in list in `src/api.js` names public instances run by volunteers; they owe
  this app nothing, and `config.json` replaces the list with your own.
- **[SponsorBlock](https://sponsor.ajay.app/)** - the segments that *Skip intros &
  sponsors* jumps over. Uses SponsorBlock data licensed under
  [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) from
  <https://sponsor.ajay.app/>. The NC in that licence matters: the data may not be used
  commercially.
- **[LRCLIB](https://lrclib.net/)** - lyrics. They remain the work of their writers and
  publishers; the app shows what LRCLIB returns and keeps a copy only on the device.
- **Google Cast SDK** - loaded from Google when a listener casts to a television, under
  Google's own terms. It is not part of this repository.
- **Gemini and Groq** - only with a key the listener supplies, under the terms that key
  was issued on.
- **Public CORS relays** (`allorigins`, `corsproxy.io`, `codetabs`, `cors.lol`,
  `r.jina.ai`) - the fallback when a page cannot be read directly or through a relay of
  your own: a public playlist page, a channel feed, a search page, a cover image, and as
  a last resort a download the browser was refused.

YouTube, YouTube Music, Google, Spotify, Apple Music, AirPlay and the other product names
in this repository are trademarks of their owners. They are used only to say what the app
can talk to. Aura is not affiliated with, endorsed by or sponsored by any of them.
