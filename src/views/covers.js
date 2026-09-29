(function () {
  const V = window.Aura.views;
  // Published on V for the other files of this module; see src/views.js.
  Object.defineProperties(V, {
    backupHandle: { get: () => V.backupHandle },
    BROWSE: { get: () => BROWSE },
    browseHtml: { get: () => browseHtml },
    categoryPlan: { get: () => categoryPlan },
    downloadBackup: { get: () => V.downloadBackup },
    freshSearchHtml: { get: () => freshSearchHtml },
    pickPlaylistCover: { get: () => V.pickPlaylistCover },
    playlistArtHtml: { get: () => V.playlistArtHtml },
    playlistCoverSrc: { get: () => V.playlistCoverSrc },
    writeBackupFile: { get: () => V.writeBackupFile }
  });

  // A card is [title, key, colour, badge, sections, kind?]. The key is what the tile
  // carries in data-browse and what the category page looks the card up by; nothing
  // searches for it. The sections are the rows the category page shows, each its own
  // search, written for the search engine rather than derived from the card's title:
  // "hip hop essentials essentials" and "sleep music classics" answered with whatever
  // happened to contain those words. {year} becomes the current year when the plan is
  // read, so the "new" rows keep asking for new songs.
  /** @typedef {[string, string, string, string, string[][], string?]} BrowseCard */
  /** @type {BrowseCard[]} */
  const BROWSE = [
    ["Music", "new music", "#dc148c", "MUSIC", [
      ["Top hits right now", "top hits {year}"],
      ["New releases", "new songs {year}"],
      ["All-time classics", "greatest songs of all time"],
      ["Throwbacks", "throwback hits 2000s"]
    ]],
    ["Made for you", "personalized music mix", "#1e3264", "MIX", [
      ["Feel-good hits", "feel good hits"],
      ["Chill hits", "chill pop hits"],
      ["Throwback hits", "throwback hits 2000s"],
      ["Late night", "late night vibes songs"]
    ]],
    ["New releases", "new music releases", "#608108", "NEW", [
      ["New this week", "new songs this week {year}"],
      ["New pop", "new pop songs {year}"],
      ["New hip-hop", "new rap songs {year}"],
      ["New rock", "new rock songs {year}"]
    ]],
    ["Charts", "top music charts", "#8d67ab", "TOP", [
      ["Global top 50", "global top 50 songs"],
      ["Billboard hits", "billboard hot 100 hits {year}"],
      ["Viral hits", "viral hits {year}"],
      ["UK top 40", "uk top 40 hits {year}"]
    ]],
    ["Pop", "today's pop hits", "#477d95", "POP", [
      ["Popular pop", "pop hits {year}"],
      ["New pop", "new pop songs {year}"],
      ["Pop classics", "pop classics 90s 2000s"],
      ["Pop essentials", "greatest pop songs of all time"]
    ]],
    ["Hip-Hop", "hip hop essentials", "#ba5d07", "RAP", [
      ["Popular hip-hop", "hip hop hits {year}"],
      ["New hip-hop", "new rap songs {year}"],
      ["Hip-hop classics", "90s hip hop classics"],
      ["Trap", "trap hits"]
    ]],
    ["Rock", "rock classics", "#006450", "ROCK", [
      ["Rock hits", "rock hits {year}"],
      ["New rock", "new rock songs {year}"],
      ["Classic rock", "classic rock 70s 80s"],
      ["Alternative rock", "alternative rock 90s 2000s hits"]
    ]],
    ["Latin", "latin music hits", "#0d73ec", "LATIN", [
      ["Popular Latin", "latin hits {year}"],
      ["Reggaeton", "reggaeton hits"],
      ["Latin classics", "latin classics salsa bachata"],
      ["Latin pop", "latin pop hits"]
    ]],
    ["Mood", "mood booster music", "#e1118c", "MOOD", [
      ["Feel-good songs", "feel good songs"],
      ["Happy hits", "happy upbeat songs"],
      ["Sad songs", "sad songs"],
      ["Calm", "calm relaxing songs"]
    ]],
    ["Indie", "new indie music", "#e91429", "INDIE", [
      ["Popular indie", "indie hits"],
      ["New indie", "new indie songs {year}"],
      ["Indie classics", "indie rock classics 2000s"],
      ["Indie folk", "indie folk songs"]
    ]],
    ["Workout", "workout music", "#777777", "MOVE", [
      ["Workout hits", "workout motivation songs"],
      ["Running", "running songs upbeat"],
      ["Gym rap", "gym rap songs"],
      ["Cardio", "cardio dance hits"]
    ]],
    ["Focus", "focus music", "#a56752", "FOCUS", [
      ["Deep focus", "deep focus music"],
      ["Lo-fi beats", "lofi beats to study"],
      ["Piano for study", "piano music for studying"],
      ["Ambient focus", "ambient music for concentration"]
    ], "long"],
    ["Chill", "chill music", "#b06239", "CHILL", [
      ["Chill hits", "chill songs"],
      ["Lo-fi chill", "lofi chill beats"],
      ["Acoustic chill", "acoustic chill songs"],
      ["Chillout", "chillout lounge music"]
    ], "long"],
    ["Sleep", "sleep music", "#1e3264", "SLEEP", [
      ["Deep sleep", "deep sleep music"],
      ["Rain sounds", "rain sounds for sleep"],
      ["Piano for sleep", "relaxing piano for sleep"],
      ["White noise", "white noise for sleeping"]
    ], "long"],
    ["Party", "party music", "#8d67ab", "PARTY", [
      ["Party hits", "party hits"],
      ["Dance hits", "dance hits {year}"],
      ["Party classics", "party classics 90s 2000s"],
      ["Latin party", "reggaeton party hits"]
    ]],
    ["Romance", "love songs", "#dc148c", "LOVE", [
      ["Love songs", "love songs"],
      ["New love songs", "new love songs {year}"],
      ["Classic love songs", "classic love songs 80s 90s"],
      ["Slow dance", "slow dance songs"]
    ]],
    ["Metal", "metal music", "#e91429", "METAL", [
      ["Metal hits", "metal hits"],
      ["New metal", "new metal songs {year}"],
      ["Metal classics", "heavy metal classics 80s"],
      ["Metalcore", "metalcore songs"]
    ]],
    ["Jazz", "jazz essentials", "#8d67ab", "JAZZ", [
      ["Jazz classics", "jazz classics"],
      ["Smooth jazz", "smooth jazz"],
      ["Jazz vocals", "jazz vocal standards"],
      ["Modern jazz", "modern jazz {year}"]
    ], "long"],
    ["R&B", "r and b hits", "#ba5d07", "R&B", [
      ["Popular R&B", "r&b hits {year}"],
      ["New R&B", "new r&b songs {year}"],
      ["R&B classics", "90s r&b classics"],
      ["Slow jams", "r&b slow jams"]
    ]],
    ["K-Pop", "k pop hits", "#e91429", "K-POP", [
      ["Popular K-pop", "kpop hits {year}"],
      ["New K-pop", "new kpop songs {year}"],
      ["K-pop classics", "kpop classics 2010s"],
      ["K-pop girl groups", "kpop girl group hits"]
    ]],
    ["Classical", "classical essentials", "#8c4c32", "CLASSIC", [
      ["Classical essentials", "classical music essentials"],
      ["Piano", "classical piano pieces"],
      ["Symphonies", "famous symphonies"],
      ["Baroque", "baroque music bach vivaldi"]
    ], "long"],
    ["Ambient", "ambient essentials", "#148a08", "AMBIENT", [
      ["Ambient", "ambient music"],
      ["Ambient piano", "ambient piano"],
      ["Drone", "drone ambient music"],
      ["Nature ambient", "nature sounds ambient"]
    ], "long"],
    ["Electronic", "electronic dance music", "#477d95", "EDM", [
      ["EDM hits", "edm hits"],
      ["New electronic", "new electronic songs {year}"],
      ["House", "house music hits"],
      ["Techno", "techno tracks"]
    ]],
    ["Country", "country music hits", "#d84000", "COUNTRY", [
      ["Popular country", "country hits {year}"],
      ["New country", "new country songs {year}"],
      ["Country classics", "classic country songs"],
      ["Country love songs", "country love songs"]
    ]],
    ["Soul", "soul classics", "#dc148c", "SOUL", [
      ["Soul classics", "soul classics"],
      ["Motown", "motown hits"],
      ["Neo soul", "neo soul songs"],
      ["Soul ballads", "soul ballads"]
    ]],
    ["Blues", "blues essentials", "#0d73ec", "BLUES", [
      ["Blues classics", "blues classics"],
      ["Electric blues", "electric blues"],
      ["Delta blues", "delta blues"],
      ["Blues rock", "blues rock songs"]
    ]],
    ["Punk", "punk rock", "#e91429", "PUNK", [
      ["Punk hits", "punk rock hits"],
      ["Pop punk", "pop punk hits 2000s"],
      ["Punk classics", "punk classics 70s 80s"],
      ["Hardcore", "hardcore punk songs"]
    ]],
    ["Acoustic", "acoustic music", "#ba5d07", "ACOUSTIC", [
      ["Acoustic hits", "acoustic hits"],
      ["Acoustic covers", "acoustic covers"],
      ["Singer-songwriter", "singer songwriter acoustic songs"],
      ["Acoustic guitar", "acoustic guitar songs"]
    ]]
  ];

  // The Israeli cards. Asked in English ("new Israeli pop music popular hits"), the search
  // engine matched the English words and answered with news clips, worship songs and a
  // South African dance hit with Jerusalem in its name. Asked in Hebrew for "hits" it
  // answers with hour-long DJ sets. Asked by the names of the singers who are Israeli pop
  // today - the Mizrahi pop mainstream of Omer Adam, Odeya, Osher Cohen, Sasson Ifram
  // Shaulov and Itay Levi (the whole top of the 2025 annual chart), the chart pop of Noa
  // Kirel and Eden Ben Zaken, the Mizrahi and rock generations before them, and the
  // singer-songwriters the country grew up on - it answers with their songs. The rows are
  // then held to Hebrew: a track with no Hebrew in its title or its channel name is not
  // what either card promised.
  /** @type {BrowseCard[]} */
  const FRESH = [
    ["Fresh Israeli pop", "new Israeli pop music", "#c54872", "IL POP", [
      ["Popular in Israel", "עומר אדם אודיה אושר כהן ששון איפרם שאולוב איתי לוי"],
      ["New Israeli pop", "שירים חדשים {year}"],
      ["Israeli pop stars", "נועה קירל עדן חסון אגם בוחבוט אנה זק עדן בן זקן"],
      ["Mizrahi hits", "מזרחית להיטים אייל גולן שרית חדד איתי לוי פאר טסי"],
      ["Israeli classics", "שלמה ארצי אריק איינשטיין שלום חנוך יהודית רביץ"]
    ], "he"],
    ["Hebrew pop", "Hebrew pop hits", "#353535", "HEBREW", [
      ["Hebrew hits", "חנן בן ארי עידן רייכל עברי לידר ישי ריבו"],
      ["New in Hebrew", "שירים חדשים בעברית"],
      ["Hebrew love songs", "שירי אהבה בעברית"],
      ["Israeli rock", "רוק ישראלי משינה שלום חנוך אביב גפן"],
      ["Israeli hip-hop", "היפ הופ ישראלי"],
      ["Old favourites", "חוה אלברשטיין יהורם גאון מתי כספי אריק לביא"]
    ], "he"],
    ["Fresh hits", "new hit songs", "#8d4b32", "FRESH", [
      ["New hits", "new songs {year}"],
      ["Trending now", "trending songs {year}"],
      ["New pop", "new pop songs {year}"],
      ["New hip-hop", "new rap songs {year}"]
    ]]
  ];

  const HEBREW = /[\u0590-\u05FF]/;

  // Asked for "hip hop hits", a video search answers with hour-long mixes and nothing
  // else, and the song filter below leaves the row empty. Asked for "hip hop hits official
  // video" it answers with the songs, and a music search still does.
  const SONG_HINT = " official video";

  // A card about songs shows songs. Asked for "hip hop hits", a video search answers first
  // with hour-long DJ mixes, and a news item or an interview can carry any words. Focus,
  // sleep and the other long-form cards are marked "long" and take what comes: an hour of
  // rain is what they are for.
  function song(track) {
    const secs = track.duration || 0;
    return secs >= 45 && secs <= 900 && !Api.notMusic(track);
  }

  // A Hebrew row keeps the songs that are in Hebrew. The engine is asked in Hebrew, but
  // an English-titled clip on an English channel still surfaces when the words match.
  function hebrewSong(track) {
    return HEBREW.test((track.title || "") + (track.artist || "")) && song(track);
  }

  /**
   * The rows a category page shows for a card, by the key its tile carries.
   * @param {string} key The card's data-browse value.
   * @returns {{ sections: string[][], keep: ((track: Track) => boolean) | null } | null} Null for a key no card owns; keep is null when every result stays.
   */
  function categoryPlan(key) {
    const card = BROWSE.concat(FRESH).find(item => item[1] === key);
    if (!card) return null;
    const year = String(new Date().getFullYear());
    const keep = card[5] === "he" ? hebrewSong : card[5] === "long" ? null : song;
    return {
      sections: card[4].map(section => [section[0], section[1].replace(/\{year\}/g, year) + (keep === song ? SONG_HINT : "")]),
      keep
    };
  }

  function browseHtml() {
    return '<div class="browse-grid">' + BROWSE.map(item =>
      '<button class="browse-card" data-browse="' + V.esc(item[1]) + '" data-browse-title="' + V.esc(item[0]) + '" data-browse-color="' + item[2] + '" style="--browse-bg:' + item[2] + '"><span>' + V.esc(item[0]) + '</span><i aria-hidden="true"><b>' + V.esc(item[3]) + '</b></i></button>'
    ).join("") + '</div>';
  }

  function freshSearchHtml() {
    return '<section class="fresh-search"><div class="section-head"><h3>Start something new</h3></div><div class="fresh-rail">' + FRESH.map(item =>
      '<button data-browse="' + V.esc(item[1]) + '" data-browse-title="' + V.esc(item[0]) + '" data-browse-color="' + item[2] + '" style="--fresh-bg:' + item[2] + '"><i>' + V.esc(item[3]) + '</i><span>' + V.esc(item[0]) + '</span></button>'
    ).join("") + '</div></section>';
  }

  function greeting() {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  }

})();
