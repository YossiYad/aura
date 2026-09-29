const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { moduleFiles } = require('./source');

// A module split into files is several closures. A function that moved to another file
// is reached as V.name(); called bare, as it was when the two shared a closure, it is a
// ReferenceError on the one screen that needs it. This finds every bare call of a name
// that another file of the module declares at its top level and this file does not.

const SPLIT = ['views', 'player', 'api', 'main', 'store', 'sync', 'voice'];
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function topLevelNames(source) {
  return new Set(Array.from(source.matchAll(/^  (?:async )?function ([A-Za-z_$][\w$]*)\(/gm), m => m[1]));
}

// Declared anywhere in this file, at any depth: a parameter, a local, a nested function.
function declaredAnywhere(source, name) {
  return new RegExp('(?:function\\s+' + name + '\\s*\\(|(?:const|let|var)\\s+' + name + '\\b|\\b' + name + '\\s*=>|[(,]\\s*' + name + '\\s*[,)=]|\\{[^}]*\\b' + name + '\\b[^}]*\\}\\s*=)').test(source);
}

for (const name of SPLIT) {
  test(`no ${name} file calls bare a function another of its files declares`, () => {
    const files = moduleFiles(name);
    const sources = new Map(files.map(file => [file, read(file)]));
    const owner = new Map();
    for (const [file, source] of sources) for (const fn of topLevelNames(source)) owner.set(fn, (owner.get(fn) || []).concat(file));
    const problems = [];
    for (const [file, source] of sources) {
      const mine = topLevelNames(source);
      for (const [fn, owners] of owner) {
        if (mine.has(fn) || declaredAnywhere(source, fn)) continue;
        const bare = new RegExp('(?<![\\w$.])' + fn + '\\s*\\(', 'g');
        const lines = [];
        source.split('\n').forEach((line, i) => {
          // Strings and comments are not code: "song(s)" in a log line is not a call.
          const code = line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""').replace(/\/\/.*$/, '');
          if (bare.test(code)) lines.push(i + 1);
          bare.lastIndex = 0;
        });
        if (lines.length) problems.push(file + ':' + lines.join(',') + ' calls ' + fn + '() bare; it lives in ' + owners.join(', '));
      }
    }
    assert.deepEqual(problems, []);
  });
}
