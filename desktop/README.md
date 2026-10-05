# Aura for the desktop

Aura as an app of its own on a computer: a window and an icon in the applications menu, a
tray icon that keeps the music playing with the window closed, and playback that is not
slowed down in the background the way a browser tab's is. Inside the window is the Aura web
app from your own server, in its [computer layout](../README.md#quick-start) - the same
library, sync, search and playback a browser gets there, and an update to the server is an
update to the app.

It is built with [Electron](https://www.electronjs.org/) and, for now, packaged for Linux
(x86-64, as an AppImage).

## Get it

**From your own server.** Run the server's setup once with the installer switched on:

```sh
AURA_DESKTOP_APP=yes sh selfhost/private-app/setup.sh
```

It builds the installer in a container (a few minutes the first time) and from then on
rebuilds it whenever these files change. Then, in a browser on the computer, signed in to
Aura: **Settings > About > Get the desktop app**. Let the downloaded file run (right-click,
Properties, Permissions) and open it.

**From this folder.** `sh desktop/build.sh` writes `desktop/dist/Aura-x86_64.AppImage`. It
needs Docker or Podman and nothing else.

## What happens when you open it

1. **It installs itself.** Run from a downloaded file, the app keeps a copy of itself in
   `~/.local/share/aura-desktop/`, with an entry in the applications menu
   (`~/.local/share/applications/aura-desktop.desktop`) and an icon. The downloaded file
   can be deleted. Opening a newer download replaces the copy, which is how the app is
   updated.
2. **It asks where your Aura is,** once. A file downloaded from your server is named after
   it (`Aura@your-server.AppImage`), so the address is already filled in.
3. **It signs in through your browser.** Google does not let its sign-in run inside an
   app's own window, and an app should not be where a Google password is typed. So the app
   opens your browser on a page of your server, where you are signed in already or sign in
   as usual; the page says the app is asking to be signed in, and **Continue** hands it the
   session. The app carries on by itself. If the session ever ends, the app does the same
   again without being asked.

To remove it: delete those two paths, the icon at
`~/.local/share/icons/hicolor/512x512/apps/aura-desktop.png`, and the app's own data in
`~/.config/Aura`.

## How the sign-in is kept to you

- The app waits on a port of your computer only (`127.0.0.1`), for five minutes or until
  the first valid answer, whichever comes first.
- The server's page is behind the same login as everything else, checks what it is given,
  refuses to be shown inside another page, and hands the session over only when
  **Continue** is pressed. A link on some other page cannot make it happen by itself.
- The session travels in the part of the address that is never sent over the network, is
  taken out of the address as soon as the page opens, and is useless without a secret the
  app made for that one attempt.
- The page from your server runs in the window as it would in a browser: sandboxed, with
  no access to the computer and no way to tell the app where to point or when to sign in.

## Files

| File | What it does |
| --- | --- |
| `main.js` | The window, the tray, the menus, and deciding between setup, sign-in and Aura |
| `handoff.js` | The sign-in: the waiting port and what it accepts |
| `install.js` | The copy in the applications menu |
| `config.js` | The server address, the window's place, and the tray setting |
| `preload.js`, `pages/` | The app's own two pages, for the server address and for signing in |
| `build.sh` | Builds the installer in a container |

`AURA_SERVER=https://...` (or `--server=`) opens another server for one run,
`AURA_DESKTOP_DATA=/some/folder` gives a run a profile of its own, and
`AURA_DESKTOP_PRINT_SIGNIN=1` prints the sign-in address instead of opening a browser.
The tests are in `tests/desktop-app.test.js`.
