# Phone calls and audio focus

Aura is a browser/PWA player. It has no native telephony API and cannot observe
ringing, answered, or ended call states directly. The browser/OS owns call
interruption and focus. `navigator.audioSession`, where available, supplies the
interruption state; Chrome can also pause and resume the media element natively.

- Keep playback intent when the platform interrupts a playing track. Leave native
  media suspension to the browser so its automatic resume bookkeeping survives;
  pause the YouTube fallback and cancel local crossfades.
- After a known interruption, `inactive` keeps the intent but never starts audio.
  Only `active` confirms focus return for an automatic JavaScript resume. Preserve
  that confirmation across a delayed media `pause` event.
- Allow native resume when the session already reads `active`, even if its
  `statechange` event is still queued. Without Audio Session, accept the browser's
  native media resume while retaining the user's prior playback intent.
- Retry a rejected audio resume at most twice, after 500 ms and 1.5 seconds, only
  with confirmed focus. A new interruption, explicit pause, or source change
  invalidates retries. Do not poll by calling `play()` during a call.
- Some Safari builds dispatch `statechange` with no readable `state`, so the
  branches above can never run there. Identify an interruption by adjacency
  instead: a session event beside a Media Session pause action (in either order)
  keeps the listener's intent as an unconfirmed platform pause. A pause action
  with no session event nearby commits as an explicit listener pause after the
  500 ms decision window. Never raise the interrupted flag on these builds; with
  no `active` notification ever coming it would block Play forever.
- WebKit restores an interrupted element to the last state a script asked for:
  `PlatformMediaSession::processClientWillPausePlayback` pins `stateToRestore` to
  paused while the session is interrupted. The platform has already paused the
  element when the interruption's own pause action and session event arrive, so a
  script `pause()` there changes nothing except cancelling the engine's own resume
  at the interruption's end. Pause only an element that is still running; a
  listener's lock-screen pause still commits through the decision window.
- When the focus state is unknowable (Chrome has no Audio Session; stateless
  Safari cannot report `active`), two signals stand in for focus return. The
  listener reopening the app confirms a resume attempt for a held platform pause;
  that stand-in confirmation is dropped again when the app is next hidden. On
  stateless Safari, a session event arriving more than a second after the pause
  most plausibly marks the interruption's end: attempt one resume after a 500 ms
  settle window, reclaimed if a new pause arrives inside it. If the OS still
  holds the audio (an ongoing call), these attempts are rejected and bounded;
  they are single attempts per signal, never a poll.
- A native recovery can report `paused=false` without a `play` event while the
  interruption is still held internally. On an unconfirmed focus-return signal
  or reopening the app without a readable session state, compare playback position
  across the 500 ms settle window. Advancing playback releases the old hold; a
  stationary, unpaused element gets one pause/play attempt on the same source and
  position. A newer interruption, listener pause, source change, or remote route
  cancels that attempt. Reopening recovery also cancels if the app is hidden again.
  Successive session notifications replace the pending check with the latest one.
- A `play` event after an interruption also needs position verification, even
  though it clears the focus hold. Keep a separate check for up to one second:
  advancing time confirms recovery; a stationary clock triggers one pause/play
  restart on the same source and position. Retain the check across that restart
  to prevent a retry loop, and cancel it for a new pause, focus loss, or source
  change. A stateless session notification immediately after `play` does not
  cancel verification. Reopening the app schedules a pending check again if
  background timers were frozen.
- If pause/play still does not advance time, call `load()` once on the same
  permitted element and attached source, and immediately restore `currentTime`.
  Before metadata is available this sets the native default start position.
  Give that decoder reload four seconds for actual progress. Do not resolve a
  different URL, downgrade quality, delete local audio, or skip the track for an
  interruption failure. Block generic stall recovery during these checks. If
  recovery remains blocked, retain playback intent, the source, and the position
  until the next focus-return signal or foreground/user resume. Preserve the
  checkpoint across delayed metadata so restoring a seek is not mistaken for
  resumed playback. Explicit seeks cancel the old verification.
