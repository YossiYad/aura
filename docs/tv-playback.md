# Playing on a TV

Open the full player, tap **⋯**, then **Connect to TV**. If the app asks for another tap after
preparation, tap again to open the device chooser. The chooser requires a direct tap;
opening it after a network request can be blocked by the browser.

- **iPhone / iPad:** use Safari or the installed web app and choose an AirPlay receiver,
  from the menu or from the AirPlay control in Control Center. The phone stays the player
  and streams its sound to the receiver, the way a music app does. Aura sets
  `x-webkit-airplay="deny"` there, which turns off only AirPlay's video mode. In that mode
  the TV downloaded the stream itself: it showed the container's own length (YouTube's
  fragmented m4a reads as double) and the phone's volume buttons did not reach it. On the
  audio route the TV shows the Media Session title, artwork and corrected timeline, the
  volume buttons control the receiver, and saved downloads and crossfade keep working
  because the page sees ordinary local playback. The menu opens the system chooser in
  the same tap and prepares nothing. The receiver-stream sections below (handoff,
  source-change grace period, media tickets) now apply to Safari on a Mac and to Cast.
- **Android / desktop Chrome:** the menu opens the Cast device chooser where supported.
  The menu loads the sender on demand. Ordinary phone playback does not initialize Cast
  or prepare TV streams. Only an explicit connection request or an actual native route
  triggers TV preparation; closing a chooser does not leave future tracks in TV mode. The Default Media Receiver displays the track title,
  artist, album and cover. If the SDK is unavailable, the app tries the browser's native
  Remote Playback picker. Native support varies by browser and receiver.
- The phone and TV need a network on which they can discover each other. Both media and
  cover URLs must be reachable by the receiver. Saved downloads stay on the phone;
  casting resolves an online stream for the same track.

While connected, the app uses a single playback target and disables crossfading.
A native AirPlay/Remote Playback handoff keeps an existing HTTP source and its
listening position. Opening the native picker does not pause or replace that source.
Device-local blobs and pending local source lookups still resolve a receiver-compatible
stream; new receiver stream requests prefer AAC/MP3. A temporary handoff pause gets
one resume attempt, then one reattachment of the same source if playback has not
advanced. An explicit pause or known audio-focus interruption cancels recovery.
Receiver errors or persistent stalls hold the current song and show a message;
they do not repeatedly reconnect the TV or skip through the queue. Pressing Play
explicitly can request a fresh receiver stream. No iframe fallback takes playback
away from the TV.

When changing songs on an established AirPlay route, Safari can briefly report
local output while the receiver loads the new source. Aura keeps the same element
in receiver mode for up to nine seconds, so this transient signal cannot restart
the local audio helper or prepare device-local blobs. A confirmed return or playback
progress on the wireless route ends the wait. Otherwise the actual route is
reconciled, including after a frozen page returns. Pause remains effective during
the transition, and a disconnect during established playback is handled immediately.

Safari requests a receiver-compatible format from the first online stream, including
prefetch, new cached downloads and later songs. This keeps playback on a native AirPlay-capable decoder even
when the route is picked from Control Center after the app is backgrounded or reopened.
It does not open a device chooser, initialize Cast or select a wireless output. Other
browsers retain their normal local codec selection until a receiver is requested.
Format selection uses the existing resolver request and shares its cached result with
the later connection and download. It adds no deliberate wait or separate format probe.
WebKit's WebM engine [does not support wireless playback](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/graphics/cocoa/MediaPlayerPrivateWebM.mm),
and its [media-element compatibility check](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/html/HTMLMediaElement.cpp)
runs 500 ms after the wireless-target change. Local decoding support alone is therefore
not sufficient for selecting the source on Safari.

Cast sends music metadata and public cover URLs with every loaded or queued track.
The sender mirrors the receiver's play/pause state and position and supports seeking,
volume and track changes. It prepares up to twelve upcoming songs on the receiver in
queue order, including their artwork, so those transitions can happen while the page
is suspended. Continuing beyond that prepared buffer, refilling radio, and refreshing
expired stream URLs still require the sender to run and have network access.

Changing the queue replaces the upcoming receiver items. Stop-after-track removes them.
On Cast disconnect, the phone stays paused. Press Play to continue the selected track
locally from the last reported position. Cast playback runs at normal speed; the
listener's saved local playback speed is retained for return to the phone.

AirPlay receives updated Media Session metadata with a public image rather than the
local cropped blob used for offline lock-screen artwork. The receiving TV and Safari
control which artwork, text and controls are displayed; the website cannot replace
the AirPlay receiver's interface. Receiver layouts and acoustic output require tests
on real hardware.

## Private server media access

A receiver fetches the audio URL itself and does not have the phone's Google login
cookie. Passing a private `/videoplayback` URL to it returns a 403 login page. The
private deployment now issues a signed URL for each same-origin Invidious stream,
including the initial local stream so AirPlay from Control Center can keep that URL.

`POST /api/media/ticket` requires the existing login, a same-origin request and JSON.
It signs only a `/videoplayback` URL on this server. The separate public listener at
`/media/play` accepts GET and HEAD with a valid ticket, plus OPTIONS for receiver CORS.
Tickets expire after at most six hours, or at the source's expiry if sooner. They allow
only that exact stream; app pages, library/sync APIs, the original media routes and
ticket creation still require login. Byte ranges and HEAD work without receiver cookies.
Do not share ticket URLs: anyone holding one can play that song until it expires.

The playback URL carries a short, signed random ID. Its stream and expiry live in
the media service's private ticket directory. Previously, embedding the complete
upstream URL made these links about 2.9 KB long. A Samsung Q80BA receiver was
observed sending shorter requests with incomplete tickets, receiving repeated 403
responses while the iPhone could still fetch the same media. Compact links avoid
that truncation without changing audio playback or relaxing signature validation.
Existing self-contained links remain accepted until their original expiry.

