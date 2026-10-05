"use strict";
// Aura as a desktop app. The window shows the Aura web app from the listener's own server,
// exactly as a browser would, so everything the server gives a browser - the library,
// sync, search, playback - is here too, and an update to the server is an update to this.
// What the app adds is what a browser tab cannot be: a window and an icon of its own, a
// tray icon that keeps the music going with the window closed, and playback that is not
// slowed down in the background. Signing in is done in the listener's browser and handed
// over (handoff.js); the app's own two pages (pages/) ask for the server and for that.

const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, session, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const config = require("./config");
const handoff = require("./handoff");
const install = require("./install");

// For trying the app against another server or with a profile of its own, without
// touching the one in daily use.
if (process.env.AURA_DESKTOP_DATA) app.setPath("userData", path.resolve(process.env.AURA_DESKTOP_DATA));

// Run from a downloaded file on Linux, the app first makes itself at home (install.js).
// Before anything else, and before the check for a copy already running, so that a newer
// download replaces the installed one even while that one is open.
if (process.platform === "linux" && process.env.APPIMAGE) {
  const from = { appImage: process.env.APPIMAGE, home: app.getPath("home"), env: process.env, icon: path.join(__dirname, "icons", "512x512.png") };
  try {
    if (install.managedElsewhere(from)) install.uninstallOwn(from);
    else install.install(from);
  } catch (e) {
    console.error("could not add Aura to the applications menu:", e.message);
  }
}
// The web app lays itself out for a computer when it sees this name (src/views/desktop.js),
// whatever the window system says about the pointer.
app.userAgentFallback = app.userAgentFallback + " AuraDesktop/" + app.getVersion();
// The server the download came from, offered on the first run (install.js). On Windows the
// installer writes down the name it was downloaded under (build/installer.nsh).
function downloadedAs() {
  if (process.env.APPIMAGE) return process.env.APPIMAGE;
  if (process.platform !== "win32") return "";
  try { return require("node:fs").readFileSync(path.join(path.dirname(process.execPath), "installed-from.txt"), "utf8"); } catch (e) { return ""; }
}
const hinted = config.serverAddress(install.serverHint(downloadedAs()));
// An installer built by an Aura server carries that server's address (desktop/build.sh),
// which survives the file being renamed - by a browser, or by an AppImage manager.
function builtFor() {
  try { return config.serverAddress(JSON.parse(require("node:fs").readFileSync(path.join(__dirname, "server.json"), "utf8")).server); } catch (e) { return ""; }
}
const built = builtFor();
// Windows groups the window, the taskbar button and notifications under this name; it is
// the one the installer gives the Start menu shortcut.
if (process.platform === "win32") app.setAppUserModelId("app.aura.desktop");

const PAGES = pathToFileURL(path.join(__dirname, "pages") + path.sep).href;
const ICON = path.join(__dirname, "icons", "512x512.png");
const configFile = () => path.join(app.getPath("userData"), "aura-desktop.json");

let settings = Object.assign({}, config.DEFAULTS);
// A server given for this run only (see Start); the saved one is kept as it was.
let savedServer = null;
/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;
// The sign-in attempt in flight, and what the sign-in page is saying.
let attempt = null;
let status = { kind: "out", error: "" };
// A session that is missing or over sends the listener's browser to sign in without
// being asked - once in a run. After that it waits for the button, so a server that
// keeps saying no cannot keep opening tabs.
let signInUnasked = true;
let checkedAt = 0;

function origin(url) {
  try { return new URL(url).origin; } catch (e) { return ""; }
}
const isApp = url => !!settings.server && origin(url) === origin(settings.server);
const isOwnPage = url => String(url || "").startsWith(PAGES);

function remember(patch) {
  Object.assign(settings, patch);
  if (patch.server !== undefined) savedServer = null;
  const kept = savedServer === null ? settings : Object.assign({}, settings, { server: savedServer });
  try { config.save(configFile(), kept); } catch (e) { console.error("could not save settings:", e.message); }
}

function setStatus(next) {
  status = { kind: next.kind, error: next.error || "" };
  if (win && isOwnPage(win.webContents.getURL())) win.webContents.send("aura:status", status);
}

function showPage(name) {
  if (!win) return;
  win.loadFile(path.join(__dirname, "pages", name + ".html"));
}

// ---------------- Signed in or not ----------------

// The login proxy in front of an Aura server answers this address with 202 for a session
// it accepts and 401 for none. Asked from here rather than read off the page, because the
// page comes from the service worker's copy and loads whether the session is good or not.
async function probe() {
  try {
    const reply = await session.defaultSession.fetch(new URL("oauth2/auth", settings.server).href, { redirect: "manual", cache: "no-store" });
    if (reply.status === 401 || reply.status === 403 || reply.status === 0 || (reply.status >= 300 && reply.status < 400)) return "out";
    // 202 from the proxy. Anything else is a server with no login in front of it.
    return "in";
  } catch (e) {
    return "offline";
  }
}

