(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    fillHomeDownloaded: { get: () => fillHomeDownloaded },
    followCard: { get: () => followCard },
    homeDownloads: { get: () => homeDownloads },
    renderHome: { get: () => renderHome }
  });

  // ---------------- Following ----------------

  function followCard(f) {
    const isNew = Store.hasNewFollow(f.id);
    // The dot sits outside .card-art on purpose: that box clips to a circle for an avatar,
    // and a corner badge inside a circular mask is exactly the part that gets cut off.
    return '<button class="card follow-card" data-ytartist="' + V.esc(f.id) + '" data-ytname="' + V.esc(f.name) + '" data-ytthumb="' + V.esc(f.thumb) + '">' +
      '<div class="card-art">' + (f.thumb ? '<img decoding="async" src="' + V.esc(f.thumb) + '" loading="lazy" alt="" />' : '<div class="image-missing"></div>') + '</div>' +
      (isNew ? '<span class="follow-new-dot" aria-label="New"></span>' : '') +
      '<div class="card-title" dir="auto">' + V.esc(f.name) + '</div>' +
      '<div class="card-sub">' + (f.kind === "podcast" ? "Podcast" : "Artist") + (isNew ? " · New" : "") + '</div></button>';
  }

  function followingHtml() {
    const list = Store.followsList();
    if (!list.length) return "";
    return '<div class="home-section"><div class="section-head"><h3>Following</h3></div>' +
      '<div class="rail artists home-artists">' + list.map(followCard).join("") + '</div></div>';
  }

  // Foreground freshness check: a followed channel is worth re-asking about only once its
  // last answer is old enough, so opening Home a dozen times a day does not turn into a
  // dozen rounds of Invidious lookups for the same handful of artists.
  const FOLLOWS_CHECK_TTL = 30 * 60 * 1000;
  let followsChecking = false;

  function notifyNewRelease(f, item) {
    const title = f.kind === "podcast" ? "New episode from " + f.name : "New from " + f.name;
    const body = item.title || "New release";
    V.toast(title + ": " + body);
    if (window.Push && Push.notifyLocal) Push.notifyLocal(title, body, { tag: "follow-" + f.id, artistId: f.id });
  }

  async function checkFollowsForNew() {
    if (followsChecking) return;
    const stale = Store.followsList().filter(f => Date.now() - (f.checkedAt || 0) > FOLLOWS_CHECK_TTL);
    if (!stale.length) return;
    followsChecking = true;
    try {
      for (const f of stale.slice(0, 6)) {
        try {
          const data = await Api.getArtist(f.id, { name: f.name, thumb: f.thumb });
          const latest = (data.videos || [])[0];
          if (!latest) continue;
          const isNew = Store.refreshFollowLatest(f.id, latest.id);
          if (isNew && Store.settings().notifyNewReleases !== false) notifyNewRelease(f, latest);
        } catch (e) {}
      }
    } finally {
      followsChecking = false;
      if (V.currentTab === "home" && !V.subView) {
        const holder = document.getElementById("home-following");
        if (holder) V.paint(holder, followingHtml());
      }
    }
  }

  const homeDownloads = { items: [], loaded: false };

  function homeDownloadedHtml() {
    const items = homeDownloads.items;
    if (!items.length) return "";
    return '<div class="home-section"><div class="section-head"><h3>Downloaded</h3>' +
      '<button class="section-play" id="downloaded-play" aria-label="Play downloaded songs">' +
      '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4.5 19.5,12 7,19.5"/></svg></button></div>' +
      '<div class="rail">' +
      items.slice(0, 12).map(t => V.gridCard(V.artSrc(t), t.title, t.artist || "", 'data-downloaded="' + V.esc(t.id) + '"', true)).join("") +
      '</div></div>';
  }

  function wireHomeDownloaded() {
    const play = document.getElementById("downloaded-play");
    if (play) play.onclick = () => {
      if (!homeDownloads.items.length) return;
      Player.setShuffle(false);
      Player.playQueue(homeDownloads.items.slice(), 0);
    };
  }

  async function fillHomeDownloaded() {
    const ids = await Player.downloadedIds();
    const items = V.offlineCandidates().filter(t => ids.has(t.id));
    const sameAsBefore = items.length === homeDownloads.items.length &&
      items.every((t, i) => t.id === homeDownloads.items[i].id);
    homeDownloads.items = items;
    homeDownloads.loaded = true;
    const holder = document.getElementById("home-downloaded");
    if (V.subView && V.subView.kind === "downloaded" && !sameAsBefore) V.render();
    if (!holder) return;
    if (!sameAsBefore || !holder.innerHTML) V.paint(holder, homeDownloadedHtml());
    wireHomeDownloaded();
    // The pinned tile is drawn with the rest of the page, before this list is known, so
    // the first paint after downloads appear - or after the last one is deleted - has to
    // redraw it. The next pass finds them in step and stops.
    const tileShown = !!document.querySelector('[data-quick="downloaded"]');
    if (tileShown !== items.length > 0) {
      V.view.__painted = null;
      V.render();
    }
  }

  function renderHome() {
    const library = Store.library();
    const playlists = Store.playlists();
    const liked = Store.likedTracks("music");
    const albums = Store.albums();
    const recents = Store.recents();
    const musicRecents = recents.filter(track => Store.mediaKind(track) === "music");

    if (V.homeFilter === "podcasts") {
      V.paint(V.view, '<div class="home-scroll-start"></div><div id="home-feeds">' + V.homeFeedsHtml() + '</div>');
      V.buildHomeFeeds();
      // Asked for in the background, and only when the list is stale. A new list moves the
      // feed key, so the rows that come from it are built by the repaint rather than here.
      V.refreshPodcastShows().then(changed => {
        if (changed && V.currentTab === "home" && V.homeFilter === "podcasts" && !V.subView) renderHome();
      });
      return;
    }

    let html = '<div class="home-scroll-start"></div>';

    // Downloaded sits with the other pinned shortcuts, first, because with no signal it is
    // the only one of them that opens to anything.
    const quickItems = (homeDownloads.items.length ? [{ kind: "downloaded", label: "Downloaded", count: homeDownloads.items.length }] : [])
      .concat([{ kind: "liked", label: "Liked Songs", count: liked.length }])
      .concat(playlists.slice(0, 5).map(p => ({ kind: "pl", id: p.id, label: p.name, count: Store.playlistTracks(p.id).length })));
    if (liked.length || playlists.length || homeDownloads.items.length) {
      html += '<div class="home-section home-quick"><div class="quick-grid" id="home-quick-grid">' + quickItems.map(q => {
        const art = q.kind === "liked" ? "♥" : q.kind === "pl" ? V.playlistArtHtml(Store.getPlaylist(q.id))
          : '<img decoding="async" src="' + V.esc(V.artSrc(homeDownloads.items[0])) + '" alt="" />';
        return '<button class="quick-tile" data-quick="' + q.kind + '" data-quickid="' + V.esc(q.id || "") + '">' +
          '<div class="qt-art' + (q.kind === "liked" ? ' liked-cover' : '') + '">' + art + '</div>' +
          '<span dir="auto">' + V.esc(q.label) + '</span></button>';
      }).join("") + '</div></div>';
    }

    html += '<div id="home-following">' + followingHtml() + '</div>';

    const jumpBackTracks = musicRecents.filter(t => !Store.isBlocked(t)).slice(0, 12);
    if (jumpBackTracks.length) {
      html += '<div class="home-section"><div class="section-head"><h3>Jump back in</h3></div><div class="rail">' +
        jumpBackTracks.map(t => V.gridCard(V.artSrc(t), t.title, t.artist || "", 'data-recent="' + V.esc(t.id) + '"', true)).join("") +
        '</div></div>';
    }

    // Everything saved to the device, in its own row. It is the row that matters with no
    // signal, so it sits high up and carries its own play button.
    html += '<div id="home-downloaded">' + homeDownloadedHtml() + '</div>';

    const profileArtists = Store.topListeningArtists(12);
    const artists = profileArtists.length ? profileArtists : Store.artists();
    if (artists.length) {
      html += '<div class="home-section"><div class="section-head"><h3>Your top artists</h3></div><div class="rail artists home-artists">' +
        artists.slice(0, 12).map(a => V.gridCard(a.thumb, a.name, a.plays ? a.plays + " plays" : "Artist", 'data-artist="' + V.esc(a.name) + '"', false)).join("") + '</div></div>';
    }

    if (musicRecents.length) html += '<div class="home-section" id="home-recs">' + V.homeRecsHtml() + '</div>';

    html += '<div id="home-ai">' + V.aiHomeSectionHtml() + '</div>';

    if (playlists.length) {
      html += '<div class="home-section"><div class="section-head"><h3>Your playlists</h3></div><div class="rail">' +
        playlists.map(p => {
          const tracks = Store.playlistTracks(p.id);
          return V.gridCardArt(V.playlistArtHtml(p), p.name, tracks.length + " songs", 'data-pl="' + V.esc(p.id) + '"', tracks.length > 0);
        }).join("") + '</div></div>';
    }

    if (albums.length) {
      html += '<div class="home-section"><div class="section-head"><h3>Your favorite albums</h3></div><div class="rail">' +
        albums.map(a => V.gridCard(a.thumb, a.name, a.artist, 'data-album="' + V.esc(a.key) + '"', true)).join("") + '</div></div>';
    }

    if (!library.length && !playlists.length && !musicRecents.length) html += V.homeDiscoveryHtml();

    html += '<div id="home-feeds">' + V.homeFeedsHtml() + '</div>';

    V.paint(V.view, html);
    V.markNowPlaying();
    wireHomeDownloaded();
    fillHomeDownloaded();
    if (!V.artWarmed) V.warmLocalArt();
    if (musicRecents.length) V.buildHomeRecs();
    V.buildHomeFeeds();
    V.buildAiHomeSection();
    checkFollowsForNew();
  }
})();
