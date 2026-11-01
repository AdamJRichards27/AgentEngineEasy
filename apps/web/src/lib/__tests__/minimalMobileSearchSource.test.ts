import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// AE Mobile (CC Task #64, M2): guards on what the new files are allowed to do and look like.

const dir = new URL("../../minimal/mobile/", import.meta.url);
const M2_FILES = [
  "MobileBottomBar.tsx", "MobileMoreView.tsx", "MobilePersonRow.tsx", "MobilePropertyRow.tsx", "MobileSearchBar.tsx",
  "MobileSection.tsx", "SearchPage.tsx", "SearchPageView.tsx", "mobileLabels.ts", "mobileSearchConfig.ts",
  "mobileSearchScreen.ts", "mobileStyles.ts", "useIsPhone.ts", "useMobileSearch.ts", "useMobileNav.ts", "MobileMorePage.tsx",
];
const read = (file: string) => readFileSync(new URL(file, dir), "utf8");
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the M2 files exist, and no file name uses the word Performance", () => {
  const present = readdirSync(dir);
  for (const f of [...M2_FILES, "mobile.css"]) assert.ok(present.includes(f), f);
  assert.equal(present.some((f) => /performance/i.test(f)), false);
});

test("no browser storage, no direct fetch, no writes, no billing or checkout", () => {
  for (const f of M2_FILES) {
    const c = code(f);
    assert.doesNotMatch(c, /localStorage|sessionStorage|indexedDB|document\.cookie/, `${f}: storage`);
    assert.doesNotMatch(c, /\bfetch\(/, `${f}: direct fetch`);
    assert.doesNotMatch(c, /method:\s*["'](POST|PATCH|PUT|DELETE)/i, `${f}: write`);
    assert.doesNotMatch(c, /checkout|\/billing|subscription/i, `${f}: billing`);
    assert.doesNotMatch(c, /performance/i, `${f}: the word Performance`);
  }
});

test("the only requests are the two the M1 plan describes, sent through apiFetch", () => {
  const hook = code("useMobileSearch.ts");
  const calls = [...hook.matchAll(/apiFetch(?:<[^>]+>)?\(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.deepEqual(calls, ["contactsPath as string, { signal }", "propertiesPath as string, { signal }"]);
  assert.match(hook, /plan\.contacts\?\.path/);
  assert.match(hook, /plan\.properties\?\.path/);
  for (const f of M2_FILES.filter((x) => x !== "useMobileSearch.ts" && x !== "useMobileNav.ts")) assert.doesNotMatch(code(f), /apiFetch/, `${f}: only the two hooks call the API`);
});

test("useMobileNav mirrors the shell's two availability queries exactly, so nothing extra is requested", () => {
  const hook = code("useMobileNav.ts");
  const shell = readFileSync(new URL("../../minimal/MinimalShell.tsx", import.meta.url), "utf8");
  const calls = [...hook.matchAll(/apiFetch\(([^)]*\))\)/g)].map((m) => m[1]);
  assert.deepEqual(calls, ['momentumQueryPath("week")', 'marketActivityQueryPath({ range: "week", type: null })']);
  for (const piece of [
    'queryKey: ["grow-momentum", "week"]',
    'queryFn: () => apiFetch(momentumQueryPath("week"))',
    'queryKey: ["grow-market-activity", "week", null]',
    'queryFn: () => apiFetch(marketActivityQueryPath({ range: "week", type: null }))',
    "retry: noRetryWhenHidden",
    "enabled: !ownerWithoutContext",
    "const noRetryWhenHidden = (n: number, e: unknown) => !isFeatureHiddenError(e) && n < 1;",
    "marketActivityAvailable: market.isSuccess",
    "momentumAvailable: momentum.isSuccess",
  ]) {
    const wanted = piece.startsWith("retry:") || piece.startsWith("enabled:") ? 2 : 1; // once per query
    assert.equal(shell.split(piece).length - 1 >= wanted, true, `the shell still has: ${piece}`);
    assert.equal(hook.split(piece).length - 1 >= wanted, true, `the hook has: ${piece}`);
  }
});

test("search cache keys cannot touch the Contacts or Properties list caches, and recents live in the cache, not storage", () => {
  const hook = code("useMobileSearch.ts");
  assert.match(hook, /queryKey: \["mobile-search", "contacts"/);
  assert.match(hook, /queryKey: \["mobile-search", "properties"/);
  assert.doesNotMatch(hook, /["']grow-contacts["']/);
  assert.match(code("mobileSearchConfig.ts"), /RECENT_KEY = \["mobile-search-recent"\]/);
});

test("phone search is wired to the guarded constant, never hard-coded on", () => {
  const page = code("SearchPage.tsx");
  assert.match(page, /phoneSearchSupported: PHONE_SEARCH_SUPPORTED/);
  assert.doesNotMatch(page, /phoneSearchSupported:\s*true/);
});

test("entitlement keys are imported, not copied", () => {
  for (const f of M2_FILES.filter((x) => x !== "mobileSearchConfig.ts")) {
    assert.doesNotMatch(code(f), /["'](run|grow)\.[a-zA-Z.]+["']/, `${f}: an entitlement key literal`);
  }
});

// ── CSS ───────────────────────────────────────────────────────────────────

const css = read("mobile.css");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

function lum(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
function rules(): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare))) out.push({ selector: m[1].trim().replace(/^@media[^{]*$/, ""), body: m[2] });
  return out;
}
function rule(selector: string) {
  return rules().find((r) => r.selector.split(",").map((s) => s.trim()).includes(selector));
}
function px(body: string, prop: string): number | null {
  const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`).exec(body);
  return m ? Number(m[1]) : null;
}

test("css: every selector is a .ae-minimal .mob- class, so nothing outside the new views is styled", () => {
  for (const r of rules()) {
    if (!r.selector) continue;
    for (const part of r.selector.split(",").map((s) => s.trim())) assert.match(part, /^\.ae-minimal \.mob-/, part);
  }
});

test("css: tap targets are 44 px or more and list rows 56 px or more, fields use 16 px text", () => {
  for (const sel of [".ae-minimal .mob-searchbar", ".ae-minimal .mob-bar a", ".ae-minimal .mob-icon-btn", ".ae-minimal .mob-button"]) {
    const r = rule(sel);
    assert.ok(r, sel);
    assert.ok((px(r.body, "min-height") ?? 0) >= 44, `${sel} min-height`);
  }
  assert.ok((px(rule(".ae-minimal .mob-row")!.body, "min-height") ?? 0) >= 56, "rows 56 px");
  assert.ok((px(rule(".ae-minimal .mob-input")!.body, "font-size") ?? 0) >= 16, "field text 16 px");
  assert.ok((px(rule(".ae-minimal .mob-searchbar")!.body, "font-size") ?? 0) >= 16, "search bar text 16 px");
  assert.ok((px(rule(".ae-minimal .mob-clear")!.body, "width") ?? 0) >= 44, "clear button width");
  assert.ok((px(rule(".ae-minimal .mob-clear")!.body, "height") ?? 0) >= 44, "clear button height");
});

test("css: focus is never removed, and nothing sits under the bar", () => {
  assert.doesNotMatch(bare, /outline:\s*(none|0)/i);
  assert.match(rule(".ae-minimal .mob-search")!.body, /padding-bottom:\s*(8\d|9\d|\d{3})px/, "search leaves room for the bar");
  assert.match(rule(".ae-minimal .mob-more")!.body, /padding:[^;]*9\dpx/, "More leaves room for the bar");
  assert.match(rule(".ae-minimal .mob-bar")!.body, /env\(safe-area-inset-bottom/, "clears the home indicator");
  assert.match(rule(".ae-minimal .mob-bar")!.body, /background:\s*#FFFFFF/i, "opaque white bar");
});

test("css: colours follow the Minimal theme rules (AA text; orange text uses the strong orange; no white on orange)", () => {
  assert.doesNotMatch(bare, /#EA580C/i, "the approved orange is decoration only");
  assert.match(rule(".ae-minimal .mob-bar a.is-current")!.body, /var\(--am-orange-strong,\s*#C44F17\)/);
  assert.ok(contrast("#C44F17", "#FFFFFF") >= 4.5, "current tab on white");
  const pairs: Array<[string, string, string]> = [
    ["#4A5361", "#FFFFFF", "muted on white"],
    ["#4A5361", "#F4F5F7", "muted on page"],
    ["#2B3340", "#FFFFFF", "titles on white"],
    ["#2B3340", "#E8EBF0", "chip text"],
    ["#8F3208", "#FDEEE5", "avatar initials"],
    ["#8F3208", "#FFFFFF", "match note"],
    ["#14181F", "#FFFFFF", "ink on white"],
  ];
  for (const [fg, bg, name] of pairs) assert.ok(contrast(fg, bg) >= 4.5, `${name}: ${contrast(fg, bg).toFixed(2)}`);
  assert.ok(contrast("#7A8494", "#FFFFFF") >= 3, "field border meets 3:1");
});

test("css: the bar and the search field are hidden above the shell's phone breakpoint", () => {
  assert.match(css, /@media \(min-width: 761px\)\s*\{[\s\S]*?\.mob-bar,[\s\S]*?\.mob-searchbar[\s\S]*?display:\s*none/);
});
