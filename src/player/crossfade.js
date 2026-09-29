(function () {
  const V = window.Aura.player;
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    cancelCrossfade: { get: () => cancelCrossfade },
    cancelPreparedStart: { get: () => cancelPreparedStart },
    commitInterruptedPreparedStart: { get: () => commitInterruptedPreparedStart },
    commitPendingPreparedStart: { get: () => commitPendingPreparedStart },
    crossfadeSecs: { get: () => crossfadeSecs },
    discardPrep: { get: () => discardPrep },
    preparedStart: { get: () => preparedStart, set: value => { preparedStart = value; } },
    prepBusy: { get: () => prepBusy, set: value => { prepBusy = value; } },
    prepRevision: { get: () => prepRevision },
    xfade: { get: () => xfade, set: value => { xfade = value; } },
    xfadePrep: { get: () => xfadePrep, set: value => { xfadePrep = value; } }
  });

  function crossfadeSecs() {
    // Crossfading speech talks over the end of a sentence. Only songs get it.
    // iOS needs the permitted element for each song; overlapping a second
    // element can fail and discard the source prepared for the next transition.
    if (V.isIOS || V.remotePlaybackActive() || V.isSpokenWord(V.current())) return 0;
    const s = Store.settings();
    const v = s.crossfade != null ? parseInt(String(s.crossfade), 10) : 4;
    return isNaN(v) ? 0 : Math.min(12, Math.max(0, v));
  }

  let xfade = null;
  let xfadePrep = null;
  let prepBusy = false;
  let prepRevision = 0;
  let preparedStart = null;

  function discardPrep() {
    if (V.audio.isCast) CastPlayback.setNext(null);
    prepRevision++;
    prepBusy = false;
    cancelPreparedStart();
    if (xfadePrep && xfadePrep.el && xfadePrep.el !== V.audio) {
      xfadePrep.el.pause();
      xfadePrep.el.removeAttribute("src");
      try { xfadePrep.el.load(); } catch (e) {}
    }
    if (xfadePrep && xfadePrep.blobUrl) URL.revokeObjectURL(xfadePrep.blobUrl);
    xfadePrep = null;
  }

  function cancelPreparedStart() {
    if (!preparedStart) return;
    const pending = preparedStart;
    preparedStart = null;
    clearTimeout(pending.timer);
    if (pending.el) {
      pending.el.pause();
      pending.el.removeAttribute("src");
      try { pending.el.load(); } catch (e) {}
    }
    if (pending.prep && pending.prep.blobUrl) URL.revokeObjectURL(pending.prep.blobUrl);
  }

  function commitInterruptedPreparedStart(reason) {
    const pending = preparedStart;
    if (!pending || pending.el !== V.audio || !pending.prep) return false;
    preparedStart = null;
    clearTimeout(pending.timer);
    V.log("background", pending.prep.id + " prepared transition held during " + reason);
    // The active element already owns the prepared source. Commit its queue metadata now
    // so a later focus return cannot play the next song under the previous song's title.
    V.commitPreparedOnActive(pending.prep);
    return true;
  }

  // A handoff already running on an element is the current song from here on: the one
  // before it has finished. A pause, a queue edit or a further Next that lands during it
  // commits it rather than cancelling it; cancelling stripped the element and left the
  // queue on the finished song, so Play reloaded that one from the start, or nothing
  // played at all.
  function commitPendingPreparedStart(reason) {
    const pending = preparedStart;
    if (!pending || !pending.prep || !pending.el) return false;
    if (pending.el === V.audio) return commitInterruptedPreparedStart(reason);
    preparedStart = null;
    clearTimeout(pending.timer);
    const prep = pending.prep;
    V.commitTo(pending.el, prep.ni, prep.blobUrl, prep.localKind, prep.gain);
    return true;
  }

  function cancelCrossfade() {
    if (!xfade) return;
    clearInterval(xfade.timer);
    const standby = xfade.el;
    standby.pause();
    standby.removeAttribute("src");
    try { standby.load(); } catch (e) {}
    if (xfade.blobUrl) URL.revokeObjectURL(xfade.blobUrl);
    V.audio.volume = V.levelled();
    xfade = null;
  }

})();
