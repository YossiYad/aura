// Build the public landing page from an explicit list of files.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const output = path.join(root, ".local", "landing");
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, "assets"), { recursive: true });
for (const name of ["index.html", "style.css", "main.js"]) {
  fs.copyFileSync(path.join(root, "site", name), path.join(output, name));
}
for (const name of ["library.png", "ask-ai.png", "shared-queue.png"]) {
  fs.copyFileSync(
    path.join(root, "docs", "images", name),
    path.join(output, "assets", name),
  );
}
fs.copyFileSync(
  path.join(root, "icon.svg"),
  path.join(output, "assets", "icon.svg"),
);
fs.writeFileSync(path.join(output, ".nojekyll"), "");
console.log("Landing page built in .local/landing");