async function hasSession() {
  const found = await session.defaultSession.cookies.get({ url: settings.server });
  return found.some(cookie => cookie.name.startsWith(handoff.COOKIE));
}

async function keepSession(cookies) {
  const jar = session.defaultSession.cookies;
  for (const old of await jar.get({ url: settings.server })) {
    if (old.name.startsWith(handoff.COOKIE)) await jar.remove(settings.server, old.name);
  }
  for (const cookie of cookies) {
    await jar.set({
      url: settings.server, name: cookie.name, value: cookie.value, path: "/",
      secure: settings.server.startsWith("https:"), httpOnly: true, sameSite: "lax",
      // The server renews it as the app is used; this only has to outlive the first load.
      expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600
    });
  }
  await jar.flushStore();
}

/** Opens whatever the app should be showing: the setup page, the sign-in page or Aura. */
async function open() {
  if (!win) return;
  if (!settings.server) { showPage("setup"); return; }
  const state = await probe();
  // With no connection the saved copy of the app still opens, and plays what is downloaded.
  if (state === "in" || (state === "offline" && await hasSession())) {
    win.loadURL(settings.server);
    return;
  }
  if (state === "offline") { setStatus({ kind: "offline" }); showPage("signin"); return; }
  needSignIn();
}

// The server has no session for this app: say so, and go and get one.
function needSignIn() {
  if (attempt) return;
  setStatus({ kind: "out" });
  showPage("signin");
  if (!signInUnasked) return;
  signInUnasked = false;
  startSignIn();
}

// The page itself comes from the saved copy and would not notice a session that ended
// while the app sat in the tray. Coming back to the window is the moment to ask.
async function checkSession() {
  if (!win || !isApp(win.webContents.getURL()) || Date.now() - checkedAt < 10 * 60 * 1000) return;
  checkedAt = Date.now();
  if (await probe() === "out") needSignIn();
}

async function startSignIn() {
  if (attempt) attempt.cancel();
  let mine;
  try {
    mine = attempt = await handoff.listen();
  } catch (e) {
    setStatus({ kind: "out", error: "Sign-in could not be started on this computer." });
    return;
  }
  setStatus({ kind: "waiting" });
  const address = handoff.requestUrl(settings.server, mine.port, mine.state);
  // For a computer with no browser to hand: the address to open somewhere on it.
  if (process.env.AURA_DESKTOP_PRINT_SIGNIN) console.log("sign-in address: " + address);
  else shell.openExternal(address);
  try {
    const cookies = await mine.cookies;
    if (attempt !== mine) return;
    attempt = null;
    await keepSession(cookies);
    if (await probe() === "out") {
      setStatus({ kind: "out", error: "The server did not accept that sign-in. Try again." });
      return;
    }
    if (!win) return;
    win.show();
    win.focus();
    win.loadURL(settings.server);
  } catch (e) {
    if (attempt !== mine) return;
    attempt = null;
    setStatus({ kind: "out", error: e && e.message === "timed out" ? "Sign-in was not finished in the browser. Try again." : "" });
  }
}

function signInAgain() {
  if (!settings.server) { showPage("setup"); return; }
  if (attempt) { attempt.cancel(); attempt = null; }
  setStatus({ kind: "out" });
  showPage("signin");
}

// ---------------- The window ----------------

function savedBounds() {
  const b = settings.bounds;
  if (!b) return { width: 1280, height: 820 };
  const placed = Number.isFinite(b.x) && Number.isFinite(b.y) && screen.getAllDisplays().some(display => {
    const area = display.workArea;
    return b.x < area.x + area.width - 80 && b.x + b.width > area.x + 80 && b.y >= area.y - 20 && b.y < area.y + area.height - 80;
  });
  return placed ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: b.width, height: b.height };
}

