const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readModule } = require("./source");

const apiSource = readModule("api");

// api.js reaches the network through one global fetch, so handing it a canned reply is the
// whole environment the feed parser needs.
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

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
 <title>Ran Levi</title>
 <author><name>Ran Levi רן לוי</name><uri>https://www.youtube.com/channel/UC1</uri></author>
 <entry>
  <yt:videoId>aaa11111111</yt:videoId>
  <title>האלטלנה - באש ובמים [עושים היסטוריה]</title>
  <published>2026-08-31T05:00:07+00:00</published>
 </entry>
 <entry>
  <yt:videoId>bbb22222222</yt:videoId>
  <title>Rotem &amp; co came back from abroad &quot;empty handed&quot;</title>
  <published>2026-09-01T09:30:00+00:00</published>
 </entry>
</feed>`;

const padded = FEED + "\n<!-- " + "x".repeat(300) + " -->";

test("entries become tracks with ids, titles, dates and the channel name", async () => {
  const { Api } = createApi(() => padded);

  const tracks = await Api.channelFeed("UC1");

  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].id, "aaa11111111");
  assert.equal(tracks[0].title, "האלטלנה - באש ובמים [עושים היסטוריה]");
  assert.equal(tracks[0].artist, "Ran Levi רן לוי");
  assert.equal(tracks[0].artistId, "UC1");
  assert.equal(tracks[0].published, Date.parse("2026-08-31T05:00:07+00:00"));
});

// The feed is in publication order already, but nothing downstream should have to trust
// that, so the dates have to be real numbers rather than the strings they arrive as.
test("dates come back as comparable numbers", async () => {
  const { Api } = createApi(() => padded);

  const tracks = await Api.channelFeed("UC1");

  assert.ok(tracks[1].published > tracks[0].published);
});

test("XML entities in a title are decoded", async () => {
  const { Api } = createApi(() => padded);

  const tracks = await Api.channelFeed("UC1");

  assert.equal(tracks[1].title, 'Rotem & co came back from abroad "empty handed"');
});

// There are no durations in this feed. Rows built from it show a title and a channel, and
// the real length is read off the stream when something is played - but the field still has
// to exist and be a number, because everything downstream does arithmetic on it.
test("tracks carry a numeric zero duration rather than nothing", async () => {
  const { Api } = createApi(() => padded);

  const tracks = await Api.channelFeed("UC1");

  assert.equal(tracks[0].duration, 0);
  assert.equal(typeof tracks[0].duration, "number");
});

test("the channel id is asked for by id, and escaped", async () => {
  const { Api, calls } = createApi(() => padded);

  await Api.channelFeed("UC1");

  // config.json is read first to see whether a self-hosted relay is configured, so the
  // feed is not necessarily the first request out.
  assert.ok(calls.some(url => url.includes("youtube.com/feeds/videos.xml?channel_id=UC1")), calls.join(" | "));
});

test("a blank channel is refused without a request", async () => {
  const { Api, calls } = createApi(() => padded);

  await assert.rejects(() => Api.channelFeed("  "), /no channel/);
  assert.equal(calls.length, 0);
});

// A relay answering with its own error page is not something the browser reports as a
// failure, so a reply with no entries in it has to be treated as one here.
test("a reply with no entries is an error, not an empty list", async () => {
  const { Api } = createApi(() => "<html><body>" + "nothing to see ".repeat(40) + "</body></html>");

  await assert.rejects(() => Api.channelFeed("UC1"));
});

test("an entry missing its video id is skipped, not returned half-built", async () => {
  const broken = padded.replace("<yt:videoId>aaa11111111</yt:videoId>", "");
  const { Api } = createApi(() => broken);

  const tracks = await Api.channelFeed("UC1");

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].id, "bbb22222222");
});
