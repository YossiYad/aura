"use strict";
const form = document.getElementById("form");
const address = /** @type {HTMLInputElement} */ (document.getElementById("address"));
const note = document.getElementById("note");

// The address it already has, or the one the download came from: one press of Continue.
window.auraDesktop.state().then(state => {
  address.value = state.server || state.hint || "";
  if (address.value) address.select();
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  note.className = "note";
  note.textContent = "";
  const reply = await window.auraDesktop.saveServer(address.value);
  if (reply.ok) return;
  note.className = "note err";
  note.textContent = reply.error;
});
