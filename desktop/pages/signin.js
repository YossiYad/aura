"use strict";
const $ = id => document.getElementById(id);
const go = /** @type {HTMLButtonElement} */ ($("go"));

// The same page says three things: sign in, the server cannot be reached, and the
// server is there but has no way to sign this app in yet.
const SAYS = {
  out: ["Sign in to Aura", "Sign-in opens in your browser, where your Google account already is, and comes back here by itself."],
  offline: ["Aura cannot be reached", "The server did not answer. Check the connection, or the address below."],
  waiting: ["Waiting for your browser", "Finish signing in there and press Continue on the page it shows. This window carries on by itself. If the browser says the page was not found, the server has not been updated for the desktop app yet."]
};

function show(status) {
  const kind = SAYS[status.kind] ? status.kind : "out";
  $("title").textContent = SAYS[kind][0];
  $("text").textContent = SAYS[kind][1];
  go.hidden = kind === "offline";
  go.disabled = kind === "waiting";
  go.textContent = kind === "waiting" ? "Waiting..." : "Sign in with your browser";
  $("retry").hidden = kind !== "offline";
  $("note").className = "note" + (status.error ? " err" : "");
  $("note").textContent = status.error || "";
}

window.auraDesktop.state().then(state => {
  $("server").textContent = state.server;
  show(state.status || { kind: "out" });
});
window.auraDesktop.onStatus(show);
go.onclick = () => window.auraDesktop.signIn();
$("retry").onclick = () => window.auraDesktop.retry();
$("change").onclick = () => window.auraDesktop.changeServer();
