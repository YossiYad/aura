const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readModule } = require("./source");

// src/globals.d.ts describes, for the editor, the object each script publishes on window.
// It is written by hand, so this holds it to the code: every member a module publishes
// must be declared, and nothing may be declared that the module no longer has.

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

// Where each global is built, and the interface that describes it. SongProgress and Orbs
// are returned from their module's function rather than assigned inside it.
const MODULES = [
  ["src/store.js", "window.Store = {", "AuraStore"],
  ["src/api.js", "window.Api = {", "AuraApi"],
  ["src/ai.js", "window.Ai = {", "AuraAi"],
  ["src/player.js", "window.Player = {", "AuraPlayer"],
  ["src/log.js", "window.Log = {", "AuraLog"],
  ["src/sync.js", "window.Sync = {", "AuraSync"],
  ["src/push.js", "window.Push = {", "AuraPush"],
  ["src/nightly.js", "window.Nightly = {", "AuraNightly"],
  ["src/cast.js", "window.CastPlayback = {", "AuraCastPlayback"],
  ["src/voice.js", "window.Voice = {", "AuraVoice"],
  ["src/shared-queue.js", "window.SharedQueue = {", "AuraSharedQueue"],
  ["src/progress.js", "return { create", "AuraSongProgress"],
  ["src/orbs.js", "return { engine", "AuraOrbs"],
  ["src/orientation.js", "window.AppOrientation = {", "AuraAppOrientation"],
  ["src/views.js", "window.Views = {", "AuraViews"]
];

// The names of an object literal's own members, starting at its opening brace. Enough of
// a JavaScript reader for these objects, and for the interfaces that describe them: it
// steps over strings, comments, regular expressions and anything nested, and collects the
// name at the start of each member. In a declaration, <...> nests too, so the comma in
// Record<string, any> is not read as the start of another member.
function memberNames(source, open, typed) {
  const names = new Set();
  let depth = 0, i = open, expectKey = false, last = "";
  const isIdent = c => /[A-Za-z0-9_$]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") { i = source.indexOf("\n", i); continue; }
    if (c === "/" && source[i + 1] === "*") { i = source.indexOf("*/", i) + 2; continue; }
    if (c === "'" || c === '"' || c === "`") {
      i++;
      while (source[i] !== c) i += source[i] === "\\" ? 2 : 1;
      i++; last = c; continue;
    }
    // A slash after an operator or an opening bracket starts a regular expression.
    if (c === "/" && /[(,=:[!&|?{};]/.test(last)) {
      i++;
      let inClass = false;
      while (inClass || source[i] !== "/") {
        if (source[i] === "\\") i++;
        else if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        i++;
      }
      i++; last = "/"; continue;
    }
    if (typed && c === "<") {
      depth++;
    } else if (typed && c === ">" && last !== "=") {
      depth--;
    } else if ("{([".includes(c)) {
      depth++;
      if (depth === 1) expectKey = true;
    } else if ("})]".includes(c)) {
      depth--;
      if (depth === 0) return names;
    } else if ((c === "," || c === ";") && depth === 1) {
      expectKey = true;
    } else if (expectKey && depth === 1 && isIdent(c)) {
      let end = i;
      while (isIdent(source[end])) end++;
      names.add(source.slice(i, end));
      expectKey = false;
      last = "a"; i = end; continue;
    }
    if (!/\s/.test(c)) last = c;
    i++;
  }
  throw new Error("unterminated object");
}

const declarations = read("src/globals.d.ts");

function declared(name) {
  const at = declarations.indexOf("interface " + name + " {");
  assert.notEqual(at, -1, name + " is not declared in src/globals.d.ts");
  return memberNames(declarations, declarations.indexOf("{", at), true);
}

function published(file, marker) {
  const source = readModule(file);
  const at = source.lastIndexOf(marker);
  assert.notEqual(at, -1, marker + " not found in " + file);
  return memberNames(source, source.indexOf("{", at));
}

for (const [file, marker, name] of MODULES) {
  test(name + " in src/globals.d.ts lists exactly what " + file + " publishes", () => {
    const actual = published(file, marker);
    const wanted = declared(name);
    assert.ok(actual.size > 0, "no members read from " + file);
    assert.deepEqual([...actual].filter(m => !wanted.has(m)), [], "published by " + file + " but not declared");
    assert.deepEqual([...wanted].filter(m => !actual.has(m)), [], "declared but no longer published by " + file);
  });
}

test("every global the declarations describe is declared as a variable", () => {
  for (const [, , name] of MODULES) {
    assert.match(declarations, new RegExp("^declare var [A-Za-z]+: " + name + ";$", "m"), name);
  }
});
