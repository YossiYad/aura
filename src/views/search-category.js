(function () {
  const V = window.Aura.views;
  // A category page opened from a Search card, and an artist opened by name.
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    categorySearch: { get: () => categorySearch },
    openArtistByName: { get: () => openArtistByName },
    renderCategory: { get: () => renderCategory }
  });

  function openArtistByName(name, thumb) {
    // Tapping an artist should open that artist. It only did when they happened to be in
    // the library; everyone else - which is most of "Your top artists", built from what
    // was listened to rather than what was saved - fell through to a search box with
    // their name typed into it.
    const artistId = Store.artistIdFor ? Store.artistIdFor(name) : null;
    if (artistId) {
      V.pushSubView({ kind: "ytArtist", id: artistId, name, thumb: thumb || "" });
      return;
    }
    if (Store.artists().some(artist => artist.name === name)) { V.pushSubView({ kind: "artist", name }); return; }
    // Falling through to a search abandons any stacked screens; their entries go with
    // them. (The ytArtist branch above pushes a fresh entry instead, so it must not
    // spend anything here - a back() and a pushState in the same tick race.)
    V.spendSubViewEntries();
    V.currentTab = "search";
    V.subView = null;
    V.subViewStack = [];
    V.subViewScrollStack = [];
    /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#tabs .bn-tab")).forEach(b => b.classList.toggle("active", b.dataset.tab === "search"));
    V.doSearch(name);
  }

  // The cards on the Search page each bring their own rows (see covers.js). A category
  // opened by anything else - a query with no card behind it - gets the general rows.
  function categorySpecs(sv) {
    const plan = V.categoryPlan(sv.query);
    if (plan) return plan.sections;
    return [
      ["Popular " + sv.title, sv.query + " popular hits"],
      ["New in " + sv.title, sv.query + " new releases"],
      [sv.title + " classics", sv.query + " classics"],
      ["Essential " + sv.title, sv.query + " essentials"]
    ];
  }

  function categoryCard(track, sectionIndex, trackIndex) {
    return V.gridCard(
      track.thumb,
      track.title,
      track.artist || "",
      'data-category-section="' + sectionIndex + '" data-category-track="' + trackIndex + '"',
      true
    );
  }

  function categorySearch(query) {
    // Search owns the per-request deadlines and tries relays after the primary APIs.
    // An outer ten-second timer discarded valid fallback results without stopping work.
    return Api.search(query, true);
  }

  // Everything the page is showing, top row first, so the button plays what is on screen
  // rather than some other idea of the category.
  function categoryTracks(sv) {
    const seen = new Set();
    const out = [];
    (sv.sections || []).forEach(section => {
      (section.tracks || []).forEach(track => {
        if (!track || !track.id || seen.has(track.id)) return;
        if (Store.isBlocked(track)) return;
        seen.add(track.id);
        out.push(track);
      });
    });
    return out;
  }

  function renderCategory(sv) {
    if (!sv.initialized) {
      sv.initialized = true;
      const plan = V.categoryPlan(sv.query);
      const keep = (plan && plan.keep) || (() => true);
      sv.sections = categorySpecs(sv).map(spec => ({ title: spec[0], query: spec[1], tracks: [], status: "loading" }));
      sv.sections.forEach(section => {
        categorySearch(section.query).then(result => {
          const seen = new Set(sv.sections.flatMap(item => item.tracks).map(track => track.id));
          section.tracks = (result.items || []).filter(track => keep(track) && !seen.has(track.id) && seen.add(track.id) && !Store.isBlocked(track)).slice(0, 10);
          section.status = "ready";
          if (V.subView === sv) V.render();
        }).catch(() => {
          section.status = "error";
          if (V.subView === sv) V.render();
        });
      });
    }

    const sections = sv.sections || [];
    const visibleSections = sections.filter(section => section.status === "loading" || section.tracks.length);
    const allDone = sections.length && sections.every(section => section.status !== "loading");
    V.view.innerHTML =
      '<section class="category-page" style="--category-color:' + V.esc(sv.color || "#477d95") + '">' +
      '<header class="category-hero"><div class="category-actions">' +
      '<button id="category-back" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>' +
      '<button id="category-share" aria-label="Share"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.5" x2="15.4" y2="6.5"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/></svg></button>' +
      '</div><div class="category-title-row"><h2 dir="auto">' + V.esc(sv.title) + '</h2>' +
      '<button class="category-play" id="category-play" aria-label="Play ' + V.esc(sv.title) + '"' +
      (categoryTracks(sv).length ? "" : " disabled") +
      '><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4.5 19.5,12 7,19.5"/></svg></button></div></header>' +
      '<div class="category-sticky" dir="auto">' + V.esc(sv.title) + '</div>' +
      '<div class="category-content">' +
      (visibleSections.length ? visibleSections.map(section => {
        const sectionIndex = sections.indexOf(section);
        return '<section class="category-section"><h3 dir="auto">' + V.esc(section.title) + '</h3>' +
          (section.status === "loading" ? '<div class="category-skeleton"><i></i><i></i><i></i></div>' :
            '<div class="category-rail">' + V.unblocked(section.tracks).map((track, trackIndex) => categoryCard(track, sectionIndex, trackIndex)).join("") + '</div>') +
          '</section>';
      }).join("") : allDone ? '<div class="category-loading"><strong>Nothing to show right now</strong><span>Check your connection and try again.</span><button class="btn ghost" id="category-retry">Try again</button></div>' : "") +
      '</div></section>';

    const playBtn = document.getElementById("category-play");
    if (playBtn) playBtn.onclick = () => {
      const all = categoryTracks(sv);
      if (!all.length) return;
      Player.setShuffle(false);
      Player.playQueue(all, 0);
    };
    document.getElementById("category-back").onclick = () => V.dismissViaHistory(V.popSubView);
    document.getElementById("category-share").onclick = async () => {
      const data = { title: sv.title + " on Aura", text: "Listen to " + sv.title + " on Aura", url: location.href };
      try {
        if (navigator.share) await navigator.share(data);
        else {
          await navigator.clipboard.writeText(location.href);
          V.toast("Link copied");
        }
      } catch (e) {}
    };
    const retry = document.getElementById("category-retry");
    if (retry) retry.onclick = () => { sv.initialized = false; sv.sections = []; V.render(); };
  }
})();
