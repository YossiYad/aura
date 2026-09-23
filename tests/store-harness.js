const vm = require("node:vm");
const { readModule } = require("./source");

const storeSource = readModule("store");

function storage(entries) {
  const data = new Map(entries);
  return {
    data,
    api: {
      getItem: key => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => { data.set(key, String(value)); },
      removeItem: key => { data.delete(key); }
    }
  };
}

// store.js writes nothing but the two web storages and reads nothing but window.Log, so a
// pair of Maps and an empty window are the whole environment it needs. `session` carries
// what sessionStorage holds: passing a previous store's session models a reload, leaving
// it out models the app being started fresh.
function createStore(seed = {}, session = {}) {
  const local = storage(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  const sessionStore = storage(Object.entries(session));
  const window = {};
  const context = { window, localStorage: local.api, sessionStorage: sessionStore.api, console, Date, Math, Map, Set, JSON };
  vm.runInNewContext(storeSource, context, { filename: "src/store.js" });
  return {
    Store: window.Store,
    read: key => JSON.parse(local.data.get(key) || "null"),
    session: () => Object.fromEntries(sessionStore.data),
    // Replaceable, so a test can model storage that refuses to write.
    localApi: local.api,
    window
  };
}

module.exports = { createStore };
