"use strict";
// The app's own two pages (pages/setup.html, pages/signin.html) talk to the main process
// through this. The Aura web app itself, loaded from the server, is given nothing: it runs
// as it does in a browser, and main.js refuses these calls from any page but the app's own.

const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("auraDesktop", {
    state: () => ipcRenderer.invoke("aura:state"),
    saveServer: address => ipcRenderer.invoke("aura:save-server", String(address || "")),
    changeServer: () => ipcRenderer.invoke("aura:change-server"),
    signIn: () => ipcRenderer.invoke("aura:sign-in"),
    retry: () => ipcRenderer.invoke("aura:retry"),
    onStatus: handler => ipcRenderer.on("aura:status", (event, status) => handler(status))
  });
}