- On iOS, keep one `AudioContext` alongside the media element as a second
  client of the same platform audio session. It renders a one-frame buffer of
  digital silence in an endless loop: iOS treats a context with nothing to
  render as idle, and an idle client may be left out of interruption
  bookkeeping entirely, so the loop keeps it a genuine session client. Whether
  a source-less context would have sufficed was never device-tested; the
  creation and reactivation log lines exist so the next device log answers
  what the context actually observed. The media
  elements are never connected to it (`createMediaElementSource` silences
  cross-origin streams permanently). It runs
  while local playback is wanted and is suspended for an explicit pause, a network
  pause, a pending permission gesture, and any cast/AirPlay route, because a
  running playback-type context holds the session active and would keep other
  apps silent. An "interrupted" context belongs to the platform and is never
  touched. Its statechange back to "running" is a real focus-return signal even
  in the background and even on a stateless Audio Session: it confirms the
  resume attempt (paused element: one platform-pause resume; unpaused frozen
  element: the settle-window check and restart). A `resume()` issued while the
  OS holds the audio is one standing request, never a poll - it stays pending
  through a call and resolves when focus returns. Recovery attempts (native
  play after interruption, pause/play restart, decoder reload, focus-return
  resumes) also request the session this way before touching the element,
  because on the failing build `play()` succeeds without an active session and
  stays silent. Chrome and Android have no such context; they resume natively.
- While an interruption holds playback and the app is hidden, tick once a second
  and report on the next signal (reopening, a session or context event, a native
  `play`, a lock-screen command) how long the page actually ran: the `hold hidden
  ... page frozen Xs from +Ys; N ticks, gaps ...` line, or `page ran throughout`
  when no gap exceeded three seconds. Hidden-page timers are aligned to one
  second and then two, so a lone long gap is a suspended process while a
  doubling series is timer throttling. WebKit keeps a page's
  web content process alive while it plays audio and releases that assertion a
  fixed interval after the audio stops (`audibleActivityClearDelay`, ten seconds
  in WebKit trunk); a suspended process runs no timer and is handed the
  interruption's end only when the app is reopened. The tick starts once the hold
  is a fact, ignores the interruption's own arrival events in its first moments,
  stops with an explicit pause, and is capped at ten minutes. It never plays.
- A pause that lands while a source is still loading (a lock-screen pause during a
  Next, or the interruption itself) makes the element reject its pending `play()`
  with `AbortError`. That is a hold, not a broken stream: the load is held for the
  pause decision and retried on the next Play, never invalidated, swapped for another
  upload or skipped.
- A load that began before the interruption, or a song tapped in the reopened app
  while a platform pause is still recorded, uses the reopening as its focus-return
  confirmation on a session whose state cannot be read. Only a session that still
  reads `interrupted` keeps such loads held.
- The audio context reporting `running` also restarts a source that was held for
  focus with nothing attached (an outage, a load the interruption caught).
- A handoff already running on the element (the next song starting) is committed,
  not cancelled, by a pause, a queue edit, a further Next or a Previous landing
  during it: cancelling stripped the element and left the queue on the finished
  song.
- The listening position is written on pause, on seek and when the app leaves the
  screen, not only by the five-second watchdog, and a prepared handoff resumes a
  podcast or long track from its saved place like a tapped one does. Songs keep a
  lighter note of where the queue stood, so the Play after a reload does not start
  a paused song from the top.
- An explicit pause cancels automatic recovery. Keep the `playback` session type,
  volume preference, native navigation ducking, and normal background transitions.
- Safari's native AirPlay output flag takes precedence over generic Remote
  Playback state when both APIs are available. A conflicting `connecting` or
  `connected` value must not turn local playback into TV mode or suppress its
  interruption checks. Other browsers continue using Remote Playback state;
  a real AirPlay output or Cast session still prevents local decoder recovery.
