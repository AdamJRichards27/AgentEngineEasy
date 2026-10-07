import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// I-18 — authenticated pages load as route chunks. A static import of any
// of them, including Grow and PropertyWorkspace, pulls that page into the
// entry chunk. Comments are stripped so a note cannot satisfy the lock.

const AUTHENTICATED_PAGES = [
  "Home",
  "CommandCentre",
  "PropertiesList",
  "StartProperty",
  "PropertyWorkspace",
  "Exceptions",
  "CommunicationsHub",
  "FinancialOperations",
  "PitCrewCommandCentre",
  "Grow",
  "GrowAppraisals",
  "AppraisalWorkspace",
  "GrowImport",
  "Settings",
  "SettingsIntegrations",
  "SettingsUsers",
] as const;

// Block comments (including JSX comments) keep their newlines so a hit can
// name a line. Line comments are cut, but `https://` is not a comment.
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  return withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const appSource = stripComments(readFileSync(new URL("../../App.tsx", import.meta.url), "utf8"));

test("authenticated pages are lazy route chunks, not static page imports", () => {
  for (const name of AUTHENTICATED_PAGES) {
    const staticImport = new RegExp(`^import\\s+${name}\\s+from\\s+["']\\./pages/${name}["'];?\\s*$`, "m");
    assert.equal(staticImport.test(appSource), false, `${name} must not be a static import from ./pages/${name}`);
    assert.ok(
      appSource.includes(`lazy(() => import("./pages/${name}"))`),
      `${name} must load as lazy(() => import("./pages/${name}"))`,
    );
  }
});

test("Suspense sits inside the page ErrorBoundary and wraps the authenticated Switch", () => {
  const boundaryAt = appSource.indexOf('<ErrorBoundary label="this page"');
  assert.ok(boundaryAt >= 0, "page ErrorBoundary is missing");
  const afterBoundary = appSource.slice(boundaryAt);
  const suspenseAt = afterBoundary.indexOf("<Suspense");
  const switchAt = afterBoundary.indexOf("<Switch");
  assert.ok(suspenseAt >= 0, "Suspense must sit inside the page ErrorBoundary");
  assert.ok(switchAt > suspenseAt, "Suspense must wrap the authenticated Switch");
  const suspenseBlock = afterBoundary.slice(suspenseAt, switchAt);
  assert.match(suspenseBlock, /fallback=\{<div className="app-loading">Loading…<\/div>\}/);
});
