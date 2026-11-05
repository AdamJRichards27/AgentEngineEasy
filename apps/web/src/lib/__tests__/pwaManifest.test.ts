import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";

// t246u: home-screen installability only. A service worker would risk caching
// authenticated pages or /api responses, so none may exist.
const root = new URL("../../../", import.meta.url);
test("t246u: manifest is linked, icons exist, no service worker is registered", () => {
  const html = readFileSync(new URL("index.html", root), "utf8");
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  const m = JSON.parse(readFileSync(new URL("public/manifest.webmanifest", root), "utf8"));
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/");
  for (const icon of m.icons) assert.ok(existsSync(new URL(`public${icon.src}`, root)), icon.src);
  assert.ok(existsSync(new URL("public/icons/apple-touch-icon.png", root)));
  assert.equal(/serviceWorker/.test(html), false);
  const main = readFileSync(new URL("src/main.tsx", root), "utf8");
  assert.equal(/serviceWorker/.test(main), false, "no service worker registration");
});