The `aura-media` container stores its signing key in the `aura-media-data` volume, so
routine restarts preserve current tickets. The same volume stores compact ticket
records with private file permissions; records older than the maximum lifetime are
cleaned up periodically when issuing new tickets. Removing that volume revokes all tickets.
`setup.sh` enables the client with `mediaTickets: "/api/media/ticket"` in the private
`config.json`; other deployments and public stream sources retain their existing URLs.
Tickets bypass service-worker caching and public CORS relays, and both proxies exclude
the public media path from access logs. They do not expose a generic destination proxy
or follow upstream redirects to other services.

## Custom TV display

`tv/index.html` is the custom Google Cast Web Receiver. It uses a spacious plum
background, lower-screen artwork and title, elapsed/remaining time, playback and queue
controls, and dark mode. It responds to receiver metadata, state, position and queue
events; it can continue to display and control the queued media while the phone sleeps.
Keyboard/D-pad navigation, OK/Enter activation and visible focus are supported when
the receiver delivers those keys to the page. Left/right adjust the seek slider; up/down
leave it. Back closes the queue. Android TV may translate its remote into Cast media
commands instead of delivering raw navigation keys; those media commands are handled by
the Cast SDK. Arbitrary button navigation must be checked on the target TV and may
require a native TV app. Home, Search and Library
remain on the sender; the receiver does not expose personal library data.

To activate it:

1. Publish the `tv/` directory with the site over HTTPS.
2. In the [Google Cast Developer Console](https://cast.google.com/publish), register
   a **Custom Web Receiver** with the URL `https://YOUR_HOST/YOUR_APP_PATH/tv/index.html`.
   For this repository’s GitHub Pages hosting the URL is
   `https://yossiyad.github.io/aura-music/tv/index.html`.
3. Put the assigned eight-character application ID in the host’s `config.json` under
   `"castReceiverAppId"`. See `config.example.json`. This identifier is public, not a secret.
4. Register test receivers while the Cast app is unpublished, then publish the receiver
   for general use. Disconnect any existing Cast session before trying the new receiver.

For a login-protected deployment, host the receiver and its `../icon.svg` on a public
HTTPS site such as GitHub Pages. Cast cannot complete the private app’s login. The
private deployment keeps all existing authentication requirements.

Until a valid ID is configured, casting keeps using Google’s Default Media Receiver;
the custom layout is **not activated by publishing the website alone**. Native browser
Remote Playback and AirPlay do not launch this custom Cast receiver.

## Controls outside the app

Media Session supplies track information, play/pause, previous/next and seeking to
supported lock-screen and system media controls. AirPlay output selection belongs to
Safari/iOS; its route events and resume reconciliation do not require tapping Aura’s menu.
The TV/Apple TV chooses the AirPlay interface, so a website cannot apply this custom TV
layout to AirPlay audio.

Android’s system **output switcher** integration for choosing Cast devices requires a
native Android sender using the Cast SDK, MediaSession and MediaRouter. This repository
is a static website/PWA and contains no native Android app. A PWA manifest or Web Media
Session handler cannot register those native routes. The implementation here therefore
does **not** add Aura Cast devices to Android’s system output switcher. Browser Remote
Playback support varies, and system screen/audio mirroring is separate from sending media
to this custom receiver. Supporting the native Android flow requires a native app project
and device testing; it cannot be enabled by this website update.

## Validation

Automated coverage includes source handoff, downloaded/cached sources, metadata and
image URLs, native route events, Cast SDK requests and receiver queue transitions,
position restoration, pause/seek/volume, late asynchronous work, source failures,
phone audio-focus interruptions, and small-screen controls.

Run `node --test tests/*.test.js`. With Playwright and Chromium available, run
`node tests/remote-playback-ui.cjs` and `node tests/tv-receiver-ui.cjs`; set
`AURA_CHROMIUM` if needed. The receiver check uses a mocked Cast SDK at 720p, 1080p and 4K;
it verifies layout, metadata changes, controls, queue, idle and error states.

With Podman and the deployment's nginx and oauth2-proxy images available, run
`node tests/media-stack.cjs` and `node tests/shared-queue-gateway.cjs` to check the real
gateway, signed media, byte ranges, HEAD, and refusal of unsigned/private requests.

Before release, check Safari on an iPhone with an AirPlay TV and Chrome on Android with
a Cast receiver. For each, connect during a downloaded song, verify audible sound and
artwork, skip forward/back, allow several automatic transitions with the screen locked,
pause/resume from both devices, seek, change volume, and disconnect/reconnect. Include
an unavailable stream and a temporary network interruption. Browser mocks cannot verify
actual TV codec support, network access, display layout or sound.

## Platform references

- [WebKit: AirPlay media URLs](https://webkit.org/blog/15036/how-to-use-media-source-extensions-with-airplay/)
- [Apple: AirPlay picker and route events](https://developer.apple.com/documentation/webkitjs/adding_an_airplay_button_to_your_safari_media_controls)
- [W3C: Remote Playback API](https://www.w3.org/TR/remote-playback/)
- [Google: Cast sender integration and Default Media Receiver](https://developers.google.com/cast/docs/web_sender/integrate)
- [Google: music metadata](https://developers.google.com/cast/docs/reference/web_sender/chrome.cast.media.MusicTrackMediaMetadata)

- [Google: custom receiver UI](https://developers.google.com/cast/docs/web_receiver/customize_ui)
- [Google: native Android output switcher](https://developers.google.com/cast/docs/android_sender/output_switcher)
