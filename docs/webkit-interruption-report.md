# WebKit report: background audio never resumes after an interruption longer than about five seconds

Text for bugs.webkit.org (product WebKit, component Media). Fill in the two
bracketed blanks (exact iOS build, device model) and the public URL of the test
page before filing. Everything below was measured on an iPhone running iOS 27
with the Aura player between 2026-09-16 and 2026-09-28; the analysis references
WebKit trunk as of 2026-09-28.

---

Title: iOS: a page playing audio in the background never resumes after an
audio interruption longer than about five seconds; the interruption's end
resumes the element on paper only, and the page process is suspended ten seconds
after the pause

Summary

A page is playing audio in the background (Safari tab or home-screen web app,
navigator.audioSession.type = "playback"). Another app takes the audio session:
an Instagram reel, a phone call. If the other app releases the session within
about five seconds, playback resumes by itself. If it takes longer, nothing
audible resumes until the page is brought to the foreground, whatever the page
does. Two distinct mechanisms produce the same result, split at the ten second
mark:

1. Between about five and ten seconds the WebContent process is still running
   and receives the interruption's end. The media element fires play and
   playing, paused reads false, and currentTime never advances. A script
   pause()/play() and a load() with currentTime restored change nothing. A
   running AudioContext's currentTime is frozen too. The moment the page is
   shown, one play() progresses within 300 ms.
2. From about ten seconds on, the UI process drops the page's audible activity
   (audibleActivityClearDelay) and the WebContent process is suspended. The
   interruption's end is delivered only when the page is shown again, and
   playback then resumes at once.

Steps to reproduce

1. Load a page with a plain <audio> element and a long track, set
   navigator.audioSession.type = "playback", tap play, and let the track buffer
   fully (the measurements below were taken with the whole file buffered, so
   network conditions play no part).
2. Switch to another app that takes the audio session exclusively (open an
   Instagram reel, or receive a call). The music pauses as expected.
3. Leave the other app after 6 to 9 seconds without showing Safari or the web
   app (case 1), or after 15 seconds or more (case 2).

Expected

Playback resumes when the interruption ends, as it does when the other app
releases the audio within about five seconds, and as a native player does after
a call of any length.

Actual

Case 1, measured with a 6.6 second reel (device time, the page hidden
throughout until the last two lines; "ctx" is a running AudioContext looping a
one-frame silent buffer, created inside the original play gesture):

    +0.0 s  audio session statechange; element pause event (paused = true)
            element: readyState 4, networkState 1, buffered to 799.65 s
            AudioContext statechange: interrupted, currentTime 18.83 s
    +6.6 s  audio session statechange (interruption ended)
            element play event, then playing event 5 ms later, paused = false
            AudioContext statechange: running, currentTime still 18.83 s
    +7.6 s  currentTime unchanged (135.25 s). Script pause(); play():
            play and playing events again, clock unchanged
    +8.6 s  Script load() on the same URL, currentTime restored:
            readyState 0 then 1 (metadata, duration 799.6 s), then stalled,
            never HAVE_CURRENT_DATA in four seconds
    +12.6 s page gives up: pause(), source and position kept
    +16.9 s page shown; play(): play, playing, currentTime advancing
            within 500 ms; AudioContext currentTime still 18.83 s

The page's own one-second timer ticked throughout with no gap, so the process
was never suspended in this case. The same happened with an 8.0 second reel.
Nothing in the page can tell this state from real playback except comparing
currentTime across a timer: no waiting, stalled, pause or error event fires
after the playing event.

Case 2, measured with a 45 second reel: the one-second timer ticked for 13.9 s
after the pause (aligned to two seconds after six ticks), then nothing ran for
31 s until the app was reopened, when the overdue tick, the AudioContext
statechange to running, the audio session statechange and the resume all
arrived within half a second.

Analysis

Case 1 (the element resumes on paper only):

