const fs = require("node:fs");
const path = require("node:path");

// How the tests read the client code. A module is src/<name>.js together with any files
// under src/<name>/ and any third-party code in src/vendor/ it wraps, joined in the order
// index.html loads them - the same code, in the same order, the browser runs. A module
// that is split into smaller files therefore reads exactly as it did when it was one, and
// a test that pulls a function out by name finds it whichever of the files it moved to.

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

// The local scripts index.html loads, in order, as repository paths ("src/views.js").
function pageScripts(page = "index.html") {
  const dir = path.posix.dirname(page);
  return Array.from(read(page).matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g), m => m[1])
    .filter(src => !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src))
    .map(src => path.posix.normalize(src.startsWith("/") ? src.slice(1) : path.posix.join(dir, src)));
}

// Third-party code under src/vendor/, by the module that wraps it. It opens that module's
// namespace and is read as the module's first file.
const VENDORED = { orbs: ["src/vendor/thinking-orbs.js"] };

// The files that make up one module, in load order. Accepts "views" or "src/views.js".
function moduleFiles(name) {
  const id = String(name).replace(/^src\//, "").replace(/\.js$/, "");
  const vendored = VENDORED[id] || [];
  const own = file => file === "src/" + id + ".js" || file.startsWith("src/" + id + "/") || vendored.includes(file);
  const loaded = pageScripts().filter(own);
  if (loaded.length) return loaded;
  // Not loaded by the phone app (the TV page has its own), so there is no order to follow.
  const single = "src/" + id + ".js";
  const dir = path.join(root, "src", id);
  const parts = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".js")).sort().map(f => "src/" + id + "/" + f) : [];
  const files = (fs.existsSync(path.join(root, single)) ? [single] : []).concat(parts);
  if (!files.length) throw new Error("no module named " + id);
  return files;
}

// The whole of a module's source, as the browser runs it.
function readModule(name) {
  return moduleFiles(name).map(read).join("\n");
}

// A module split into files reaches across them through its internal namespace: code in
// src/views/home.js calls V.toast(), where V is window.Aura.views. A test that runs a few
// functions in a context of its own, handing them their dependencies by name, makes V that
// same context, so V.toast is the toast the test provided.
function moduleScope(context) {
  context.V = context;
  return context;
}

// A module's source with some of its internal functions handed out on window[target], for
// tests that drive them directly. A module is several closures, so each name is handed out
// from inside the file that declares it. Throws if a name is declared in none of them.
function readModuleExposing(name, names, target) {
  const found = new Set();
  const source = moduleFiles(name).map(file => {
    const text = read(file);
    const mine = names.filter(n => new RegExp("^  (?:async )?function " + n + "\\(", "m").test(text));
    mine.forEach(n => found.add(n));
    if (!mine.length) return text;
    const end = text.lastIndexOf("})();");
    return text.slice(0, end) + "  Object.assign(window." + target + " = window." + target + " || {}, { " +
      mine.join(", ") + " });\n" + text.slice(end);
  }).join("\n");
  const missing = names.filter(n => !found.has(n));
  if (missing.length) throw new Error(name + " functions not found in any file: " + missing.join(", "));
  return source;
}

module.exports = { pageScripts, moduleFiles, readModule, moduleScope, readModuleExposing };
