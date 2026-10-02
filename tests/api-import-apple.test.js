const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readModule } = require("./source");

const apiSource = readModule("api");

// Values built inside the vm carry that realm's prototypes, which deepEqual treats as a
// difference; a round trip through JSON leaves the shape and nothing else.
const plain = v => JSON.parse(JSON.stringify(v));

function createApi(reply) {
  const calls = [];
  const context = {
    window: {},
    document: { getElementById: () => null, createElement: () => ({}) },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: url => {
      calls.push(String(url));
      const answer = reply(String(url));
      if (answer == null) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(answer) });
    }
  };
  context.self = context;
  vm.runInNewContext(apiSource, context, { filename: "src/api.js" });
  return { Api: context.window.Api, calls };
}

// The link the share sheet hands over for a playlist someone made themselves: a Hebrew
// name, percent-encoded, and the language pinned on the end. The language is what makes
// Apple name the artists in Hebrew, which is how the uploads name them too.
const USER_LINK = "https://music.apple.com/il/playlist/%D7%A9%D7%99%D7%A8%D7%99%D7%9D/pl.u-NpXmzl7ClpYRoG?l=iw";
const USER_PAGE = "https://music.apple.com/il/playlist/%D7%A9%D7%99%D7%A8%D7%99%D7%9D/pl.u-NpXmzl7ClpYRoG";

// The shape Apple's page keeps in its script tag, cut down to what the reader looks at.
function applePage(name, items, extra) {
  const data = {
    data: [{ data: { sections: [
      { itemKind: "containerDetailHeaderLockup", items: [Object.assign({ title: name, subtitleLinks: [{ title: "אסנת ידגר" }] }, extra && extra.header)] },
      { itemKind: "trackLockup", items: items.map((t, i) => ({ id: "track-lockup - pl.u-NpXmzl7ClpYRoG - " + i, title: t[0], artistName: t[1], duration: 200000,
        tertiaryLinks: [{ title: t[0] + " - Single" }] })) },
      { itemKind: "bubbleLockup", items: (extra && extra.others) || [] }
    ] } }],
    userTokenHash: "x"
  };
  return "<!DOCTYPE html><html><head><title>‎" + name + " by אסנת ידגר - Apple Music</title>" +
    '<meta property="og:title" content="' + name + ' by אסנת ידגר on Apple Music">' +
    '<script type="application/json" id="serialized-server-data">' + JSON.stringify(data) + "</script>" +
    "</head><body>" + "<div>".repeat(60) + "</body></html>";
}

// What the same page looks like read as text: durations and artwork slots, no song names.
const USER_MARKDOWN = "Title: ‎שירים by אסנת ידגר - Apple Music\n\nURL Source: " + USER_PAGE + "\n\nMarkdown Content:\n" +
  "## שירים\n\nאסנת ידגר\n\nUpdated Today\n\n" +
  "![Image 1](https://music.apple.com/assets/artwork/1x1.gif)\n\n3:49\n\n".repeat(30);

test("a playlist someone made themselves is read from the page data, in the language the link names", async () => {
  const page = applePage("שירים", [["את מי עכשיו את מחבקת?", "Michael Levi"], ["אחי", "Moshiko Mor & Lior Narkis"], ["אחי", "Moshiko Mor & Lior Narkis"]]);
  const { Api, calls } = createApi(url => url === USER_PAGE + "?l=he" ? page : null);
  const out = await Api.importPlaylist(USER_LINK);
  assert.equal(calls.find(u => /music\.apple\.com/.test(u)), USER_PAGE + "?l=he", "the page is asked for in the link's language, with Apple's old code translated, and the encoded name is left alone");
  assert.equal(out.name, "שירים");
  assert.deepEqual(plain(out.tracks), [
    { title: "את מי עכשיו את מחבקת?", artist: "Michael Levi" },
    { title: "אחי", artist: "Moshiko Mor & Lior Narkis" }
  ]);
});

