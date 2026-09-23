const test = require('node:test');
const assert = require('node:assert/strict');
const { moduleFiles, readModule } = require('./source');
const fs = require('node:fs');
const path = require('node:path');

// A module split into files reaches across them through V (window.Aura.<module>), where
// each file publishes what the others use. A name used as V.x that no file publishes is
// undefined at runtime, and only on the screen that needs it; a name published twice would
// have one file's getter silently replace the other's. Both are caught here, before a
// browser ever meets them.

const SPLIT = ['views', 'player', 'api', 'main', 'store', 'orbs', 'sync', 'voice'];

function publishedBy(file) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const block = /\n  Object\.defineProperties\(V, \{\n([\s\S]*?)\n  \}\);/.exec(source);
  return block ? Array.from(block[1].matchAll(/^    ([A-Za-z_$][\w$]*): \{ get: \(\) => \1(?:, set: value => \{ \1 = value; \})? \},?$/gm), m => m[1]) : [];
}

for (const name of SPLIT) {
  test(`every V.name the ${name} files use is published by exactly one of them`, () => {
    const files = moduleFiles(name);
    assert.ok(files.length > 1, name + ' is not split');
    const owner = new Map();
    for (const file of files) {
      for (const published of publishedBy(file)) {
        assert.ok(!owner.has(published), `${published} is published by both ${owner.get(published)} and ${file}`);
        owner.set(published, file);
      }
    }
    const source = readModule(name);
    const used = new Set(Array.from(source.matchAll(/(?<![\w$.])V\.([A-Za-z_$][\w$]*)/g), m => m[1]));
    assert.deepEqual([...used].filter(n => !owner.has(n)).sort(), [], 'used through V but published by no file');
    assert.deepEqual([...owner.keys()].filter(n => !used.has(n)).sort(), [], 'published on V but used by no other file');
  });
}
