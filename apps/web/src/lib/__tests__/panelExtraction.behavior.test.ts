// AE Minimal PR-1 — the Grow and Property Workspace split is a move.
// These locks are the apiFetch calls, entitlement checks, query keys, and
// HTTP methods that lived in pages/Grow.tsx and pages/PropertyWorkspace.tsx
// at staging 94e6d485. The route modules re-export the same screens.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const baseline = JSON.parse(readFileSync(new URL("./panelExtraction.baseline.json", import.meta.url), "utf8")) as {
  grow: Record<string, string[]>;
  property: Record<string, string[]>;
};

function sources(dir: URL, page: URL): string {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => readFileSync(new URL(name, dir), "utf8"));
  files.push(readFileSync(page, "utf8"));
  return files.join("\n");
}

function collect(source: string) {
  const grab = (re: RegExp) => [...source.matchAll(re)].map((match) => match[0]).sort();
  return {
    api: grab(/apiFetch(?:<[^>\n]*>)?\(\s*[`"'][^`"']+[`"']/g),
    entitlement: grab(/hasEntitlement\(\s*"[^"]+"/g),
    queryKey: grab(/queryKey:\s*\[[^\]]+\]/g),
    method: grab(/method:\s*"(?:GET|POST|PUT|PATCH|DELETE)"/g),
  };
}

const growSource = sources(new URL("../../grow/", import.meta.url), new URL("../../pages/Grow.tsx", import.meta.url));
const propertySource = sources(
  new URL("../../propertyWorkspace/", import.meta.url),
  new URL("../../pages/PropertyWorkspace.tsx", import.meta.url),
);

test("the Grow split keeps the same API calls, entitlements, query keys, and methods", () => {
  assert.deepEqual(collect(growSource), baseline.grow);
});

test("the Property Workspace split keeps the same API calls, query keys, and methods", () => {
  assert.deepEqual(collect(propertySource), baseline.property);
});

test("route modules still expose the screens the behavior tests load", () => {
  const grow = readFileSync(new URL("../../pages/Grow.tsx", import.meta.url), "utf8");
  const property = readFileSync(new URL("../../pages/PropertyWorkspace.tsx", import.meta.url), "utf8");
  assert.match(grow, /export default function Grow\(/);
  assert.match(grow, /queryFn: \(\) => apiFetch\("\/grow\/access"\)/);
  assert.match(grow, /return <GrowWorkspace \/>/);
  for (const name of [
    "growErrorMessage",
    "GrowToday",
    "GrowContactCommitmentsList",
    "GrowContactActivityLog",
    "GrowContactAppraisalsSection",
    "GrowNewContactForm",
    "GrowContactList",
    "GrowLinkPropertyForm",
    "GrowContactDetail",
    "GrowNewOpportunityForm",
    "GrowContactOpportunitiesSection",
    "GrowOpportunitiesTab",
    "growWorkspaceEntryState",
  ]) {
    assert.match(grow, new RegExp(`export \\{ ${name}\\b`));
  }
  assert.match(property, /export \{ default \} from "\.\.\/propertyWorkspace\/PropertyWorkspaceScreen"/);
  assert.match(
    readFileSync(new URL("../../propertyWorkspace/PropertyWorkspaceScreen.tsx", import.meta.url), "utf8"),
    /export default function PropertyWorkspace\(/,
  );
});

test("the extracted panels keep browser storage out and the one existing document preview fetch", () => {
  for (const source of [growSource, propertySource]) {
    assert.equal(/\blocalStorage\b/.test(source), false);
    assert.equal(/\bsessionStorage\b/.test(source), false);
  }
  assert.equal([...(growSource.matchAll(/(^|[^\w.])fetch\(/g))].length, 0);
  const propertyFetches = [...propertySource.matchAll(/fetch\(`\/api\/documents\/\$\{documentId\}\/content`/g)];
  assert.equal(propertyFetches.length, 1);
  assert.equal([...(propertySource.matchAll(/(^|[^\w.])fetch\(/g))].length, 1);
});