- Suspend the local silent audio-session helper on a confirmed wireless route.
  Native focus/play recovery must not resume it while that route remains active,
  and a pending platform resume is suspended again when it becomes running.
  Leave an interrupted context under platform control. Suspending the helper
  does not pause the music element or replace its source. A stale generic
  `connecting` state does not suppress local recovery; returning to local output
  restores the helper only while playback is still wanted.
  The reported black/silent AirPlay session cleared its black display after an
  explicit pause suspended the helper. This is evidence for isolating the helper
  from wireless playback, not proof of the receiver-side cause. Real iPhone/TV
  validation is still required.

These rules follow the [Audio Session state and media-element model](https://www.w3.org/TR/audio-session/)
and [Chromium's system suspend/resume and ducking implementation](https://github.com/chromium/chromium/blob/main/content/browser/media/session/media_session_impl.cc).
An active session is the platform's focus signal, not an independent guarantee of
telephony state. Supporting browsers and actual devices must enforce call priority.

WebKit [bug 243258](https://bugs.webkit.org/show_bug.cgi?id=243258) reports an iOS
home-screen PWA failing to resume after a five-second background pause. That older
report does not establish the cause of every newer iOS failure. In the reported
iOS 27 device logs here, native `play` and a pause/play retry both left time frozen;
re-resolving a stream only recovered after the app was reopened. Same-source reload
is a bounded recovery attempt, not a device-verified guarantee of background resume.
Because every element-level call failed identically while reopening the app always
recovered, the working hypothesis is a deactivated page audio session that
`play()` cannot reactivate from the background. The Web Audio kick context above
targets exactly that layer; its statechange transitions and the fate of its
pending `resume()` are logged as `audio context ...` entries, so device logs can
now distinguish "focus never returned to the page" from "focus returned and the
element still would not run".

The first device log with the kick context (iOS 27, Instagram reel, home-screen app
and Safari tab alike) answered that: the context reported `interrupted` with the
pause and nothing else until the app was reopened, when its pending `resume()`
resolved and one `play()` recovered playback at the retained position. Reels shorter
than a few seconds resume natively; longer ones do not resume until reopening. That
matches WebKit's process handling rather than a missing platform signal: the UI
process drops the web content process's audible assertion a fixed interval after
audio stops, the process is then suspended, and the interruption's end (delivered to
the page process by IPC from the process that owns the platform audio session) waits
in its queue until reopening resumes it. No page code runs in between, so no resume
strategy can act there. The background hold tick above records how long the page ran
after each hold so the next log can confirm the freeze and its exact interval on the
device.

Measured on that device with a 45-second reel: the page ticked for 13.9 s after the
interruption (one-second cadence, throttled to two seconds after six), then ran
nothing for 31 s until reopening, when the overdue tick, the pending context
`resume()`, one `play()` and confirmed progress all arrived within half a second.
Nothing the platform sends during a long interruption reaches a page in that state.

### Why the page cannot keep itself alive

The only thing that keeps a hidden page's process alive is audible output
(`ActivityState::IsAudible`), and during an interruption nothing in the page can
render. The one way to render again is to re-activate the platform session with a
mixable category (`navigator.audioSession.type = "ambient"` and a running
`AudioContext`), which WebKit allows from the background. That path was checked
against WebKit trunk and rejected, so it is not worth another device round:

- `AudioSession::tryToSetActive` ends WebKit's own interruption the moment a
  re-activation succeeds while interrupted (`endInterruption(MayResume::Yes)`), and
  `AudioSession::endInterruption` ignores the real end that arrives later because
  the session is "already uninterrupted". No `statechange` and no context event
  can therefore report the other app finishing. The page would stay alive with
  nothing to tell it when to resume.
- The only detector left would be polling: repeatedly asking for the exclusive
  `playback` session and treating a grant as "the other app stopped". An explicit
  session type stops WebKit from ever deactivating the session
  (`maybeDeactivateAudioSession` honours the override), and `setCategoryOverride`
  changes the category of the still-active session immediately, so each poll would
  flip a live mixable session to non-mixable from the background. Whether iOS
  refuses that or interrupts the other app is unverified, and the failure mode is
  Aura silencing the reel every few seconds. The project rule against polling for
  focus stands.
- A script `pause()` during an interruption does pin WebKit's restore state to
  paused (`processClientWillPausePlayback`), so the element itself would not start
  under a mixable session; that part is safe but does not supply a signal.

Every other way a page can hold its process open was checked against WebKit trunk
and is out of reach here. `WebPageProxy` grants a background activity to a hidden
page that changes its title, but not on iPhone (`deviceClassIsSmallScreen` skips
the whole block); to a page that requested or showed a notification, but only when
that request reaches the UI process, and iOS routes built-in web notifications to
the network process and webpushd instead; and to a page with a muted media capture,
which needs a live microphone stream. Fullscreen form controls and worker
processing hold other processes or need the foreground. Nothing an audio player
can do from the background reaches the throttler.

The freeze itself has two candidate mechanisms with the same timing: WebKit's own
ten-second audible timer followed by the prepare-to-suspend round trip, or a
RunningBoard run-time limit on the app that `ProcessStateMonitor` acts on fifteen
seconds before it expires. Both land at about fourteen seconds. Either way the fix
is WebKit's: keep the audible activity, or take a background one, while a media
session of the page is interrupted with playback to restore, so the interruption's
end can reach `mayResumePlayback`. The player no longer pins that restore state
with a script `pause()`, so the engine's own resume is armed whenever the process
is running when the end arrives. The report drafted for WebKit is in
[webkit-interruption-report.md](webkit-interruption-report.md).

What remains is outside the page: a Media Session command from the lock screen or
Control Center (the `hold hidden ... until media-session play` line will show whether
a suspended page is woken for it), reopening the app, or a WebKit change that keeps an
interrupted page's process alive or resumes its media when the interruption ends.

## Verification

Run `node --test tests/*.test.js`. Focused event-sequence regressions are in
`tests/player-audio-focus.test.js`, with background and Media Session coverage in
their existing suites. These are simulations, not physical phone-call tests.

On Android Chrome/installed PWA and iPhone Safari/installed PWA, verify:

| Scenario | Expected result |
| --- | --- |
| Incoming call; answer and remain connected | Music stops; no recovery while talking. On browsers with a readable session state, reopening Aura stays paused; where the state is unknowable, reopening makes bounded resume attempts the OS rejects while the call holds audio |
| Hang up or reject the call while Aura remains hidden/locked | Resume the same track and position only after focus returns; no double start |
| Another app takes the audio (Instagram video, voice memo) and later releases it | Playback intent survives; music resumes when focus returns, or at the latest when Aura is reopened |
| Exit an Instagram reel quickly, then repeat after 7-10 seconds and after 30 seconds | Check both background return and reopening Aura, with the same track and position retained; repeat on iPhone installed PWA and Android Chrome/installed PWA. The `hold hidden` line on reopening shows how long the page ran after the interruption: ticks stopping a fixed interval after the pause mean the process was suspended, not that a platform signal went missing |
| A second call during recovery | Hold again until the second interruption releases focus |
| Pause in Aura during the call | Remain paused after the call |
| Lock-screen pause with no interruption | Committed as an explicit pause; reopening Aura does not restart it |
| Waze voice direction during background music | OS ducking/mixing works; no forced play or volume reset |
| Screen lock, next track, network loss/recovery without a call | Existing background and network playback continue to work |

Test streaming and downloaded tracks, and the YouTube fallback where the browser
permits background iframe playback. If a device remains paused, collect Aura's
`background` / `media-session` log entries to distinguish missing platform resume
signals from a rejected playback attempt. Session and visibility entries include
the element's pause flag, internal interruption hold, playback intent, and track
position. A `play` event is logged separately from confirmed position progress;
`paused=false` alone does not prove that audible playback resumed. Progress
confirmation explicitly reports background or foreground; recovery only after
reopening the app does not pass the background-resume test.
Visibility logs include the effective route, native wireless flag, and generic
Remote Playback state so disagreements between the two APIs are visible.
