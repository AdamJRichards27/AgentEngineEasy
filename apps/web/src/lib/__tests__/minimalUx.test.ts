import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import {
  formatMinimalHeaderDate,
  minimalBreadcrumb,
  readMinimalUx,
  shouldOfferMinimalView,
  shouldRenderMinimalShell,
} from "../minimalUx";

test("a missing or ineligible session payload stays on the classic shell", () => {
  for (const data of [undefined, null, {}, { ux: {} }, { ux: { eligible: false, variant: "minimal" } }]) {
    const state = readMinimalUx(data);
    assert.equal(state.eligible, false);
    assert.equal(state.variant, "classic");
    assert.equal(shouldRenderMinimalShell(state), false);
    assert.equal(shouldOfferMinimalView(state), false);
  }
});

test("only an eligible minimal payload renders the Minimal shell", () => {
  const minimal = readMinimalUx({ ux: { eligible: true, variant: "minimal" } });
  assert.equal(shouldRenderMinimalShell(minimal), true);
  assert.equal(shouldOfferMinimalView(minimal), false);
  const classic = readMinimalUx({ ux: { eligible: true, variant: "classic" } });
  assert.equal(shouldRenderMinimalShell(classic), false);
  assert.equal(shouldOfferMinimalView(classic), true);
  const unknown = readMinimalUx({ ux: { eligible: true, variant: "bold" } });
  assert.equal(shouldRenderMinimalShell(unknown), false);
  assert.equal(shouldOfferMinimalView(unknown), true);
});

test("the header date and breadcrumb use real routes, not the prototype's fictional labels", () => {
  assert.equal(formatMinimalHeaderDate(new Date("2026-10-14T00:00:00Z"), "UTC"), "Wednesday, 14 October 2026");
  const links = [
    { path: "/grow", label: "Grow" },
    { path: "/", label: "Home" },
    { path: "/properties", label: "Properties" },
  ];
  assert.deepEqual(minimalBreadcrumb("/grow/contacts/12", links), { section: "Grow", page: "Contact" });
  assert.deepEqual(minimalBreadcrumb("/properties/4", links), { section: "Agent Engine", page: "Property" });
  assert.deepEqual(minimalBreadcrumb("/grow", links), { section: "Grow", page: "Grow" });
  assert.equal(minimalBreadcrumb("/today", links).page === "My Momentum", false);
});

test("Inter is self-hosted under the SIL Open Font License and the page does not call Google Fonts", () => {
  const html = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
  const fontCss = readFileSync(new URL("../../fonts/inter/inter.css", import.meta.url), "utf8");
  const licence = readFileSync(new URL("../../fonts/inter/OFL.txt", import.meta.url), "utf8");
  const regular = readFileSync(new URL("../../fonts/inter/InterVariable.woff2", import.meta.url));
  const italic = readFileSync(new URL("../../fonts/inter/InterVariable-Italic.woff2", import.meta.url));
  assert.equal(html.includes("fonts.googleapis.com"), false);
  assert.equal(html.includes("fonts.gstatic.com"), false);
  assert.match(licence, /SIL OPEN FONT LICENSE/);
  assert.match(fontCss, /font-family:\s*"Inter"/);
  assert.equal(fontCss.includes("fonts.google"), false);
  assert.equal(regular.subarray(0, 4).toString(), "wOF2");
  assert.equal(italic.subarray(0, 4).toString(), "wOF2");
  const webRoot = new URL("../../", import.meta.url);
  const files = walk(webRoot);
  for (const file of files) {
    if (!/\.(tsx?|css|html)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    assert.equal(text.includes("fonts.googleapis.com"), false, file);
    assert.equal(text.includes("fonts.gstatic.com"), false, file);
    assert.equal(text.includes("lucide-react"), false, file);
  }
});

test("brand PNGs are the UX repo originals at a49f771", () => {
  const expected = {
    "AE_Gear_Orange_Large.png": "f1b0b756ad91e5a87b8b411c9894b7c3b2b21e75",
    "AE_Wordmark_Dark.png": "75094c888aeae9ed272738db5b5b3700fba6af34",
    "AE_Wordmark_White.png": "221a33d555d6b136af78892eed206cfa04df61bf",
  };
  for (const [name, blob] of Object.entries(expected)) {
    const bytes = readFileSync(new URL(`../../minimal/brand/${name}`, import.meta.url));
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    assert.equal(sha, blob, name);
  }
});

test("Minimal styles stay under .ae-minimal and do not include variants B or C", () => {
  const css = readFileSync(new URL("../../minimal/minimal.css", import.meta.url), "utf8");
  assert.equal(css.includes("ae-brand-variation"), false);
  assert.equal(css.includes("fonts.google"), false);
  assert.match(css, /url\("\.\/brand\/AE_Gear_Orange_Large\.png"\)/);
  const stripped = stripKeyframes(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  const failures: string[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{/g)) {
    const selector = (match[1] ?? "").trim();
    if (selector.length === 0 || selector.startsWith("@")) continue;
    if (!selector.includes(".ae-minimal")) failures.push(selector.slice(0, 160));
  }
  assert.deepEqual(failures, []);
});

test("the shell is flag-gated, lazy, and does not invent Run, Pit Crew, or local data", () => {
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../../minimal/MinimalShell.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("../minimalUx.ts", import.meta.url), "utf8");
  assert.match(app, /lazy\(\(\) => import\("\.\/minimal\/MinimalShell"\)\)/);
  assert.match(app, /shouldRenderMinimalShell\(ux\)/);
  assert.match(app, /Classic view|onClassicView/);
  assert.match(shell, /Classic view/);
  assert.equal(shell.includes("localStorage"), false);
  assert.equal(client.includes("localStorage"), false);
  assert.equal(shell.includes("fetch("), false);
  assert.equal(/\bSoon\b/.test(shell), false);
  assert.equal(shell.includes("My Momentum"), false);
  assert.equal(shell.includes("Alex Morgan"), false);
  assert.equal(shell.includes("fictional"), false);
  assert.match(shell, /buildProductNavLinks/);
});

function stripKeyframes(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@keyframes", i);
    if (at < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);
    const open = css.indexOf("{", at);
    if (open < 0) break;
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    i = j;
  }
  return out;
}

function walk(root: URL): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const next = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, root.href.endsWith("/") ? root : new URL(`${root.href}/`));
    if (entry.isDirectory()) out.push(...walk(next));
    else out.push(next);
  }
  return out;
}
