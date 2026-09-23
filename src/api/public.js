(function () {
  const V = window.Aura.api;

  window.Api = {
    siteConfig: V.siteConfig,
    search: V.search,
    searchMore: V.searchMore,
    searchArtists: V.searchArtists, searchPlaylists: V.searchPlaylists,
    getArtist: V.getArtist, artistMore: V.artistMore,
    getAlbumTracks: V.getAlbumTracks, getPlaylistInfo: V.getPlaylistInfo,
    resolve: V.resolve,
    invalidate: V.invalidate,
    fetchStreamBlob: V.fetchStreamBlob,
    fetchImageBlob: V.fetchImageBlob,
    channelFeed: V.channelFeed,
    getLyrics: V.getLyrics,
    lyricsQuery: V.lyricsQuery,
    getSkipSegments: V.getSkipSegments,
    importPlaylist: V.importPlaylist,
    matchTrack: V.matchTrack,
    findVersions: V.findVersions,
    looksLikeMusic: V.looksLikeMusic,
    notMusic: V.notMusic,
    looksLikePodcast: V.looksLikePodcast,
    thumbFor: V.thumbFor,
    defaults: { piped: V.DEFAULT_PIPED, invidious: V.DEFAULT_INVIDIOUS, cobalt: V.DEFAULT_COBALT }
  };
})();
