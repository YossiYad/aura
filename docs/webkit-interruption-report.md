# WebKit report: hidden page cannot resume after a long audio interruption

Draft for bugs.webkit.org (product WebKit, component Media). Fill in the exact
iOS build and the public URL of the test page before filing. Everything below was
measured on an iPhone running iOS 27 with the Aura player; the analysis references
WebKit trunk as of September 2026.

## Title

iOS: a hidden page's media never resumes after an audio interruption longer than
about ten seconds because the WebContent process is suspended while its media
session is interrupted

## Summary

A page playing audio in the background is interrupted by another app taking the
audio session (an Instagram reel, a phone call). If the other app releases the
session within roughly ten seconds, playback resumes by itself. If it takes
longer, nothing resumes until the page is brought back to the foreground, at
which point the interruption's end is delivered and playback continues from the
retained position. The same happens in a Safari tab and in a home-screen web app.

## Steps to reproduce

1. Open a page with a plain `<audio>` element and a long track. The test page
   sets `navigator.audioSession.type = "playback"`, logs media events and the
   Audio Session `statechange` events, and runs a one-second `setInterval` that
   records any gap longer than three seconds between ticks while hidden. It never
   calls `play()` or `pause()` after the initial tap.
2. Tap play, then switch to another app that takes the audio session exclusively
   (open an Instagram reel, or answer a call). The music pauses as expected.
3. Stay in that app for more than fifteen seconds, then leave it to the home
   screen without reopening Safari or the web app.

## Expected

Playback resumes when the interruption ends, as it does when the other app
releases the audio within about ten seconds, and as a native player does after a
call of any length.

## Actual

Nothing resumes until the page is shown again. Measured with a 45-second reel:
the page ran for 13.9 s after the interruption's pause (the tick kept its
one-second cadence, aligned to two seconds after six ticks), then ran nothing
for 31 s until the app was reopened. At the reopen the overdue tick, an
`AudioContext` `statechange` from `interrupted` to `running`, the
`navigator.audioSession` `statechange` and the resume all arrived within half a
second. Reopening always recovers; leaving the page hidden never does.

## Analysis

- `PlatformMediaSession::beginInterruption` pauses the element with
  `m_stateToRestore == Playing`, which clears `IsPlayingAudio` for the page.
- `WebPageProxy::updateThrottleState` then starts the `audibleActivityClearDelay`
  timer (10 s). `clearAudibleActivity` drops the page's only activity and
  `ProcessThrottler` moves the WebContent process to the suspended state after the
  prepare-to-suspend round trip. That matches the measured 13.9 s.
- The interruption's end is observed by `AudioSessionIOS` (the
  `AVAudioSessionInterruptionNotification` observer, in the GPU process) and
  forwarded to the WebContent process, where `PlatformMediaSessionManager::
  endInterruption` would call `mayResumePlayback(true)` on the element. With the
  process suspended the message waits in its queue until the page is shown.
- A `RunningBoard` run-time limit on the app, handled by `ProcessStateMonitor`
  fifteen seconds before expiry, would produce the same timing; the page cannot
  tell the two apart. In both cases the page has no way to keep its process
  running: it cannot render audio while interrupted, and the other background
  allowances in `WebPageProxy` (title changes, notifications, muted capture) do
  not apply to an audio player on iPhone.

## Suggested fix

Treat a page whose media session is interrupted with playback to restore like an
audible page for throttling purposes: keep the audible activity while
`PlatformMediaSessionManager` has an interrupted session with `stateToRestore ==
Playing`, or have the process that observes the interruption's end take a short
background activity for the WebContent process so `endInterruption` can run and
the element becomes audible again on its own.

## Related

- Bug 323022 covers an element left unpaused but frozen after a brief
  backgrounding on iOS 26; that is the short window before the suspension above.
- Bug 243258 (2022) reports a home-screen web app that cannot resume after a
  five-second pause, the same user-facing result without the process analysis.

## Test page

The page used for the measurements is `audio-check.html` in the Aura repository;
host it on any HTTPS origin and link it here. It uses the browser's own media
element and controls, records events and time samples, and makes no recovery
attempt of its own.
