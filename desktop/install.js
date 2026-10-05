"use strict";
// Installing the app on Linux. It is downloaded as one file (an AppImage), and a file in
// a Downloads folder is not an installed app: it is in no menu, and it stops working the
// day the folder is tidied. So when the app is run from such a file it keeps a copy of
// itself in the user's own data folder, with an icon and an entry in the applications
// menu that open that copy. Running a newer download replaces the copy the same way,
// which is how the app is updated. Nothing outside the user's home is touched.
//
// Some systems come with a manager that does this for every AppImage (Gear Lever,
// AppImageLauncher): it moves the file into a folder of its own, renames it and adds its
// own menu entry. The app then leaves the installing to it - a second entry would be a
// second Aura in the menu - and takes back a copy of its own made before the manager
// came along.

const fs = require("node:fs");
const path = require("node:path");

const NAME = "aura-desktop";

function dataHome(env, home) {
  return env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, ".local", "share");
}

/**
 * The server a download came from. The server names the file it hands out after itself
 * (Aura@music.example.AppImage, or .exe for Windows), so the app can offer that address
 * on its first run instead of asking for it to be typed. A browser saving a second copy
 * adds "(1)".
 * @param {string} file
 */
function serverHint(file) {
  const match = /(?:^|[\\/])Aura@([A-Za-z0-9.-]+?)(?:[ _]?\(\d+\))?\.(?:AppImage|exe)$/i.exec(String(file || "").trim());
  return match ? match[1] : "";
}

function desktopEntry(target) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Aura",
    "Comment=Your music, from your own Aura server",
    'Exec="' + target.replace(/(["\\$`])/g, "\\$1") + '" %U',
    "Icon=" + NAME,
    "Terminal=false",
    "Categories=AudioVideo;Audio;Player;",
    "StartupWMClass=" + NAME,
    ""
  ].join("\n");
}

/**
 * Whether an AppImage manager looks after this copy. The managers launch what they manage
 * with DESKTOPINTEGRATION set, the convention appimaged began, and keep the files in a
 * folder of their own: ~/AppImages for Gear Lever, ~/Applications for AppImageLauncher.
 * @param {{ appImage: string, home: string, env: Record<string, string | undefined> }} from
 */
function managedElsewhere(from) {
  if (from.env.DESKTOPINTEGRATION) return true;
  const dir = path.dirname(path.resolve(from.appImage));
  return dir === path.join(from.home, "AppImages") || dir === path.join(from.home, "Applications");
}

/**
 * Takes back what install() made, when something else now installs the app. Only what is
 * recognisably the app's own: the menu entry it wrote, and the copy that entry opens.
 * @param {{ appImage: string, home: string, env: Record<string, string | undefined> }} from
 * @returns {boolean} Whether anything was taken back.
 */
function uninstallOwn(from) {
  const share = dataHome(from.env, from.home);
  const target = path.join(share, NAME, "Aura.AppImage");
  const entry = path.join(share, "applications", NAME + ".desktop");
  let written = null;
  try { written = fs.readFileSync(entry, "utf8"); } catch (e) {}
  if (written !== desktopEntry(target) || path.resolve(from.appImage) === target) return false;
  fs.rmSync(entry, { force: true });
  fs.rmSync(path.join(share, "icons", "hicolor", "512x512", "apps", NAME + ".png"), { force: true });
  fs.rmSync(path.dirname(target), { recursive: true, force: true });
  return true;
}

function writeIfChanged(file, content) {
  let now = null;
  try { now = fs.readFileSync(file, "utf8"); } catch (e) {}
  if (now === content) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * @param {{ appImage: string, home: string, env: Record<string, string | undefined>, icon: string }} from
 *   appImage is the file the app is running from; icon is the picture to give the menu.
 * @returns {{ target: string, entry: string, icon: string, copied: boolean }}
 */
function install(from) {
  const share = dataHome(from.env, from.home);
  const target = path.join(share, NAME, "Aura.AppImage");
  let copied = false;
  if (path.resolve(from.appImage) !== target) {
    const source = fs.statSync(from.appImage);
    let kept = null;
    try { kept = fs.statSync(target); } catch (e) {}
    if (!kept || kept.size !== source.size || kept.mtimeMs < source.mtimeMs) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Copied beside itself and renamed into place: a copy that is running keeps the
      // file it was started from, and one cut short never stands in for the app.
      fs.copyFileSync(from.appImage, target + ".next");
      fs.chmodSync(target + ".next", 0o755);
      fs.renameSync(target + ".next", target);
      copied = true;
    }
  }
  const icon = path.join(share, "icons", "hicolor", "512x512", "apps", NAME + ".png");
  let have = -1;
  try { have = fs.statSync(icon).size; } catch (e) {}
  if (have !== fs.statSync(from.icon).size) {
    fs.mkdirSync(path.dirname(icon), { recursive: true });
    fs.copyFileSync(from.icon, icon);
  }
  const entry = path.join(share, "applications", NAME + ".desktop");
  writeIfChanged(entry, desktopEntry(target));
  return { target, entry, icon, copied };
}

module.exports = { install, managedElsewhere, uninstallOwn, serverHint, desktopEntry };
