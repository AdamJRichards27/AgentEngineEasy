// CC #25/#26 — route precedence for the Minimal detail pages and the Grow nav highlight.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { navLinkIsActive } from "../productNav";
import { buildMinimalPropertyCards } from "../../minimal/properties/minimalPropertiesModel";
import { buildPipelineBoard } from "../../minimal/opportunities/minimalOpportunitiesModel";

const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
const routesSrc = app.slice(app.indexOf("function AuthenticatedRoutes"));
const ROUTE_PATHS = [...routesSrc.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);

// wouter (non-nested Route in a Switch): exact match, ":name" = one segment, first match wins.
function toRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z]+/g, "[^/]+")}/?$`, "i");
}
function firstMatch(path: string): string | undefined {
  return ROUTE_PATHS.find((p) => toRegex(p).test(path));
}

test("Minimal detail routes are declared before /grow and /grow/opportunities", () => {
  const i = (p: string) => ROUTE_PATHS.indexOf(p);
  assert.ok(i("/grow/properties/:id") >= 0 && i("/grow/opportunities/:id") >= 0, "both routes present");
  assert.ok(i("/grow/properties/:id") < i("/grow"));
  assert.ok(i("/grow/opportunities/:id") < i("/grow"));
  assert.ok(i("/grow/opportunities/:id") < i("/grow/opportunities"));
});

test("first-match routing sends each URL to the intended route", () => {
  const cases: Record<string, string> = {
    "/grow/properties/7": "/grow/properties/:id",
    "/grow/opportunities/11": "/grow/opportunities/:id",
    "/grow/opportunities": "/grow/opportunities",
    "/grow": "/grow",
    "/grow/contacts/3": "/grow/contacts/:id",
    "/grow/appraisals/5/build": "/grow/appraisals/:id/build",
    "/properties/7": "/properties/:id",
    "/properties/start": "/properties/start",
    "/properties": "/properties",
  };
  for (const [url, route] of Object.entries(cases)) assert.equal(firstMatch(url), route, url);
});

test("detail routes are lazy, behind the Minimal selector, with classic fallbacks", () => {
  assert.match(app, /const MinimalPropertyDetail = lazy\(\(\) => import\("\.\/minimal\/properties\/MinimalPropertyDetail"\)\)/);
  assert.match(app, /const MinimalOpportunityDetail = lazy\(\(\) => import\("\.\/minimal\/opportunities\/MinimalOpportunityDetail"\)\)/);
  assert.match(app, /selectPropertyDetailView\(minimalShell, search\) === "minimal" \? \(\s*<MinimalPropertyDetail \/>\s*\) : \(\s*<Redirect to=\{`\/properties\/\$\{params\.id\}`\} replace \/>/);
  assert.match(app, /selectOpportunityDetailView\(minimalShell, search\) === "minimal" \? \(\s*<MinimalOpportunityDetail \/>\s*\) : \(\s*<Redirect to="\/grow\?tab=opportunities" replace \/>/);
});

test("Grow stays highlighted on the Minimal property and opportunity pages", () => {
  for (const p of ["/grow/properties/7", "/grow/properties/7/", "/grow/properties/7?view=full", "/grow/opportunities", "/grow/opportunities/11", "/grow/opportunities/11#x"]) {
    assert.equal(navLinkIsActive(p, "/grow"), true, p);
    assert.equal(navLinkIsActive(p, "/properties"), false, p);
  }
  for (const p of ["/grow/properties", "/grow/properties/7/edit", "/grow/opportunities/11/other", "/grow/import"]) {
    assert.equal(navLinkIsActive(p, "/grow"), false, p);
  }
  assert.equal(navLinkIsActive("/properties/7", "/properties"), false, "Run property workspace stays exact (unchanged)");
});

test("list cards link into the Minimal detail pages", () => {
  const [card] = buildMinimalPropertyCards(
    [{ id: 4, formattedAddress: "4 Synthetic Rd", suburb: null, state: null, postcode: null, workflowStage: "Appraisal", listingStatus: "Not Listed" }],
    [],
    [],
  );
  assert.equal(card.href, "/grow/properties/4");
  const board = buildPipelineBoard([
    { id: 9, partyId: 2, propertyId: 4, opportunityType: "Listing", status: "Open", stage: "New", reason: null, nextActionDueAt: null, recommendedNextAction: null, convertedAppraisalId: null, contactName: "Syn" },
  ]);
  const c = board.find((col) => col.key === "New")!.cards[0];
  assert.equal(c.href, "/grow/opportunities/9");
  assert.equal(c.propertyHref, "/grow/properties/4");
});