- AudioSessionIOS.mm observes AVAudioSessionInterruptionNotification and, for
  AVAudioSessionInterruptionTypeEnded, only forwards
  AudioSession::endInterruption(MayResume). PlatformMediaSession::
  endInterruption restores State::Playing and HTMLMediaElement::
  mayResumePlayback(true) calls play(), which is where the play and playing
  events come from.
- Nothing on that path calls -[AVAudioSession setActive:YES] again. In
  startSessionAdmission the activation is skipped because
  AudioSession::isActive() still reads true, and on the GPU process side
  RemoteAudioSessionProxyManager::tryToSetActiveForProcess returns a resolved
  promise without touching AVAudioSession whenever its proxy is already active
  and no longer interrupted. The page cannot request an activation either: a
  deactivation first requires maybeDeactivateAudioSession, which returns early
  while a session type is declared, while an interruption is in progress, and
  unless the process has no media session left (removeSession checks
  hasNoSession()), and MediaSessionManageriOS::sessionWillEndPlayback skips it
  in the background altogether.
- The AVFoundation player and the Web Audio destination both stop rendering
  (frozen media clock with the whole file buffered, frozen AudioContext clock
  in the running state). Bringing the app to the foreground restores the media
  element without any activation call from the page, so the missing piece is
  whatever a foreground transition supplies to the platform session, and iOS
  appears to withdraw it a few seconds after the app's session stops rendering
  in the background. The window matches bug 323022, whose reporter saw the
  same unpaused, frozen element after 5 to 9 seconds away from the page.
- The AudioContext never renders again even in the foreground (currentTime
  stays at 18.83 s while its state reads running), which looks like a separate
  defect in restarting the Web Audio destination after a system interruption.

Case 2 (the process is suspended):

- PlatformMediaSession::beginInterruption pauses the element with
  m_stateToRestore == Playing, which clears IsPlayingAudio for the page.
- WebPageProxy::updateThrottleState then starts the audibleActivityClearDelay
  timer (10_s). clearAudibleActivity drops the page's only activity,
  ProcessThrottler sends PrepareToSuspend, WebProcess::prepareToSuspend runs
  processWillSuspend on every page, and the process is suspended. That matches
  the measured 13.9 s.
- The interruption's end is observed in the GPU process and forwarded to the
  WebContent process, where PlatformMediaSessionManager::endInterruption would
  call mayResumePlayback(true). With the process suspended the message waits
  in its queue until the page is shown. The page has no way to keep its
  process running: it cannot render audio while interrupted (a silent
  AudioContext is not IsPlayingAudio, see DefaultAudioDestinationNode::
  setIsSilent), and the other background allowances in WebPageProxy (title
  changes, notifications, muted capture) do not apply to an audio player on
  iPhone.

Suggested fixes

1. When AudioSessionIOS receives AVAudioSessionInterruptionTypeEnded with
   AVAudioSessionInterruptionOptionShouldResume, re-activate the session
   (setActive:YES) before the media sessions are told they may resume, as the
   AVAudioSession documentation asks of an interrupted app, and restart the Web
   Audio destination rather than only flipping the context state to running.
2. Treat a page whose media session is interrupted with playback to restore
   like an audible page for throttling purposes: keep the audible activity
   while PlatformMediaSessionManager has an interrupted session with
   stateToRestore == Playing, or have the process that observes the
   interruption's end take a short background activity for the WebContent
   process so endInterruption can run and the element becomes audible again on
   its own.

Related

- Bug 323022: media element left unpaused but frozen after 5 to 9 seconds of
  backgrounding on iOS 26; the same element state as case 1 here, reached
  through an audio interruption and with type = "playback" already set.
- Bug 243258 (2022): a home-screen web app that cannot resume after a
  five-second pause, the same user-facing result without the process analysis.

Test page

audio-check.html in the Aura repository: a plain <audio> element with native
controls that logs media events, Audio Session statechange events, time samples
and gaps longer than three seconds between hidden one-second ticks, and makes no
recovery attempt of its own. Hosted at: [URL]

Environment

iPhone [model], iOS [exact build], Safari tab and home-screen web app alike.
Interrupting apps: Instagram reels (both cases), phone calls (case 2).
