import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { selectAppraisalBuilderView, builderPath } from "../../minimal/appraisal/appraisalBuilderModel";

// AB-1: the WS2 Minimal pages are routed in App.tsx behind the Minimal shell
// gate, with the classic page as the fallback.

const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");

test("AB-1: the builder route exists, is lazy, and is declared before /grow/appraisals/:id", () => {
  const build = app.indexOf('<Route path="/grow/appraisals/:id/build">');
  const detail = app.indexOf('<Route path="/grow/appraisals/:id" ');
  assert.ok(build > 0, "builder route present");
  assert.ok(detail > build, "the /build route must precede /:id so wouter matches it");
  assert.match(app, /const MinimalAppraisalBuilder = lazy\(\(\) => import\("\.\/minimal\/appraisal\/MinimalAppraisalBuilder"\)\)/);
  assert.match(app, /selectAppraisalBuilderView\(minimalShell\) === "minimal" \? <MinimalAppraisalBuilder \/> : <AppraisalWorkspace \/>/);
});

test("AB-1: Minimal Properties and Opportunities are routed with classic fallbacks", () => {
  assert.match(app, /selectPropertiesView\(minimalShell, search\) === "minimal" \? <MinimalProperties \/> : <PropertiesList \/>/);
  assert.match(app, /selectOpportunitiesView\(minimalShell, search\) === "minimal" \? <MinimalOpportunities \/> : <Redirect to="\/grow\?tab=opportunities" replace \/>/);
});

test("AB-1: outside the Minimal shell the builder path renders the classic workspace", () => {
  assert.equal(selectAppraisalBuilderView(false), "classic");
  assert.equal(selectAppraisalBuilderView(true), "minimal");
  assert.equal(builderPath(12), "/grow/appraisals/12/build");
});
