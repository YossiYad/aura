# Aura for the desktop

Aura as an app of its own on a computer: a window and an icon in the applications menu, a
tray icon that keeps the music playing with the window closed, and playback that is not
slowed down in the background the way a browser tab's is. Inside the window is the Aura web
app from your own server, in its [computer layout](../README.md#quick-start) - the same
library, sync, search and playback a browser gets there, and an update to the server is an
update to the app.

It is built with [Electron](https://www.electronjs.org/) and packaged for 64-bit Intel and
AMD computers:

- **Linux:** one file (an AppImage) for any distribution - Fedora, Ubuntu, Linux Mint,
  Debian and the rest.
- **Windows 10 and 11:** an installer that needs no administrator rights.

There is no macOS build: macOS only opens apps signed with a paid Apple developer account.

An AppImage needs FUSE 2 to open. Fedora and Linux Mint have it; on Ubuntu 22.04 and later
install it once with `sudo apt install libfuse2t64` (`libfuse2` on 22.04). Without it, the
file still runs from a terminal as `./Aura.AppImage --appimage-extract-and-run`.

## Get it

**From your own server.** Run the server's setup once with the installers switched on:

```sh
AURA_DESKTOP_APP=all sh selfhost/private-app/setup.sh
```

`all` builds both; `yes` builds the Linux one alone, which saves the 5 GB image Windows is
built in. The build runs in a container (a few minutes the first time), and from then on
the installers are rebuilt whenever these files change. Then, in a browser on the computer, signed in to
Aura: **Settings > About > Get the desktop app**.

**On Windows,** open the downloaded installer. It is not signed with a paid certificate,
so Windows may say it protected your PC: choose **More info**, then **Run anyway**. It
installs for your user only, adds Aura to the Start menu and the desktop, and opens it.
Uninstall it from Settings > Apps like any other app.

**On Linux,** if your system has an AppImage manager such as Gear Lever or
AppImageLauncher, let it open the file: it adds Aura to your applications itself, and the
app leaves that to it. Without one, a downloaded file is never allowed to run until you say so, and opening it
before that offers to write it to a disk instead. So first: right-click it, **Properties**,
**Permissions**, and tick **Is executable** (on GNOME, **Allow executing file as
program**). Then double-click it. Or, in a terminal in the folder it was saved to:

```sh
chmod +x Aura@*.AppImage && ./Aura@*.AppImage
```

**From this folder.** `sh desktop/build.sh` writes `desktop/dist/Aura-x86_64.AppImage`, and
`sh desktop/build.sh all` adds `desktop/dist/Aura-Setup-x64.exe`. It needs Docker or Podman
and nothing else.

## What happens when you open it

1. **It installs itself.** On Linux, run from a downloaded file, the app keeps a copy of
   itself in `~/.local/share/aura-desktop/`, with an entry in the applications menu
   (`~/.local/share/applications/aura-desktop.desktop`) and an icon. The downloaded file
   can be deleted. Opening a newer download replaces the copy, which is how the app is
   updated. On Windows the installer does this, and a newer installer updates it.
2. **It knows where your Aura is.** An installer your server built carries the server's
   address, so the app opens it without asking. Otherwise it asks once, with the address
   already filled in when the file is still named after the server it came from
   (`Aura@your-server.AppImage` or `.exe`).
3. **It signs in through your browser.** Google does not let its sign-in run inside an
   app's own window, and an app should not be where a Google password is typed. So the app
   opens your browser on a page of your server, where you are signed in already or sign in
   as usual; the page says the app is asking to be signed in, and **Continue** hands it the
   session. The app carries on by itself. If the session ever ends, the app does the same
   again without being asked.

To remove it on Linux: delete those two paths, the icon at
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
| `build.sh` | Builds the installers in a container |
| `build/installer.nsh` | The Windows installer's one addition: it writes down the name it was saved under |

`AURA_SERVER=https://...` (or `--server=`) opens another server for one run,
`AURA_DESKTOP_DATA=/some/folder` gives a run a profile of its own, and
`AURA_DESKTOP_PRINT_SIGNIN=1` prints the sign-in address instead of opening a browser.
The tests are in `tests/desktop-app.test.js`.