test("a page whose data carries no songs falls back to reading the page as text", async () => {
  const markdown = "Title: ‎Today’s Hits - Playlist - Apple Music\n\nMarkdown Content:\n" +
    "[Patient Zero](https://music.apple.com/us/song/patient-zero/6814997425)\n\n[Taylor Swift](https://music.apple.com/us/artist/taylor-swift/159260351)\n\n" +
    "[Babylon](https://music.apple.com/us/song/babylon/6814997429)\n\n[Taylor Swift](https://music.apple.com/us/artist/taylor-swift/159260351)\n\n".repeat(3);
  const { Api } = createApi(url => {
    if (/r\.jina\.ai/.test(url)) return markdown;
    if (/music\.apple\.com/.test(decodeURIComponent(url))) return "<html><head><title>x</title></head><body>" + "<div>".repeat(60) + "</body></html>";
    return null;
  });
  const out = await Api.importPlaylist("https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb");
  assert.equal(out.name, "Today’s Hits");
  assert.deepEqual(plain(out.tracks), [{ title: "Patient Zero", artist: "Taylor Swift" }, { title: "Babylon", artist: "Taylor Swift" }]);
});

test("a text-only read of a home-made playlist still names the failure, not a wrong list", async () => {
  const { Api } = createApi(url => /r\.jina\.ai/.test(url) ? USER_MARKDOWN : null);
  await assert.rejects(Api.importPlaylist(USER_LINK), /Apple Music playlist/);
});

test("a link without a language is read as it is, and a text-only fallback keeps the same language", async () => {
  const { Api, calls } = createApi(url => /r\.jina\.ai/.test(url) ? USER_MARKDOWN : null);
  await assert.rejects(Api.importPlaylist("https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb"), /Apple Music playlist/);
  assert.equal(calls.find(u => /music\.apple\.com/.test(u)), "https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb");
  const { Api: Api2, calls: calls2 } = createApi(url => /r\.jina\.ai/.test(url) ? USER_MARKDOWN : null);
  await assert.rejects(Api2.importPlaylist(USER_LINK), /Apple Music playlist/);
  assert(calls2.some(u => u === "https://r.jina.ai/" + USER_PAGE + "?l=he"), "the text reader is asked for the same page, language included");
});

test("rows that are not songs are left out, and songs the page never listed are counted", async () => {
  const page = applePage("שירים", [["אחי", "מושיקו מור & ליאור נרקיס"], ["אלינור", "זוהר ארגוב"]],
    { header: { trackCount: 300 }, others: [{ title: "אלבום", artistName: "עומר אדם" }] });
  const { Api } = createApi(url => url === USER_PAGE + "?l=he" ? page : null);
  const out = await Api.importPlaylist(USER_LINK);
  assert.deepEqual(plain(out.tracks), [{ title: "אחי", artist: "מושיקו מור & ליאור נרקיס" }, { title: "אלינור", artist: "זוהר ארגוב" }]);
  assert.equal(out.missing, 298);
});

test("a playlist read whole, with the same song in it twice, reports nothing missing", async () => {
  const page = applePage("שירים", [["אחי", "מושיקו מור"], ["אחי", "מושיקו מור"]], { header: { trackCount: 2 } });
  const { Api } = createApi(url => url === USER_PAGE + "?l=he" ? page : null);
  const out = await Api.importPlaylist(USER_LINK);
  assert.equal(out.tracks.length, 1);
  assert.equal(out.missing, 0);
});

// YouTube Music's own links carry the list id behind a "VL" prefix; only a bare id lost it,
// so a pasted link asked the servers for a list named "VLPL...", which none of them have.
test("a VL-prefixed list id is read without the prefix however the link arrived", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(require.resolve("../src/api/import.js"), "utf8");
  const start = source.indexOf("  function youtubeListId(");
  const youtubeListId = vm.runInNewContext("(" + source.slice(start, source.indexOf("\n  }\n", start) + 4) + ")", {});
  assert.equal(youtubeListId("https://music.youtube.com/playlist?list=VLPLabcdefgh"), "PLabcdefgh");
  assert.equal(youtubeListId("https://www.youtube.com/playlist?list=PLabcdefgh"), "PLabcdefgh");
  assert.equal(youtubeListId("https://music.youtube.com/playlist/VLPLabcdefgh"), "PLabcdefgh");
  assert.equal(youtubeListId("VLPLabcdefgh"), "PLabcdefgh");
  assert.equal(youtubeListId("https://www.youtube.com/watch?v=abcdefghijk"), null);
});
