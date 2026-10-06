(function () {
  const V = window.Aura.player;
  // The next song prepared ahead of time: its source resolved, cached, repaired and refreshed before its turn, and the receiver's tail.
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    clearEarlyPrefetch: { get: () => clearEarlyPrefetch },
    keepPreparedSource: { get: () => keepPreparedSource },
    prepExpiring: { get: () => prepExpiring },
    prepNextSource: { get: () => prepNextSource },
    prepValid: { get: () => prepValid },
    repairPreparedSource: { get: () => repairPreparedSource },
    scheduleEarlyPrefetch: { get: () => scheduleEarlyPrefetch }
  });

  // Retry an unsuccessful initial preparation while there is still time left to fetch.
  const EARLY_PREFETCH_MS = 10000;

  let earlyPrefetchTimer = null;

  function clearEarlyPrefetch() {
    if (earlyPrefetchTimer) { clearTimeout(earlyPrefetchTimer); earlyPrefetchTimer = null; }
  }

  function scheduleEarlyPrefetch() {
    clearEarlyPrefetch();
    const generation = V.playbackGeneration;
    const startPos = V.pos;
    earlyPrefetchTimer = setTimeout(() => {
      earlyPrefetchTimer = null;
      if (generation !== V.playbackGeneration || startPos !== V.pos) return;
      if (V.xfadePrep || V.xfade || V.prepBusy || V.nearEnd()) return;
      prepNextSource();
    }, EARLY_PREFETCH_MS);
  }

  function keepPreparedSource(prep) {
    V.rememberStreamDuration(V.queue[prep.ni], prep);
    if (V.audio.isCast) {
      V.xfadePrep = prep;
      if (!V.sleepAfterTrack) {
        CastPlayback.setNext(V.queue[prep.ni], prep.src, prep.mime).then(() => prepareCastTail(prep))
          .catch(e => V.log("remote", "cast queue ahead failed: " + String((e && e.message) || e).slice(0, 60)));
      }
      return;
    }
    if (V.remotePlaybackActive()) {
      // Keep the URL ready without loading a second element off the wireless route.
      V.xfadePrep = prep;
      return;
    }
    if (V.isIOS) {
      // The permitted element restarts the prepared source itself at the transition,
      // so a standby element's buffer never reaches the listener here; loading one
      // would fetch every next song twice. Hold the source ready without an element.
      V.xfadePrep = prep;
      V.log("background", prep.id + " holding " + (prep.localKind || "stream") + " for the permitted element");
      return;
    }
    const standby = V.otherEl();
    standby.pause();
    prep.el = standby;
    V.xfadePrep = prep;
    standby.preload = "auto";
    standby.src = prep.src;
    standby.volume = V.volume;
    try { standby.load(); } catch (e) {}
    V.log("background", prep.id + " preparing " + (prep.localKind || "stream") + " for continuous playback");
  }

  async function prepareCastTail(prep) {
    // Give the TV a buffer of queued songs and artwork so screen locking does not
    // require a running page for every transition. Limit concurrent URL lookups.
    const upcoming = V.radioUpcoming();
    if (!upcoming.length || upcoming[0].id !== prep.id) return;
    const tail = upcoming.slice(1, 12);
    const valid = () => V.audio.isCast && V.xfadePrep === prep && !V.sleepAfterTrack;
    // How far into the future each queued song starts: a link that expires before then
    // (a cobalt tunnel lives about ninety seconds) would fail on the receiver with the
    // phone locked. The queue stops there; the player resolves it afresh when reached.
    let lead = ((upcoming[0] && upcoming[0].duration) || 180) * 1000;
    for (let offset = 0; offset < tail.length && valid(); offset += 3) {
      const results = await Promise.allSettled(tail.slice(offset, offset + 3).map(async track =>
        ({ track, info: await Api.resolve(track.id, V.streamOptions(track.id)) })));
      if (!valid()) return;
      const entries = [];
      for (const result of results) {
        if (result.status !== "fulfilled") break;
        const { track, info } = result.value;
        if (info && info.expiresAt && info.expiresAt < Date.now() + lead + 60000) break;
        lead += ((track && track.duration) || 180) * 1000;
        entries.push(result.value);
      }
      await CastPlayback.appendUpcoming(entries);
      // Preserve queue order if a source is unavailable. The normal player can
      // retry it when it reaches that item instead of silently dropping it here.
      if (entries.length !== results.length) return;
    }
  }

  async function repairPreparedSource(prep, error) {
    if (V.xfadePrep !== prep || prep.repairing) return;
    const rejected = V.mediaWasRejected(error, prep.el);
    const failedKind = prep.localKind;
    const revision = V.prepRevision;
    prep.repairing = true;
    prep.src = "";
    prep.el.removeAttribute("src");
    try { prep.el.load(); } catch (e) {}
    if (prep.blobUrl) URL.revokeObjectURL(prep.blobUrl);
    prep.blobUrl = null;
    V.log("background", prep.id + " preparation failed; replacing source before the next track");
    try {
      if (failedKind && rejected) {
        if (failedKind === "cache") {
          V.rejectedLocalCache.add(prep.id);
          await V.deleteCached(prep.id);
        } else {
          await V.deleteDownload(prep.id);
        }
      }
      if (V.xfadePrep !== prep || revision !== V.prepRevision) return;
      // One repair per preparation. A network failure is not proof that a saved
      // download is corrupt, but a fresh stream can still make the next transition.
      if (prep.repaired) { V.discardPrep(); return; }
      if (!failedKind) Api.invalidate(prep.id, false);
      const info = await Api.resolve(prep.id, V.streamOptions(prep.id));
      if (V.xfadePrep !== prep || revision !== V.prepRevision || !prepValid()) return;
      keepPreparedSource({ ni: prep.ni, id: prep.id, src: info.url, mime: info.mime, blobUrl: null,
        duration: info.duration, expiresAt: info.expiresAt, localKind: null, gain: V.gainFor(V.noteStreamLoudness(prep.id, info.loudnessDb)), repaired: true });
    } catch (e) {
      if (V.xfadePrep === prep && revision === V.prepRevision) V.discardPrep();
    }
  }

  // Every timeupdate in the last stretch of a song asks for the next source again; a
  // lookup that just failed waits this long before it is asked again.
  const PREP_RETRY_MS = 5000;

  let prepFailure = null;

  async function prepNextSource(targetIndex) {
    if (!V.wantsPlayback || V.prepBusy || V.preparedStart || V.xfadePrep || V.xfade || V.repeat === "one" || V.backend !== "audio") return;
    const ni = Number.isInteger(targetIndex) ? targetIndex : V.pickNextIndex();
    if (ni === -1 || !V.queue[ni]) return;
    const t = V.queue[ni];
    if (prepFailure && prepFailure.id === t.id && Date.now() - prepFailure.at < PREP_RETRY_MS) return;
    const generation = V.playbackGeneration;
    const startPos = V.pos;
    const revision = V.prepRevision;
    V.prepBusy = true;
    try {
      const downloaded = V.remotePlaybackActive() || V.localCopyBypassed(t.id) ? null : await V.getDownload(t.id);
      const cached = downloaded || V.remotePlaybackActive() ? null : await V.getCached(t.id);
      if (generation !== V.playbackGeneration || startPos !== V.pos || revision !== V.prepRevision) return;
      const localBlob = downloaded || cached;
      if (localBlob) {
        const u = URL.createObjectURL(localBlob);
        keepPreparedSource({ ni, id: t.id, src: u, blobUrl: u, localKind: downloaded ? "download" : "cache", gain: V.localGain(t.id) });
      } else {
        const info = await Api.resolve(t.id, V.streamOptions(t.id));
        if (generation !== V.playbackGeneration || startPos !== V.pos || revision !== V.prepRevision) return;
        const prep = { ni, id: t.id, src: info.url, mime: info.mime, duration: info.duration, expiresAt: info.expiresAt,
          blobUrl: null, localKind: null, gain: V.gainFor(V.noteStreamLoudness(t.id, info.loudnessDb)) };
        // Hold the resolved source before deciding how to keep it, so a track that
        // ends early can still hand off to the direct stream.
        V.rememberStreamDuration(t, prep);
        V.xfadePrep = prep;
        cachePreparedSource(prep);
      }
    } catch (e) {
      prepFailure = { id: t.id, at: Date.now() };
      V.log("play", t.id + " could not be prepared: " + String((e && e.message) || e).slice(0, 60));
    } finally {
      if (revision === V.prepRevision) V.prepBusy = false;
    }
  }

  // A stream link with an end of its own - a tunnel lasts about a minute and a half - is
  // no longer worth holding once it is about to expire.
  function prepExpiring(prep) {
    if (!prep || prep.blobUrl || !prep.expiresAt || prep.expiresAt > Date.now() + 10000) return false;
    // A standby element that already holds the whole song needs the link no longer.
    const el = prep.el;
    try {
      if (el && el.duration > 0 && el.buffered.length && el.buffered.end(el.buffered.length - 1) >= el.duration - 0.5) return false;
    } catch (e) {}
    return true;
  }

  function prepValid() {
    return !!(V.xfadePrep && V.queue[V.xfadePrep.ni] && V.queue[V.xfadePrep.ni].id === V.xfadePrep.id && V.xfadePrep.ni !== V.pos &&
      !Store.isBlocked(V.queue[V.xfadePrep.ni]) && !V.failedQueueIds.has(V.xfadePrep.id) && !prepExpiring(V.xfadePrep));
  }

  // A standby element streaming the next song leaves the transition waiting on the
  // network wherever the permitted element restarts the source itself: always on iOS,
  // and on every engine but Android's while the screen is off (there the standby itself
  // takes over, see crossfade-overlap.js). Saving the next track into the local
  // cache while this one plays turns that handoff into a read from the device, and the
  // element attach waits for the copy to settle so the same bytes are never fetched
  // twice. Whatever prevents the copy - a metered connection with Wi-Fi-only downloads,
  // being offline, an oversize track, storage trouble - falls back to the direct
  // stream, which is exactly what was kept before.
  async function cachePreparedSource(prep) {
    const revision = V.prepRevision;
    const settled = () => revision === V.prepRevision && V.xfadePrep === prep && !V.preparedStart && prepValid();
    if (V.audio.isCast || V.remotePlaybackActive() || navigator.onLine === false ||
        V.downloadsBlockedByWifi() || V.rejectedLocalCache.has(prep.id)) {
      if (settled()) keepPreparedSource(prep);
      return;
    }
    try {
      if (await V.cacheTrack(prep.id)) {
        const downloaded = await V.getDownload(prep.id);
        const blob = downloaded || await V.getCached(prep.id);
        if (!settled()) return;
        if (blob) {
          const u = URL.createObjectURL(blob);
          keepPreparedSource({ ni: prep.ni, id: prep.id, src: u, blobUrl: u, mime: prep.mime,
            duration: prep.duration, localKind: downloaded ? "download" : "cache", gain: prep.gain });
          return;
        }
      }
    } catch (e) {}
    if (settled()) keepPreparedSource(prep);
  }
})();
