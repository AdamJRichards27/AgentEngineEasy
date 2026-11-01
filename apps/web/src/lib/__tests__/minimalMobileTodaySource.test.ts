import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { MOBILE_ASK_AE_ON_TODAY, MOBILE_MARKET_HREF, MOBILE_MOMENTUM_HREF, MOBILE_TODAY_SHOWS_GROW_SECTIONS } from "../../minimal/mobile/mobileTodayConfig";

// AE Mobile (CC Task #64, M3): guards on what the new files may do and look like.

const dir = new URL("../../minimal/mobile/", import.meta.url);
const M3_FILES = ["MobileToday.tsx", "MobileTodayView.tsx", "mobileTodayConfig.ts", "mobileTodayLayout.ts", "mobileTodayStyles.ts"];
const read = (f: string) => readFileSync(new URL(f, dir), "utf8");
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the M3 files exist and none is named for Performance", () => {
  const present = readdirSync(dir);
  for (const f of [...M3_FILES, "mobileToday.css"]) assert.ok(present.includes(f), f);
  assert.equal(present.some((f) => /performance/i.test(f)), false);
});

test("Ask AE stays off Today until its routing is verified; the section bar stays until its destinations are", () => {
  assert.equal(MOBILE_ASK_AE_ON_TODAY, false);
  assert.equal(MOBILE_TODAY_SHOWS_GROW_SECTIONS, true);
  const c = code("MobileToday.tsx");
  assert.match(c, /askAeAvailable: MOBILE_ASK_AE_ON_TODAY/);
  assert.doesNotMatch(c, /askAeAvailable:\s*true/);
  assert.match(c, /MOBILE_TODAY_SHOWS_GROW_SECTIONS \?/);
});

test("My Momentum and Market Activity addresses match the sidebar's", () => {
  const nav = readFileSync(new URL("../../minimal/minimalNav.ts", import.meta.url), "utf8");
  assert.ok(nav.includes(`"${MOBILE_MOMENTUM_HREF}"`), "sidebar uses /grow/momentum");
  assert.ok(nav.includes(`"${MOBILE_MARKET_HREF}"`), "sidebar uses /grow/market-activity");
});