function createWindow() {
  win = new BrowserWindow(Object.assign(savedBounds(), {
    minWidth: 380, minHeight: 480,
    title: "Aura", backgroundColor: "#121212", autoHideMenuBar: true, icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
      // A music player starts the song it was asked for, and carries on with the queue,
      // the crossfade and the next download while its window is hidden.
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: false
    }
  }));
  if (settings.bounds && settings.bounds.maximized) win.maximize();

  const contents = win.webContents;
  // The window shows the app's own pages and the Aura server, and nothing else. A link
  // that leads anywhere else opens in the browser; the login proxy's own redirect to
  // Google is the server saying the session is over.
  const guard = (event, url) => {
    if (isApp(url) || isOwnPage(url)) return;
    event.preventDefault();
    if (/^https:\/\/accounts\.google\.com\//.test(url)) needSignIn();
    else if (/^https?:/.test(url)) shell.openExternal(url);
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.on("did-navigate", (event, url, code) => {
    if (isApp(url) && (code === 401 || code === 403)) needSignIn();
  });
  contents.on("did-fail-load", (event, code, text, url, mainFrame) => {
    // -3 is a load given up for another, which is what showing a page of ours does.
    if (!mainFrame || code === -3 || !isApp(url)) return;
    setStatus({ kind: "offline" });
    showPage("signin");
  });
  contents.on("page-title-updated", event => event.preventDefault());

  const keepBounds = () => {
    if (!win || win.isMinimized() || win.isFullScreen()) return;
    const maximized = win.isMaximized();
    const box = maximized && settings.bounds ? settings.bounds : win.getBounds();
    remember({ bounds: { x: box.x, y: box.y, width: box.width, height: box.height, maximized } });
  };
  win.on("close", event => {
    keepBounds();
    // Closing the window is not stopping the music: it goes on from the tray.
    if (!quitting && tray && settings.keepPlaying) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("focus", checkSession);
  win.on("closed", () => { win = null; });
}

function showWindow() {
  if (!win) { createWindow(); open(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------------- Tray and menus ----------------

// The three things worth doing without the window. They are the web app's own player
// calls, made only on the Aura page itself.
function player(command) {
  if (!win || !isApp(win.webContents.getURL())) return;
  const call = { toggle: "toggle", next: "next", prev: "prev" }[command];
  if (call) win.webContents.executeJavaScript("window.Player && Player." + call + "()", true).catch(() => {});
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: "Open Aura", click: showWindow },
    { type: "separator" },
    { label: "Play / Pause", click: () => player("toggle") },
    { label: "Next", click: () => player("next") },
    { label: "Previous", click: () => player("prev") },
    { type: "separator" },
    { label: "Keep playing when the window is closed", type: "checkbox", checked: settings.keepPlaying,
      click: item => remember({ keepPlaying: item.checked }) },
    { type: "separator" },
    { label: "Quit Aura", click: () => { quitting = true; app.quit(); } }
  ]);
}

function createTray() {
  try {
    const size = process.platform === "win32" ? 16 : 22;
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "icons", "tray.png")).resize({ width: size, height: size }));
  } catch (e) {
    // A desktop with no tray: closing the window then closes the app, as it has to.
    tray = null;
    return;
  }
  tray.setToolTip("Aura");
  tray.setContextMenu(trayMenu());
  tray.on("click", () => { if (win && win.isVisible() && win.isFocused()) win.hide(); else showWindow(); });
}

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Aura", submenu: [
      { label: "Sign in again", click: signInAgain },
      { label: "Use a different server", click: () => showPage("setup") },
      { type: "separator" },
      { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => { quitting = true; app.quit(); } }
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [
      { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" }
    ] },
    { role: "windowMenu" }
  ]));
}

// ---------------- The app's own pages ----------------

// Only the two pages shipped with the app may ask for these. The Aura page is remote
// content and gets no say in where the app points or when it signs in.
function fromOwnPage(event) {
  return !!event.senderFrame && isOwnPage(event.senderFrame.url);
}

ipcMain.handle("aura:state", event => fromOwnPage(event) ? { server: settings.server, hint: built || hinted, status } : null);
ipcMain.handle("aura:save-server", async (event, text) => {
  if (!fromOwnPage(event)) return { ok: false, error: "" };
  const server = config.serverAddress(text);
  if (!server) return { ok: false, error: "That is not an address Aura can open. It has to start with https://" };
  if (attempt) { attempt.cancel(); attempt = null; }
  remember({ server });
  await open();
  return { ok: true };
});
ipcMain.handle("aura:change-server", event => {
  if (!fromOwnPage(event)) return;
  if (attempt) { attempt.cancel(); attempt = null; }
  showPage("setup");
});
ipcMain.handle("aura:sign-in", event => { if (fromOwnPage(event)) startSignIn(); });
ipcMain.handle("aura:retry", event => { if (fromOwnPage(event)) open(); });

// ---------------- Start ----------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("before-quit", () => { quitting = true; });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("activate", showWindow);

  // Nothing the window shows may open a window of its own or embed another page's view.
  app.on("web-contents-created", (event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-attach-webview", attach => attach.preventDefault());
  });

  app.whenReady().then(() => {
    settings = config.load(configFile());
    // The installer came from a server: that is the server, and nothing needs asking.
    if (!settings.server && built) remember({ server: built });
    // A server given on the command line or in the environment is for that run only.
    const given = config.serverAddress(process.env.AURA_SERVER || (process.argv.find(arg => arg.startsWith("--server=")) || "").slice(9));
    if (given) { savedServer = settings.server; settings.server = given; }

    // The Aura page may use the microphone for voice requests, show notifications and go
    // full screen. Nothing else is granted, and nothing to any other page.
    const allowed = new Set(["media", "notifications", "fullscreen", "clipboard-sanitized-write"]);
    session.defaultSession.setPermissionRequestHandler((contents, permission, done, details) => {
      const video = permission === "media" && (details.mediaTypes || []).includes("video");
      done(allowed.has(permission) && !video && isApp(details.requestingUrl || contents.getURL()));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, from) => allowed.has(permission) && isApp(from));

    createMenu();
    createTray();
    createWindow();
    open();
  });
}
