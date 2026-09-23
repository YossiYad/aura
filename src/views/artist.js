(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    renderYtAlbum: { get: () => renderYtAlbum },
    renderYtArtist: { get: () => renderYtArtist }
  });

  // ---------------- YouTube artist / album pages ----------------

  function sortedSongs(sv) {
    const items = V.unblocked((sv.songs && sv.songs.items) || []);
    if (sv.songSort === "popular") return items.slice().sort((a, b) => (b.views || 0) - (a.views || 0));
    // "Latest" used to mean whatever order the instance handed back. That is near enough
    // upload order right up until it is not - a pinned video, a trailer, a re-upload all
    // land out of place, and a channel loaded through the search fallback comes back in
    // relevance order outright. Sorting on the publish date makes the list read the way a
    // show is listened to: the newest episode, then the one before it, and so on down.
    return V.byNewest(items);
  }

  // Some instances hand a channel back with no dates on it at all, and the search fallback
  // returns relevance order outright - on those, "Latest" has nothing to sort by. The feed
  // YouTube publishes for every channel carries exact dates for the fifteen newest, which
  // is the stretch anyone browsing a show is looking at, so those dates are filled in from
  // it. Missing ones only: a date the channel already reported is the better one.
  async function backfillDates(sv, data) {
    const videos = (data && data.videos) || [];
    if (!videos.slice(0, 15).some(track => !track.published)) return;
    try {
      const feed = await Api.channelFeed(data.id);
      const dates = new Map(feed.map(track => [track.id, track.published]));
      let filled = 0;
      videos.forEach(track => {
        const at = dates.get(track.id);
        if (at && !track.published) { track.published = at; filled++; }
      });
      if (filled && V.subView === sv) V.render();
    } catch (e) {}
  }

  // Known first, guessed second. A show whose episodes are titled by their subject reads
  // as an artist to the title test, and following it then promised "new releases" and
  // filed its episodes as songs.
  function podcastChannel(data) {
    const videos = (data && data.videos) || [];
    return Store.isPodcastChannel(data && data.name) ||
      (videos.length > 0 && videos.filter(Api.looksLikePodcast).length > videos.length / 2);
  }

  // The fetch guard on these pages is "no data, not loading, no error", so once an error is
  // recorded the page never tries again - backing out and navigating back in was the only
  // way through. Clearing the error puts the page back in its initial state, which is what
  // makes the next render fetch.
  function wireSubViewRetry(sv) {
    const btn = document.getElementById("subview-retry");
    if (!btn) return;
    btn.onclick = () => {
      sv.error = null;
      sv.loading = false;
      V.render();
    };
  }

  // Everything already on the device by this artist. When their page cannot be fetched
  // this is still worth showing - it is the part that works with no connection at all.
  function knownByArtistHtml(name) {
    const lower = String(name || "").trim().toLowerCase();
    if (!lower) return "";
    const seen = new Set();
    const mine = [];
    const take = list => list.forEach(t => {
      if (!t || !t.id || seen.has(t.id)) return;
      if (Store.isBlocked(t)) return;
      if (String(t.artist || "").trim().toLowerCase() !== lower) return;
      seen.add(t.id);
      mine.push(t);
    });
    take(Store.sortedLibrary());
    if (Store.downloadedTracks) take(Store.downloadedTracks());
    take(Store.recents());
    if (!mine.length) return "";
    return '<div class="section-head"><h3>From your library</h3></div>' +
      '<ul class="song-list">' + mine.slice(0, 30).map(t => V.trackRow(t, "library")).join("") + '</ul>';
  }

  function renderYtArtist(sv) {
    if (!sv.data && !sv.loading && !sv.error) {
      sv.loading = true;
      sv.songSort = sv.songSort || "popular";
      Api.getArtist(sv.id, { name: sv.name, thumb: sv.thumb }).then(data => {
        sv.data = data;
        sv.songs = Object.assign({ items: data.videos || [], nextpage: null }, data.songPage || {});
        sv.loading = false;
        // A musician's page is read by what is biggest, a show's by what is newest, so the
        // chip starts on whichever side this channel is - until the listener picks one.
        if (!sv.songSortChosen) sv.songSort = podcastChannel(data) ? "latest" : "popular";
        backfillDates(sv, data);
        // Opening the page is itself an acknowledgment: fold in whatever is newest and
        // clear the "new" dot, the same way reading a message clears its unread badge.
        if (Store.isFollowing(data.id) && data.videos && data.videos[0]) {
          Store.refreshFollowLatest(data.id, data.videos[0].id);
          Store.markFollowSeen(data.id);
        }
        if (V.subView === sv) V.render();
      }).catch(() => {
        // A dead end is the worst answer: the listener asked for an artist they have
        // heard, so at minimum show what is already known about them and let them search.
        sv.error = "Couldn't load this artist right now.";
        sv.loading = false;
        sv.fallbackName = sv.name || "";
        if (V.subView === sv) V.render();
      });
    }
    if (sv.loading || !sv.data) {
      const loadingBg = sv.thumb ? ' style="--hero-bg:' + V.cssUrl(sv.thumb) + '"' : "";
      V.view.innerHTML = V.stickyBarHtml(sv.name, sv.thumb) + '<div class="artist-hero"' + loadingBg + '>' +
        '<div class="artist-avatar"><img decoding="async" src="' + V.esc(sv.thumb || "") + '" alt="" /></div>' +
        '<h2 class="artist-name" dir="auto">' + V.esc(sv.name) + '</h2></div>' +
        '<div class="status-line">' + (sv.error ? '<span class="err">' + V.esc(sv.error) + '</span>' : '<span class="ring"></span> Loading artist…') + '</div>' +
        (sv.error ? '<div class="row-actions"><button class="btn ghost" id="subview-retry">Try again</button>' +
          (sv.fallbackName ? '<button class="btn ghost" id="artist-search">Search for ' + V.esc(sv.fallbackName) + '</button>' : "") +
          '</div>' + knownByArtistHtml(sv.fallbackName) : "");
      document.getElementById("back-btn").onclick = () => V.dismissViaHistory(V.popSubView);
      const searchBtn = document.getElementById("artist-search");
      if (searchBtn) searchBtn.onclick = () => {
        V.spendSubViewEntries();
        V.currentTab = "search";
        V.subView = null;
        V.subViewStack = [];
        V.subViewScrollStack = [];
        /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#tabs .bn-tab")).forEach(b => b.classList.toggle("active", b.dataset.tab === "search"));
        V.doSearch(sv.fallbackName);
      };
      wireSubViewRetry(sv);
      return;
    }
    const a = sv.data;
    const songs = sortedSongs(sv);
    const popularVideos = V.unblocked(a.videos);
    const playAll = songs.length ? songs : popularVideos;
    const following = Store.isFollowing(a.id);
    const podcastish = podcastChannel(a);
    const followBtn = '<button class="btn ghost follow-btn' + (following ? ' on' : '') + (sv._followPop ? ' rn-pop' : '') + '" id="artist-follow">' +
      (following ? '✓ Following' : '+ Follow') + '</button>';
    const artistBg = a.thumb ? ' style="--hero-bg:' + V.cssUrl(a.thumb) + '"' : "";
    V.view.innerHTML =
      V.stickyBarHtml(a.name, a.thumb) +
      '<div class="artist-hero"' + artistBg + '>' +
      '<div class="artist-avatar"><img decoding="async" src="' + V.esc(a.thumb) + '" alt="" /></div>' +
      '<h2 class="artist-name" dir="auto">' + V.esc(a.name) + '</h2>' +
      (V.fmtSubs(a.subscribers) ? '<div class="artist-subs">' + V.fmtSubs(a.subscribers) + '</div>' : "") +
      '<div class="hero-cta">' + followBtn +
      (playAll.length
        ? '<button class="btn primary" id="artist-play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg> Play</button>' +
          '<button class="btn ghost" id="artist-save-pl">Save as playlist</button>' +
          '<button class="btn ghost" id="artist-add-pl">Add to playlist…</button>'
        : "") + '</div>' +
      '</div>' +
      (a.albums.length ? '<h3 class="section-title">Albums</h3><div class="rail">' + a.albums.map(al =>
        '<button class="card" data-ytalbum="' + V.esc(al.id) + '" data-albname="' + V.esc(al.name) + '" data-albthumb="' + V.esc(al.thumb) + '"><div class="card-art"><img decoding="async" src="' + V.esc(al.thumb) + '" loading="lazy" alt="" /></div>' +
        '<div class="card-title" dir="auto">' + V.esc(al.name) + '</div><div class="card-sub">' + (Number(al.count) || 0) + ' songs</div></button>').join("") + '</div>' : "") +
      (a.playlists.length ? '<h3 class="section-title">Playlists</h3><div class="rail">' + a.playlists.map(pl =>
        '<button class="card" data-ytalbum="' + V.esc(pl.id) + '" data-albname="' + V.esc(pl.name) + '" data-albthumb="' + V.esc(pl.thumb) + '"><div class="card-art"><img decoding="async" src="' + V.esc(pl.thumb) + '" loading="lazy" alt="" /></div>' +
        '<div class="card-title" dir="auto">' + V.esc(pl.name) + '</div><div class="card-sub">' + (Number(pl.count) || 0) + ' songs</div></button>').join("") + '</div>' : "") +
      (songs.length ? '<h3 class="section-title">Songs</h3><div class="chips">' +
        '<button class="chip' + (sv.songSort === "popular" ? " active" : "") + '" data-songsort="popular" title="Most played among the songs loaded here">Most played</button>' +
        '<button class="chip' + (sv.songSort === "latest" ? " active" : "") + '" data-songsort="latest">Latest</button>' +
        '</div><ul class="song-list">' + songs.map(V.drRow).join("") + '</ul>' +
        (sv.songs.nextpage ? '<div class="load-more-wrap"><button class="btn ghost" id="artist-load-more">' + (sv.loadingMore ? '<span class="ring"></span> Loading…' : "Load more") + '</button></div>' : "")
        : (popularVideos.length ? '<h3 class="section-title">Popular</h3><ul class="song-list">' + popularVideos.map(V.drRow).join("") + '</ul>' : ""));

    document.getElementById("back-btn").onclick = () => V.dismissViaHistory(V.popSubView);
    document.getElementById("artist-follow").onclick = () => {
      if (Store.isFollowing(a.id)) {
        Store.unfollow(a.id);
        V.toast("Unfollowed " + a.name);
      } else {
        const latest = (a.videos || [])[0];
        Store.follow({ id: a.id, name: a.name, thumb: a.thumb, kind: podcastish ? "podcast" : "artist", latestId: latest ? latest.id : null });
        V.toast("Following " + a.name + " - you'll hear about new " + (podcastish ? "episodes" : "releases"));
      }
      sv._followPop = true;
      V.render();
      sv._followPop = false;
    };
    const playBtn = document.getElementById("artist-play");
    if (playBtn) playBtn.onclick = () => Player.playQueue(playAll, 0);
    const savePlBtn = document.getElementById("artist-save-pl");
    if (savePlBtn) savePlBtn.onclick = () => {
      V.promptModal("Save as playlist", a.name, name => {
        const p = Store.createPlaylist(name);
        playAll.forEach(t => { Store.addTrack(t); Store.addToPlaylist(p.id, t.id); });
        V.toast('Saved "' + name + '" with ' + playAll.length + " songs");
        V.render();
      });
    };
    const addPlBtn = document.getElementById("artist-add-pl");
    if (addPlBtn) addPlBtn.onclick = () => V.openPlaylistPickerBulk(playAll, a.name);
    const loadMoreBtn = document.getElementById("artist-load-more");
    if (loadMoreBtn) V.watchLoadMore(sv.moreError ? null : loadMoreBtn, () => loadMoreBtn.onclick(null));
    if (loadMoreBtn) loadMoreBtn.onclick = async () => {
      if (sv.loadingMore) return;
      sv.loadingMore = true;
      sv.moreError = false;
      V.render();
      try {
        const more = await Api.artistMore(sv.songs);
        const have = new Set(sv.songs.items.map(t => t.id));
        sv.songs.items = sv.songs.items.concat(more.items.filter(t => !have.has(t.id) && have.add(t.id) && !Store.isBlocked(t)));
        sv.songs.nextpage = more.nextpage || null;
        sv.songs.page = more.page;
      } catch (e) { sv.moreError = true; V.toast("Couldn't load more songs - tap Load more to retry", "err"); }
      sv.loadingMore = false;
      if (V.subView === sv) V.render();
    };
    sv.currentVideos = playAll;
  }

  function renderYtAlbum(sv) {
    if (!sv.tracks && !sv.loading && !sv.error) {
      sv.loading = true;
      Api.getAlbumTracks(sv.id).then(tracks => {
        sv.tracks = tracks.filter(t => !Store.isBlocked(t)).map(t => Object.assign({}, t, { album: sv.name, artist: t.artist || sv.artistName || "" }));
        sv.loading = false;
        if (V.subView === sv) V.render();
      }).catch(() => {
        sv.error = "Couldn't load this album right now.";
        sv.loading = false;
        if (V.subView === sv) V.render();
      });
    }
    if (sv.loading || !sv.tracks) {
      V.view.innerHTML = V.heroView({ eyebrow: "Album", title: sv.name, thumb: sv.thumb, meta: "", cta: "" }) +
        '<div class="status-line">' + (sv.error ? '<span class="err">' + V.esc(sv.error) + '</span>' : '<span class="ring"></span> Loading tracks…') + '</div>' +
        (sv.error ? '<div class="row-actions"><button class="btn ghost" id="subview-retry">Try again</button></div>' : "");
      document.getElementById("back-btn").onclick = () => V.dismissViaHistory(V.popSubView);
      wireSubViewRetry(sv);
      return;
    }
    const tracks = V.unblocked(sv.tracks);
    const mins = Math.round(tracks.reduce((a, t) => a + (t.duration || 0), 0) / 60);
    V.view.innerHTML = V.heroView({
      eyebrow: "Album", title: sv.name, artist: sv.artistName, thumb: sv.thumb,
      meta: tracks.length + " tracks · " + mins + " min",
      cta: '<button class="btn primary" id="hero-play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg> Play</button>' +
        '<button class="btn ghost" id="add-all">Add all ' + tracks.length + '</button>'
    }) + '<ul class="song-list">' + tracks.map(V.drRow).join("") +
      '</ul><div class="album-info-footer">' + tracks.length + ' tracks · ' + mins + ' min</div>' +
      V.albumArtistsHtml(tracks);
    document.getElementById("back-btn").onclick = () => V.dismissViaHistory(V.popSubView);
    document.getElementById("hero-play").onclick = () => Player.playQueue(tracks, 0, { shuffle: false });
    document.getElementById("add-all").onclick = /** @param {PointerEvent & { target: HTMLButtonElement }} e */ e => {
      tracks.forEach(t => Store.addTrack(t));
      V.toast("Added " + tracks.length + " songs to your library");
      e.target.disabled = true;
      e.target.textContent = "Added";
    };
    sv.currentVideos = tracks;
  }
})();