test("no browser storage, no direct fetch, no write, no billing, no word Performance", () => {
  for (const f of M3_FILES) {
    const c = code(f);
    assert.doesNotMatch(c, /localStorage|sessionStorage|indexedDB|document\.cookie/, `${f}: storage`);
    assert.doesNotMatch(c, /\bfetch\(/, `${f}: direct fetch`);
    assert.doesNotMatch(c, /method:\s*["'](POST|PATCH|PUT|DELETE)/i, `${f}: write`);
    assert.doesNotMatch(c, /checkout|\/billing|subscription/i, `${f}: billing`);
    assert.doesNotMatch(c, /performance/i, `${f}: Performance`);
    assert.doesNotMatch(c, /["'](run|grow)\.[a-zA-Z.]+["']/, `${f}: an entitlement key literal`);
  }
});

test("only the container calls the API, and only the three existing endpoints", () => {
  const c = code("MobileToday.tsx");
  const calls = [...c.matchAll(/apiFetch\(([^)]*\)?)\)/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.deepEqual(calls, ['"/grow/today"', 'momentumQueryPath("week")', 'marketActivityQueryPath({ range: "week", type: null })']);
  for (const f of M3_FILES.filter((x) => x !== "MobileToday.tsx")) assert.doesNotMatch(code(f), /apiFetch|useQuery/, `${f}: no data access`);
});

test("the container's two availability queries mirror the Today cards exactly, so nothing extra is requested", () => {
  const hook = code("MobileToday.tsx");
  const cards = readFileSync(new URL("../../minimal/momentum/MinimalTodayInsightCards.tsx", import.meta.url), "utf8");
  for (const piece of [
    'queryKey: ["grow-momentum", "week"], queryFn: () => apiFetch(momentumQueryPath("week")), retry: noRetryWhenHidden',
    'queryKey: ["grow-market-activity", "week", null]',
    'queryFn: () => apiFetch(marketActivityQueryPath({ range: "week", type: null }))',
    "retry: noRetryWhenHidden",
    "const noRetryWhenHidden = (n: number, e: unknown) => !isFeatureHiddenError(e) && n < 1;",
  ]) {
    assert.ok(cards.includes(piece), `the cards still have: ${piece}`);
    assert.ok(hook.includes(piece), `the container has: ${piece}`);
  }
  assert.match(hook, /queryKey: \["grow-today"\]/);
  assert.match(hook, /queryFn: \(\) => apiFetch\("\/grow\/today"\)/);
});

// ── CSS ───────────────────────────────────────────────────────────────────

const css = read("mobileToday.css");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
const lum = (hex: string) => { const h = hex.replace("#", ""); const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
function rules() { const out: Array<{ selector: string; body: string }> = []; const re = /([^{}]+)\{([^{}]*)\}/g; let m: RegExpExecArray | null; while ((m = re.exec(bare))) out.push({ selector: m[1].trim().replace(/^@media[^{]*$/, ""), body: m[2] }); return out; }
const rule = (sel: string) => rules().find((r) => r.selector.split(",").map((s) => s.trim()).includes(sel));
const px = (body: string, prop: string) => { const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`).exec(body); return m ? Number(m[1]) : null; };

test("css: every selector is a .ae-minimal .mob-t class, so nothing outside the new screen is styled", () => {
  for (const r of rules()) {
    if (!r.selector) continue;
    for (const part of r.selector.split(",").map((s) => s.trim())) assert.match(part, /^\.ae-minimal \.mob-t(-|\b)/, part);
  }
});

test("css: targets 44 px or more, rows 56 px or more, the main action 48 px or more, room under the bar", () => {
  assert.ok((px(rule(".ae-minimal .mob-t-row")!.body, "min-height") ?? 0) >= 56, "rows");
  assert.ok((px(rule(".ae-minimal .mob-t-primary")!.body, "min-height") ?? 0) >= 48, "main action");
  assert.ok((px(rule(".ae-minimal .mob-t-button")!.body, "min-height") ?? 0) >= 44, "button");
  assert.ok((px(rule(".ae-minimal .mob-t-link")!.body, "min-height") ?? 0) >= 44, "Refresh");
  const summaryPad = /padding:\s*(\d+)px/.exec(rule(".ae-minimal .mob-t-details summary")!.body);
  assert.ok(Number(summaryPad?.[1]) >= 13, "Why this? reaches 44 px with its padding");
  assert.ok((px(rule(".ae-minimal .mob-t")!.body, "padding") ?? 0) >= 0);
  assert.match(rule(".ae-minimal .mob-t")!.body, /padding:\s*16px 16px (8\d|9\d|\d{3})px 16px/, "leaves room for the bottom bar");
});

test("css: colours follow the Minimal theme rules, text is AA, focus is never removed", () => {
  assert.doesNotMatch(bare, /#EA580C/i);
  assert.doesNotMatch(bare, /outline:\s*(none|0)/i);
  assert.match(rule(".ae-minimal .mob-t-primary")!.body, /background:\s*var\(--am-orange-strong,\s*#C44F17\)/);
  const pairs: Array<[string, string, string]> = [
    ["#FFFFFF", "#C44F17", "white on the main action"], ["#C44F17", "#FFFFFF", "kicker on white"], ["#A83F0C", "#F4F5F7", "Refresh on the page"], ["#A83F0C", "#FFFFFF", "Refresh on white"],
    ["#B3261E", "#FFFFFF", "overdue and warnings"], ["#4A5361", "#FFFFFF", "muted on white"], ["#4A5361", "#F4F5F7", "muted on the page"],
    ["#4A5361", "#FFFFFF", "kind label"], ["#8F3208", "#FDEEE5", "avatar"], ["#14181F", "#FFFFFF", "ink"],
  ];
  for (const [fg, bg, name] of pairs) assert.ok(contrast(fg, bg) >= 4.5, `${name}: ${contrast(fg, bg).toFixed(2)}`);
});
