"use strict";
// Signing the desktop app in. Google does not let its sign-in run inside an app's own
// window, and an app should not be where a Google password is typed anyway. So the app
// sends the listener's own browser to the Aura server, where they are signed in already
// or sign in the usual way, and waits on a port of this computer. The server shows a page
// saying what is being asked (selfhost/private-app/nginx.conf, /desktop/handoff), and its
// Continue link leads back to that port with the session the browser holds. The app takes
// the session for its own window and the browser tab is done.
//
// What keeps this to the person at the keyboard: the port listens on this computer only,
// the link carries a secret made for this one attempt, the session travels in the part of
// the address that is never sent over the network, and the wait ends after a few minutes
// or at the first valid answer.

const http = require("node:http");
const crypto = require("node:crypto");

// The session cookie oauth2-proxy sets, and the numbered parts it is cut into when it is
// too long for one cookie.
const COOKIE = "_oauth2_proxy";
const PARTS = { s: COOKIE, s0: COOKIE + "_0", s1: COOKIE + "_1", s2: COOKIE + "_2", s3: COOKIE + "_3" };
const VALUE = /^[A-Za-z0-9_\-=|.+/%]{16,8192}$/;
const WAIT_MS = 5 * 60 * 1000;

function newState() {
  return crypto.randomBytes(32).toString("base64url");
}

function sameText(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Reads what the Continue link carried back.
 * @param {string} fragment The link's fragment: state=...&s=...&s0=...
 * @param {string} state The secret this attempt was started with.
 * @returns {{ name: string, value: string }[] | null} The session cookies, or null when
 *   the answer is not for this attempt or holds no session.
 */
function parseAnswer(fragment, state) {
  const fields = new Map();
  for (const pair of String(fragment || "").replace(/^#/, "").split("&")) {
    const at = pair.indexOf("=");
    if (at > 0) fields.set(pair.slice(0, at), pair.slice(at + 1));
  }
  if (!state || !sameText(fields.get("state") || "", state)) return null;
  const cookies = [];
  for (const [field, name] of Object.entries(PARTS)) {
    const value = fields.get(field);
    if (!value) continue;
    if (!VALUE.test(value)) return null;
    cookies.push({ name, value });
  }
  return cookies.length ? cookies : null;
}

/** Where the browser is sent: the server's page for this attempt. */
function requestUrl(server, port, state) {
  const url = new URL("desktop/handoff", server);
  url.searchParams.set("port", String(port));
  url.searchParams.set("state", state);
  return url.href;
}

// The page the Continue link lands on. The session is in the address's fragment, which
// only this page can read: it takes it out of the address at once, so it is not left in
// the browser's history, and posts it to the app.
const LANDING = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Aura</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #121212; color: #fff;
    font: 16px/1.5 system-ui, sans-serif; text-align: center; }
  main { max-width: 420px; padding: 24px; }
  h1 { margin: 0 0 8px; font-size: 24px; }
  p { margin: 0; color: #b3b3b3; }
</style></head>
<body><main><h1 id="title">Signing in...</h1><p id="text">One moment.</p></main>
<script>
  (async function () {
    const answer = location.hash.slice(1);
    history.replaceState(null, "", location.pathname);
    const say = (title, text) => {
      document.getElementById("title").textContent = title;
      document.getElementById("text").textContent = text;
    };
    try {
      const reply = await fetch(location.pathname, { method: "POST", headers: { "Content-Type": "text/plain" }, body: answer });
      if (reply.ok) say("Aura is signed in", "You can close this tab and go back to the app.");
      else say("That did not work", "Go back to Aura and choose Sign in again.");
    } catch (e) {
      say("Aura is not waiting any more", "Go back to the app and choose Sign in again.");
    }
  })();
</script></body></html>`;

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

/**
 * Starts one sign-in attempt: listens on a port of this computer and waits for the answer.
 * @param {{ waitMs?: number }} [options]
 * @returns {Promise<{ port: number, state: string, cookies: Promise<{ name: string, value: string }[]>, cancel: () => void }>}
 *   cookies settles once: with the session, or rejects when the wait ends or is cancelled.
 */
function listen(options = {}) {
  const state = newState();
  return new Promise((ready, failed) => {
    let settle = null;
    const cookies = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    // Nobody may be waiting on it yet when the timer fires.
    cookies.catch(() => {});
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      if (server.closeAllConnections) setTimeout(() => server.closeAllConnections(), 200);
      if (error) settle.reject(error); else settle.resolve(value);
    };
    const server = http.createServer((req, res) => {
      const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
      // A page on another site cannot read this port's answers, and must not post to it:
      // only requests addressed to this exact port, and posts from its own page, are served.
      const own = "127.0.0.1:" + port;
      const path = String(req.url || "").split("?")[0];
      if (req.headers.host !== own || path !== "/handoff") { res.writeHead(404).end(); return; }
      if (req.method === "GET") { res.writeHead(200, PAGE_HEADERS).end(LANDING); return; }
      if (req.method !== "POST" || (req.headers.origin && req.headers.origin !== "http://" + own)) {
        res.writeHead(405).end();
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", chunk => {
        body += chunk;
        if (body.length > 48 * 1024) req.destroy();
      });
      req.on("end", () => {
        const found = done ? null : parseAnswer(body, state);
        res.writeHead(found ? 204 : 400, { "Cache-Control": "no-store" }).end();
        if (found) finish(null, found);
      });
    });
    const timer = setTimeout(() => finish(new Error("timed out")), options.waitMs || WAIT_MS);
    server.on("error", error => { if (!done) { done = true; clearTimeout(timer); failed(error); } });
    server.listen(0, "127.0.0.1", () => {
      const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
      ready({ port, state, cookies, cancel: () => finish(new Error("cancelled")) });
    });
  });
}

module.exports = { COOKIE, PARTS, listen, parseAnswer, requestUrl };
