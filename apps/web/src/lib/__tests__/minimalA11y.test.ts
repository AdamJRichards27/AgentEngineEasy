import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { focusMinimalMain, minimalRouteKey, shouldMoveMinimalFocus } from "../../minimal/minimalA11y";

// WS1 accessibility pass: a skip link, focus moved to the new page's heading on
// a route change (not on first load), a polite announcement of the page, and
// labelled landmarks.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const shell = read("../../minimal/MinimalShell.tsx");
const css = read("../../minimal/minimal.css");

test("route key is the path plus the Grow section only", () => {
  assert.equal(minimalRouteKey("/grow", ""), "/grow");
  assert.equal(minimalRouteKey("/grow", "?tab=contacts"), "/grow?tab=contacts");
  assert.equal(minimalRouteKey("/grow", "tab=contacts&view=full"), "/grow?tab=contacts");
  assert.equal(minimalRouteKey("/grow/contacts/7", "?view=full&compose=email"), "/grow/contacts/7");
});

test("focus moves only when the route key changes after the first render", () => {
  assert.equal(shouldMoveMinimalFocus(null, "/grow"), false);
  assert.equal(shouldMoveMinimalFocus("/grow", "/grow"), false);
  assert.equal(shouldMoveMinimalFocus("/grow", "/grow?tab=contacts"), true);
  assert.equal(shouldMoveMinimalFocus("/grow?tab=contacts", "/grow/contacts/7"), true);
});

type FakeEl = { tag: string; attrs: Record<string, string>; focused: boolean; setAttribute: (k: string, v: string) => void; hasAttribute: (k: string) => boolean; focus: () => void };
function el(tag: string, attrs: Record<string, string> = {}): FakeEl {
  const e: FakeEl = { tag, attrs: { ...attrs }, focused: false,
    setAttribute: (k, v) => { e.attrs[k] = v; }, hasAttribute: (k) => k in e.attrs, focus: () => { e.focused = true; } };
  return e;
}

test("focusMinimalMain focuses the page heading, else the main region", () => {
  const h1 = el("h1"); const main = el("main", { tabindex: "-1" });
  const withHeading = { getElementById: () => main, querySelector: (s: string) => (s === "#ae-main-workspace h1" ? h1 : null) };
  assert.equal(focusMinimalMain(withHeading as never), "heading");
  assert.equal(h1.focused, true);
  assert.equal(h1.attrs.tabindex, "-1", "the heading is made programmatically focusable");

  const main2 = el("main", { tabindex: "-1" });
  const noHeading = { getElementById: () => main2, querySelector: () => null };
  assert.equal(focusMinimalMain(noHeading as never), "main");
  assert.equal(main2.focused, true);

  assert.equal(focusMinimalMain({ getElementById: () => null, querySelector: () => null } as never), "none");
});

test("shell: skip link first, focusable main, labelled landmarks, live announcement", () => {
  const root = shell.indexOf('<div className="ae-minimal" data-ae-ux="minimal">');
  const skip = shell.indexOf('<a className="am-skip-link" href="#ae-main-workspace">Skip to main content</a>');
  assert.ok(root >= 0 && skip > root, "skip link is inside the Minimal root");
  assert.ok(skip < shell.indexOf("<aside"), "skip link comes before the sidebar");
  assert.match(shell, /<main className="am-main" id="ae-main-workspace" tabIndex=\{-1\}>/);
  assert.match(shell, /<nav className="am-nav" aria-label="Primary">/);
  assert.match(shell, /<nav className="am-breadcrumb" aria-label="Breadcrumb">/);
  assert.match(shell, /aria-live="polite"/);
  assert.match(shell, /shouldMoveMinimalFocus\(/);
  assert.match(shell, /focusMinimalMain\(document\)/);
});

test("css: skip link hidden until focused, sr-only utility exists", () => {
  assert.match(css, /\.ae-minimal \.am-skip-link \{[^}]*position: fixed;[^}]*\}/);
  assert.match(css, /\.ae-minimal \.am-skip-link:focus \{[^}]*\}/);
  assert.match(css, /\.ae-minimal \.am-sr-only \{[^}]*clip: rect\(0 0 0 0\)[^}]*\}/);
  assert.match(css, /\.ae-minimal \[tabindex="-1"\]:focus \{ outline: none; \}/);
});

test("screens: loading states are announced and role chips read as roles", () => {
  assert.match(read("../../minimal/MinimalToday.tsx"), /<p className="am-empty-note" role="status">Loading today's priorities…<\/p>/);
  assert.match(read("../../minimal/MinimalContact360.tsx"), /<p className="am-empty-note" role="status">Loading contact…<\/p>/);
  const contacts = read("../../minimal/MinimalContacts.tsx");
  assert.doesNotMatch(contacts, /<span className="am-chip-row" aria-label="Roles">/, "aria-label on a plain span is not read");
  assert.match(contacts, /<span className="am-sr-only">Roles: <\/span>/);
});

// ── Fixes from the real-API browser pass (19 Oct) ─────────────────────────
// 1. Focus stayed on <body> after a click into a not-yet-loaded page: the
//    lazy chunk was still loading (Suspense fallback) or the old heading was
//    still in the DOM, so focus landed on an element that then went away.
//    The shell now waits until the page is ready and the heading is rendered.
test("page readiness: no loading fallback and a rendered heading", async () => {
  const { minimalPageReady } = await import("../../minimal/minimalA11y");
  const visibleH1 = { getClientRects: () => [{}], isConnected: true };
  const hiddenH1 = { getClientRects: () => [], isConnected: true };
  const doc = (h1: unknown, loading: boolean) => ({
    querySelector: (s: string) => (s === "#ae-main-workspace h1" ? h1 : s === "#ae-main-workspace .app-loading" ? (loading ? {} : null) : null),
  });
  assert.equal(minimalPageReady(doc(visibleH1, false) as never), true);
  assert.equal(minimalPageReady(doc(visibleH1, true) as never), false, "Suspense fallback still showing");
  assert.equal(minimalPageReady(doc(hiddenH1, false) as never), false, "a hidden (suspended) heading is not ready");
  assert.equal(minimalPageReady(doc(null, false) as never), false);
});

test("shell retries focus until it sticks on the new page", () => {
  assert.match(shell, /minimalPageReady\(document\)/);
  assert.match(shell, /document\.activeElement/);
});

// 2. On /grow the breadcrumb and the announcement said "Grow / Grow" for every
//    section. The page part is now the Grow section (Today, Contacts, …).
test("breadcrumb page names the Grow section on /grow", async () => {
  const { minimalPageLabel } = await import("../../minimal/minimalA11y");
  assert.equal(minimalPageLabel("/grow", "?tab=contacts", "Grow"), "Contacts");
  assert.equal(minimalPageLabel("/grow", "", "Grow"), "Today");
  assert.equal(minimalPageLabel("/grow/contacts/4", "", "Contact"), "Contact");
  assert.equal(minimalPageLabel("/settings", "", "Settings"), "Settings");
  assert.match(shell, /minimalPageLabel\(location, search, crumb\.page\)/);
});

// 3. The skip link sat under the staging banner and slid in: it must be fixed,
//    on top, and fully visible on its first focus.
test("skip link is fixed above everything and shows without a transition", () => {
  const rule = /\.ae-minimal \.am-skip-link \{([^}]*)\}/.exec(css);
  assert.ok(rule);
  assert.match(rule[1], /position: fixed;/);
  assert.match(rule[1], /z-index: 1000;/);
  assert.doesNotMatch(rule[1], /transition/);
});
