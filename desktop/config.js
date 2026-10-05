"use strict";
// What the desktop app remembers between launches: which Aura server it opens, where its
// window was, and whether closing the window leaves the music playing. One small JSON
// file in the app's own data folder. The session itself is not here - it is a cookie in
// the app's browser profile, like in any browser.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = { server: "", keepPlaying: true, bounds: null, zoom: null };

// How large the app is drawn, unless the listener has chosen (Ctrl and + or -). The
// layout is made for a screen of about 1600 by 1000 points; a larger one without a
// display scale of its own - a big monitor at 100% - shows everything small, so the app
// is drawn larger, by as much as the smaller of the two sides allows. A screen that
// already scales (a laptop at 150%, a 4K monitor at 200%) reports fewer points and is left
// alone. Kept to steps of 5%.
const ZOOM_MIN = 0.5, ZOOM_MAX = 3;
function fitZoom(width, height) {
  const fit = Math.min(width / 1600, height / 1000);
  if (!(fit >= 1.1)) return 1;
  return Math.min(ZOOM_MAX, Math.round(fit * 20) / 20);
}
const zoomValue = value => Number.isFinite(value) && value >= ZOOM_MIN && value <= ZOOM_MAX ? Math.round(value * 100) / 100 : null;

/**
 * An Aura server address as the app will open it, or "" when it is not one. HTTPS only,
 * apart from this computer itself, which is where a server is tried out.
 * @param {string} text
 */
function serverAddress(text) {
  let value = String(text || "").trim();
  if (!value) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = "https://" + value;
  let url;
  try { url = new URL(value); } catch (e) { return ""; }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "";
  if (url.username || url.password) return "";
  return url.origin + "/";
}

function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object") return Object.assign({}, DEFAULTS);
    return {
      server: serverAddress(data.server),
      keepPlaying: data.keepPlaying !== false,
      bounds: data.bounds && [data.bounds.width, data.bounds.height].every(n => Number.isFinite(n) && n >= 300)
        ? { x: Number(data.bounds.x), y: Number(data.bounds.y), width: data.bounds.width, height: data.bounds.height, maximized: !!data.bounds.maximized }
        : null,
      zoom: zoomValue(data.zoom)
    };
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

// Written beside itself and renamed into place, so a crash mid-write leaves the old file.
function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = file + ".next";
  fs.writeFileSync(next, JSON.stringify(data, null, 2));
  fs.renameSync(next, file);
}

module.exports = { DEFAULTS, ZOOM_MIN, ZOOM_MAX, fitZoom, zoomValue, load, save, serverAddress };
