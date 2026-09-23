// Run with Playwright on NODE_PATH and an installed Chromium.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
require("../scripts/build-landing.cjs");
const root = path.resolve(__dirname, "../.local/landing");
const files = fs.readdirSync(root).sort();
assert.deepEqual(files, [
  ".nojekyll",
  "assets",
  "index.html",
  "main.js",
  "style.css",
]);
const server = http.createServer((req, res) => {
  let pathname = new URL(req.url, "http://localhost").pathname;
  if (!pathname.startsWith("/aura/")) return res.writeHead(404).end();
  pathname = pathname.slice("/aura/".length) || "index.html";
  const file = path.resolve(root, pathname);
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (error, data) => {
    if (error) return res.writeHead(404).end();
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".css": "text/css",
        ".js": "text/javascript",
        ".png": "image/png",
        ".svg": "image/svg+xml",
      }[path.extname(file)] || "application/octet-stream",
    );
    res.end(data);
  });
});
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400)
        errors.push(response.url() + " " + response.status());
    });
    await page.route("**/*", (route) => {
      if (!route.request().url().startsWith(origin)) {
        errors.push("External request: " + route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    for (const width of [360, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin + "/aura/");
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator("h1").count(), 1);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        "No horizontal overflow at " + width,
      );
      assert.equal(
        await page
          .locator(".phone img")
          .evaluateAll((imgs) =>
            imgs.every((img) => img.complete && img.naturalWidth > 0),
          ),
        true,
      );
      assert.equal(
        await page
          .locator('a[href^="#"]')
          .evaluateAll((links) =>
            links.every(
              (a) => a.hash === "" || document.getElementById(a.hash.slice(1)),
            ),
          ),
        true,
        "Every section link resolves",
      );
      await page.locator("#copy-command").click();
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        await page.locator("#command").textContent(),
      );
      await page.locator("#tab-android").click();
      assert.equal(await page.locator("#install-android").isVisible(), true);
      await page.locator("#tab-android").press("ArrowRight");
      assert.equal(
        await page.locator("#tab-desktop").getAttribute("aria-selected"),
        "true",
      );
      assert.equal(await page.locator("#install-desktop").isVisible(), true);
      await page.locator("#tab-desktop").press("Home");
      assert.equal(await page.locator("#install-ios").isVisible(), true);
      await page.locator(".faq-list summary").first().click();
      assert.equal(
        await page.locator(".faq-list details").first().getAttribute("open"),
        "",
      );
      await page.locator(".phone-ai").click();
      assert.equal(await page.locator("#screenshot-dialog").isVisible(), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#screenshot-dialog").isVisible(), false);
      if (width < 901) {
        await page.locator(".menu-toggle").click();
        assert.equal(await page.locator("#navigation").isVisible(), true);
        await page.locator('#navigation a[href="#features"]').click();
        assert.equal(
          await page.locator(".menu-toggle").getAttribute("aria-expanded"),
          "false",
        );
      }
      await page.evaluate(() => {
        document.activeElement.blur();
        scrollTo({ top: 0, behavior: "instant" });
      });
      if (width === 390 || width === 1440) {
        await page.screenshot({
          path: path.join(root, "..", "landing-" + width + ".png"),
          fullPage: true,
        });
        await page.screenshot({
          path: path.join(root, "..", "landing-hero-" + width + ".png"),
        });
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: project subpath, isolated artifact, four screen sizes, assets, links, copy, device tabs, screenshots and mobile navigation",
    );
  } finally {
    await browser.close();
  }
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => server.close());
