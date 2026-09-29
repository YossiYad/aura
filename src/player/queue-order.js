(function () {
  const V = window.Aura.player;
  // The order the queue plays in: shuffle, the next index, the replay of the current song.
  // Published on V for the other files of this module; see src/player.js.
  Object.defineProperties(V, {
    buildShuffleOrder: { get: () => buildShuffleOrder },
    pickNextIndex: { get: () => pickNextIndex },
    replayCurrent: { get: () => replayCurrent },
    shuffleOrder: { get: () => shuffleOrder, set: value => { shuffleOrder = value; } },
    swapQueueEntry: { get: () => swapQueueEntry },
    syncShuffleOrder: { get: () => syncShuffleOrder }
  });

  // Shuffle used to draw a fresh random index on every advance, so some tracks came round
  // twice while others never played at all, and turning it off restored nothing. The order
  // is drawn once and then followed like any other running order: one pass, every track.
  let shuffleOrder = [];

  function shuffleArtistKey(id) {
    const t = V.queue.find(x => x.id === id);
    return t ? (t.artistId || String(t.artist || "").trim().toLowerCase()) : "";
  }

  // A plain shuffle happily draws the same artist twice in a row. Walk the drawn order and,
  // wherever that happens, swap in the nearest later track by someone else - leaving it be
  // only when every track left shares that same artist, since there is nothing to swap for.
  function declumpByArtist(ids) {
    for (let i = 1; i < ids.length; i++) {
      const prevKey = shuffleArtistKey(ids[i - 1]);
      if (!prevKey || shuffleArtistKey(ids[i]) !== prevKey) continue;
      let j = -1;
      for (let k = i + 1; k < ids.length; k++) {
        if (shuffleArtistKey(ids[k]) !== prevKey) { j = k; break; }
      }
      if (j === -1) continue;
      const swap = ids[i]; ids[i] = ids[j]; ids[j] = swap;
    }
    return ids;
  }

  function buildShuffleOrder() {
    const curId = V.current() ? V.current().id : null;
    const rest = V.queue.map(t => t.id).filter(id => id !== curId);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const swap = rest[i]; rest[i] = rest[j]; rest[j] = swap;
    }
    shuffleOrder = declumpByArtist((curId ? [curId] : []).concat(rest));
  }

  // Absorbs what the radio appended and what was removed, without redrawing the order.
  function syncShuffleOrder() {
    const live = new Set(V.queue.map(t => t.id));
    shuffleOrder = shuffleOrder.filter(id => live.has(id));
    for (const t of V.queue) if (shuffleOrder.indexOf(t.id) === -1) shuffleOrder.push(t.id);
  }

  // A different upload of the same song takes over the queue slot and, with it, the slot
  // in the drawn shuffle order. Leaving the order to resync would drop the old id and
  // append the new one, moving the playing track to the end of the pass so that every
  // track still waiting was skipped.
  function swapQueueEntry(i, track) {
    const old = V.queue[i];
    V.queue[i] = track;
    if (!old || old.id === track.id) return;
    const at = shuffleOrder.indexOf(old.id);
    if (at === -1) return;
    if (shuffleOrder.indexOf(track.id) === -1) shuffleOrder[at] = track.id;
    else shuffleOrder.splice(at, 1);
  }

  function playableIndexOf(id, usable) {
    for (let i = 0; i < V.queue.length; i++) {
      if (V.queue[i].id === id && i !== V.pos && !V.failedQueueIds.has(V.queue[i].id) && !Store.isBlocked(V.queue[i]) &&
          (!usable || usable(V.queue[i]))) return i;
    }
    return -1;
  }

  // usable narrows the choice further - to the songs saved on the device, with no signal.
  function pickNextIndex(usable) {
    if (V.shuffle && V.queue.length > 1) {
      if (!shuffleOrder.length) buildShuffleOrder(); else syncShuffleOrder();
      const curId = V.current() ? V.current().id : null;
      const at = curId ? shuffleOrder.indexOf(curId) : -1;
      for (let step = at + 1; step < shuffleOrder.length; step++) {
        const idx = playableIndexOf(shuffleOrder[step], usable);
        if (idx !== -1) return idx;
      }
      if (V.repeat === "all") {
        for (let step = 0; step <= at && step < shuffleOrder.length; step++) {
          const idx = playableIndexOf(shuffleOrder[step], usable);
          if (idx !== -1) return idx;
        }
      }
      return -1;
    }
    const ok = track => !V.failedQueueIds.has(track.id) && !Store.isBlocked(track) && (!usable || usable(track));
    for (let i = V.pos + 1; i < V.queue.length; i++) {
      if (ok(V.queue[i])) return i;
    }
    if (V.repeat === "all") {
      for (let i = 0; i <= V.pos; i++) {
        if (ok(V.queue[i])) return i;
      }
    }
    return -1;
  }

  function replayCurrent() {
    V.playbackGeneration++;
    V.handledEndGeneration = -1;
    V.seekTo(0);
    V.resetListenTracking(V.current());
    V.resumePlay();
  }
})();
