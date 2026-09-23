const assert = require("node:assert/strict");
const test = require("node:test");

const { createStore } = require("./store-harness.js");

// Invented lines, not any real song: lyrics are somebody's work, and a fixture has no
// need to borrow them.
const SYNCED = "[00:12.30]הסירה חזרה אל הנמל\n[00:18.00]כמו שהיה פעם\n[00:24.10]והרוח נרגעה";
const PLAIN = "Old lantern swinging in the harbour wind\nWe stayed to count the boats come in";

test('Hebrew maqaf and regular hyphens behave like word boundaries', () => {
  const { Store } = createStore();
  assert.equal(Store.foldText('תל־אביב'), 'תל אביב');
  assert.equal(Store.matchesQuery('תל-אביב', 'תל אביב'), true);
  Store.cacheLyrics('hebrew', { plainLyrics: 'תל־אביב בלילה' });
  assert.equal(Store.searchLyrics('תל אביב')[0].id, 'hebrew');
});

test("a phrase from the middle of a song finds it", () => {
  const { Store } = createStore();
  Store.cacheLyrics("a", { plainLyrics: PLAIN });

  const hits = Store.searchLyrics("count the boats");

  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "a");
  assert.equal(hits[0].line, "We stayed to count the boats come in");
});

// The timestamps are markup, not words. Searching had to see through them or synced
// lyrics - which is most of them - would never match at all.
test("timestamps in synced lyrics are not searched and not returned", () => {
  const { Store } = createStore();
  Store.cacheLyrics("b", { syncedLyrics: SYNCED });

  const hits = Store.searchLyrics("כמו שהיה");

  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, "כמו שהיה פעם");
  assert.equal(Store.searchLyrics("00:18").length, 0);
});

test("every word has to appear, in any order", () => {
  const { Store } = createStore();
  Store.cacheLyrics("a", { plainLyrics: PLAIN });

  assert.equal(Store.searchLyrics("wind lantern").length, 1);
  assert.equal(Store.searchLyrics("lantern elephant").length, 0);
});

test("niqqud and curly quotes do not stop a match", () => {
  const { Store } = createStore();
  Store.cacheLyrics("c", { plainLyrics: "שָׁלוֹם עוֹלָם\nit’s fine" });

  assert.equal(Store.searchLyrics("שלום עולם").length, 1);
  assert.equal(Store.searchLyrics("it's fine").length, 1);
});

// Two letters match most songs ever written; the row would be noise sitting under the
// title matches rather than an answer to anything.
test("queries under three characters are refused", () => {
  const { Store } = createStore();
  Store.cacheLyrics("a", { plainLyrics: PLAIN });

  assert.equal(Store.searchLyrics("he").length, 0);
  assert.equal(Store.searchLyrics("").length, 0);
  assert.equal(Store.searchLyrics("  ").length, 0);
});

test("songs cached as having no lyrics are skipped", () => {
  const { Store } = createStore();
  Store.cacheLyrics("d", { none: true });
  Store.cacheLyrics("e", null);

  assert.equal(Store.searchLyrics("anything").length, 0);
});

test("the limit is honoured", () => {
  const { Store } = createStore();
  for (let i = 0; i < 10; i++) Store.cacheLyrics("t" + i, { plainLyrics: "the same words here" });

  assert.equal(Store.searchLyrics("same words", 3).length, 3);
});

// The index is built once and kept. A lyric cached after that has to invalidate it, or it
// stays invisible for the rest of the session - and the song just played is exactly the
// one about to be searched for.
test("a lyric cached after the first search is findable", () => {
  const { Store } = createStore();
  Store.cacheLyrics("a", { plainLyrics: PLAIN });
  assert.equal(Store.searchLyrics("lantern").length, 1);

  Store.cacheLyrics("f", { plainLyrics: "brand new line entirely" });

  assert.equal(Store.searchLyrics("brand new line").length, 1);
});

test("a match with no line breaks still reports a line", () => {
  const { Store } = createStore();
  Store.cacheLyrics("g", { plainLyrics: "one long unbroken lyric line" });

  assert.equal(Store.searchLyrics("unbroken")[0].line, "one long unbroken lyric line");
});
