(function () {
  const V = window.Aura.store;
  // Published on V for the other files of this module; see src/store.js.
  Object.defineProperties(V, {
    foldText: { get: () => foldText },
    matchesQuery: { get: () => matchesQuery }
  });

  // Library search was a raw toLowerCase().includes(), which misses the things Hebrew
  // catalogues are full of: niqqud on a stored title the query does not have, geresh and
  // gershayim written as ASCII quotes, and a maqaf where a hyphen is expected. It also
  // never matched title and artist together, so typing "artist song" found nothing.
  /**
   * Normalizes text for matching: case, niqqud, accents, quotes and dashes.
   * @param {*} value
   * @returns {string}
   */
  function foldText(value) {
    let out = String(value == null ? "" : value).toLowerCase();
    if (out.normalize) out = out.normalize("NFKD");
    return out
      .replace(/[\u0591-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C5\u05C7]/g, "")
      .replace(/[\u05F3\u2018\u2019']/g, "")
      .replace(/[\u05F4\u201C\u201D"]/g, "")
      .replace(/[\u05BE\u05C0\u05C3\u05C6\u2010-\u2015_\-]/g, " ")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Every word of the query has to appear somewhere in the track, in any order and across
  // both fields, so "אייל גולן ממה" and "ממה אייל" both find the same song.
  /**
   * @param {string} query
   * @param {...(string | null | undefined)} fields Searched together, as one text.
   * @returns {boolean} True when every word of the query appears somewhere in the fields.
   */
  function matchesQuery(query, ...fields) {
    const needle = foldText(query);
    if (!needle) return true;
    const hay = fields.map(foldText).join(" ");
    return needle.split(" ").every(word => hay.indexOf(word) !== -1);
  }
})();
