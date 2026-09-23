(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    clearPosition: { get: () => clearPosition },
    getPosition: { get: () => getPosition },
    positions: { get: () => positions, set: value => { positions = value; } },
    savePosition: { get: () => savePosition }
  });

  // Where the listener stopped in long spoken items, so a 50 minute episode does not
  // restart from zero. Songs are short enough that resuming them is just annoying.
  let positions = V.loadMap("aura.positions");

  let lastPositionNotice = 0;
  /**
   * Remembers where playback stopped. Positions under 30 seconds are dropped.
   * @param {string} id
   * @param {number} seconds
   */
  function savePosition(id, seconds) {
    if (!id || V.privateOn()) return;
    const at = Math.floor(seconds || 0);
    // Re-insert on every save so the key order is recency and the cap below evicts the
    // position that has gone longest without being touched, not the first ever stored.
    delete positions[id];
    if (at >= 30) positions[id] = at;
    const keys = Object.keys(positions);
    if (keys.length > 200) delete positions[keys[0]];
    V.save("aura.positions", positions);
    // Positions were never announced, so they only ever rode along with another change
    // and were replaced wholesale by the next copy adopted from another device. One
    // notice a minute lets sync carry them without a push every five seconds.
    if (Date.now() - lastPositionNotice > 60000) {
      lastPositionNotice = Date.now();
      V.notify("positions");
    }
  }

  /**
   * @param {string} id
   * @returns {number} Seconds, or 0.
   */
  function getPosition(id) { return positions[id] || 0; }

  /**
   * @param {string} id
   */
  function clearPosition(id) {
    if (!positions[id]) return;
    delete positions[id];
    V.save("aura.positions", positions);
  }
})();
