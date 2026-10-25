// WS1 shared Minimal theme: WCAG AA contrast and visible focus (1.4.3, 1.4.11, 2.4.7).
// Found by WS2's axe-core pass and confirmed by WS1's (ae-run-lane/ws1/axe/before.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../../minimal/minimal.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function lum(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const ch = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
function token(name: string): string {
  const m = css.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{3,6})\\s*;`));
  assert.ok(m, `token ${name} defined`);
  return m[1];
}
/** Flat list of { selector, body } rules (media blocks flattened). */
function rules(): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push({ selector: m[1].trim().replace(/^@media[^{]*$/, ""), body: m[2] });
  return out;
}
const WHITE = /(^|;)\s*color:\s*(#fff\b|#ffffff\b|white\b)/i;
const ORANGE_BG = /background(-color)?:\s*(var\(--am-orange\)|#EA580C)\s*(;|$)/i;
const ORANGE_TEXT = /(^|;)\s*color:\s*(var\(--am-orange\)|#EA580C)\s*(;|$)/i;
const RING = "#C44F17";

test("theme: approved orange stays for decoration, the darker text/button orange is WS2's 4.69:1 value", () => {
  assert.equal(token("--am-orange").toUpperCase(), "#EA580C");
  assert.equal(token("--am-orange-strong").toUpperCase(), RING);
  assert.ok(contrast(RING, "#FFFFFF") >= 4.5);
  assert.ok(contrast(token("--am-orange-strong-hover"), "#FFFFFF") >= 4.5);
});

test("theme: muted and faint text pass 4.5:1 on paper, wash and card", () => {
  for (const t of ["--am-muted", "--am-faint"]) {
    for (const bg of [token("--am-paper"), token("--am-wash"), token("--am-card")]) {
      assert.ok(contrast(token(t), bg) >= 4.5, `${t} ${token(t)} on ${bg} = ${contrast(token(t), bg).toFixed(2)}`);
    }
  }
});

test("theme: no white text on the approved orange (3.56:1)", () => {
  const bad = rules().filter((r) => WHITE.test(r.body) && ORANGE_BG.test(r.body)).map((r) => r.selector);
  assert.deepEqual(bad, []);
});

test("theme: orange text uses the darker orange; the approved orange is for icons and decoration only", () => {
  const decorative = /(svg|\.op-event-selected)\s*$/;
  const bad = rules().filter((r) => ORANGE_TEXT.test(r.body)).map((r) => r.selector).filter((s) => !s.split(",").every((part) => decorative.test(part.trim())));
  assert.deepEqual(bad, []);
});

test("theme: Minimal pages override the staging banner to an AA background", () => {
  const rule = rules().find((r) => r.selector.includes(".app-root:has(.ae-minimal)") && r.selector.includes(".staging-banner"));
  assert.ok(rule, "banner override rule");
  assert.match(rule.body, /background:\s*var\(--am-orange-strong,\s*#C44F17\)|background:\s*#C44F17/i);
  assert.match(rule.body, /color:\s*#FFFFFF/i);
});

test("theme: no translucent focus rings; one visible ring for every Minimal control", () => {
  assert.doesNotMatch(css, /outline:\s*3px solid rgba\(234,\s*88,\s*12/);
  const generic = rules().find((r) => r.selector.includes(".ae-minimal :is(a, button, input, select, textarea, summary, [tabindex]):focus-visible"));
  assert.ok(generic, "generic focus-visible rule");
  assert.match(generic.body, /outline:\s*3px solid var\(--am-orange-strong\)/);
  for (const bg of [token("--am-paper"), token("--am-card"), token("--am-wash")]) assert.ok(contrast(RING, bg) >= 3, `ring on ${bg}`);
});

test("theme: borderless search and select wrappers show the ring on the wrapper", () => {
  const rule = rules().find((r) => /:focus-within/.test(r.selector) && ["am-data-search", "am-data-select", "op-search", "op-select-label"].every((c) => r.selector.includes(c)));
  assert.ok(rule, "wrapper focus-within rule");
  assert.match(rule.body, /outline:\s*3px solid var\(--am-orange-strong\)/);
});

test("theme: the dark sidebar uses a light ring (orange on #424242 is under 3:1)", () => {
  const rule = rules().find((r) => r.selector.includes(".am-sidebar :is(a, button):focus-visible"));
  assert.ok(rule, "sidebar ring rule");
  const m = rule.body.match(/outline:\s*\d+px solid (#[0-9A-Fa-f]{6})/);
  assert.ok(m);
  for (const bg of ["#424242", "#333333"]) assert.ok(contrast(m[1], bg) >= 3, `sidebar ring on ${bg}`);
});

test("theme: mobile bar is opaque white so the current item (#C44F17) passes 4.5:1", () => {
  const rule = rules().find((r) => r.selector.trim() === ".ae-minimal .am-mobile-nav" && /position:\s*fixed/.test(r.body));
  assert.ok(rule);
  assert.match(rule.body, /background:\s*#FFFFFF\s*;/i);
});
