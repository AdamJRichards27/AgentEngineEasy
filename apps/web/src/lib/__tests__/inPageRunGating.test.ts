import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isRunPath, runLinkAllowed } from "../../minimal/minimalNav";

// Owner D5, in-page links: Grow screens must not offer links into Run pages
// (property workspace, Home, Today, Exceptions, Financial, Pit Crew) to users
// without run.access. Fails closed while entitlements are loading.

const GROW_ONLY = ["grow.access", "grow.contacts.read"];
const GROW_RUN = [...GROW_ONLY, "run.access"];

test("isRunPath covers the Run nav paths and property workspace sub-paths", () => {
  for (const p of ["/", "/today", "/properties", "/properties/start", "/properties/42", "/properties/42/workspace", "/exceptions", "/financial", "/pit-crew", "/properties?x=1"]) {
    assert.equal(isRunPath(p), true, p);
  }
  for (const p of ["/grow", "/grow/appraisals/3", "/communications", "/settings", "/propertiesX", "/grow/properties"]) {
    assert.equal(isRunPath(p), false, p);
  }
});

test("runLinkAllowed: Run paths need run.access and loaded entitlements; Grow paths always allowed", () => {
  assert.equal(runLinkAllowed("/properties/7", GROW_ONLY, false), false);
  assert.equal(runLinkAllowed("/properties/7", GROW_RUN, false), true);
  assert.equal(runLinkAllowed("/properties/7", GROW_RUN, true), false);
  assert.equal(runLinkAllowed("/properties/7", undefined, false), false);
  assert.equal(runLinkAllowed("/grow/appraisals/7", GROW_ONLY, false), true);
});

test("Grow-facing pages route every Run link through RunGatedLink (no raw <Link> to Run paths)", () => {
  const files = ["../../pages/Grow.tsx", "../../pages/AppraisalWorkspace.tsx", "../../components/PropertyIntelligencePanel.tsx"];
  const raw = /<Link\s+href=\{?[`"'](\/properties|\/today|\/exceptions|\/financial|\/pit-crew|\/["'`])/;
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.equal(raw.test(src), false, `${f} still has a raw Link into a Run page`);
    assert.match(src, /RunGatedLink/, `${f} should use RunGatedLink`);
  }
});
