import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProductNavLinks, hasEntitlement, navLinkIsActive, resolveLandingRoute } from "../productNav";

// AE GROW Priority 0.5 — Workstream 2/10: pure-logic tests for the central Grow-first
// navigation/landing definition. No React, no network — matches the task's own Workstream 10
// test list ("Grow is the first product selection", "Pit Crew routing remains correct", landing
// rules per role x entitlement combination).

test("Grow is always first, for every role", () => {
  const roles = ["Agent", "Pit Crew", "Brokerage Administrator", undefined];
  for (const role of roles) {
    const links = buildProductNavLinks({ role, entitlements: [] });
    assert.equal(links[0]?.path, "/grow", `Grow must be first for role=${role}`);
  }
});

test("Settings is always last", () => {
  const links = buildProductNavLinks({ role: "Brokerage Administrator", entitlements: [] });
  assert.equal(links[links.length - 1]?.path, "/settings");
});

test("every pre-existing RUN nav path is still present for a Brokerage Administrator", () => {
  const links = buildProductNavLinks({ role: "Brokerage Administrator", entitlements: [] }).map((l) => l.path);
  for (const expected of ["/", "/today", "/properties", "/exceptions", "/communications", "/financial", "/pit-crew", "/settings"]) {
    assert.ok(links.includes(expected), `expected ${expected} in nav links`);
  }
});

test("Financial is visible only to Brokerage Administrator", () => {
  assert.ok(buildProductNavLinks({ role: "Brokerage Administrator", entitlements: [] }).some((l) => l.path === "/financial"));
  assert.ok(!buildProductNavLinks({ role: "Agent", entitlements: [] }).some((l) => l.path === "/financial"));
  assert.ok(!buildProductNavLinks({ role: "Pit Crew", entitlements: [] }).some((l) => l.path === "/financial"));
});

test("Pit Crew link is visible only to Pit Crew and Brokerage Administrator", () => {
  assert.ok(buildProductNavLinks({ role: "Pit Crew", entitlements: [] }).some((l) => l.path === "/pit-crew"));
  assert.ok(buildProductNavLinks({ role: "Brokerage Administrator", entitlements: [] }).some((l) => l.path === "/pit-crew"));
  assert.ok(!buildProductNavLinks({ role: "Agent", entitlements: [] }).some((l) => l.path === "/pit-crew"));
});

test("hasEntitlement checks the entitlements array", () => {
  assert.equal(hasEntitlement({ role: "Agent", entitlements: ["grow.access"] }, "grow.access"), true);
  assert.equal(hasEntitlement({ role: "Agent", entitlements: [] }, "grow.access"), false);
});

test("resolveLandingRoute: a Grow-only agent lands in Grow", () => {
  assert.equal(resolveLandingRoute({ role: "Agent", entitlements: ["grow.access"] }), "/grow");
});

test("resolveLandingRoute: a Grow + Run agent still lands in Grow (never forced through Run first)", () => {
  assert.equal(resolveLandingRoute({ role: "Agent", entitlements: ["grow.access", "run.access"] }), "/grow");
});

test("resolveLandingRoute: a Run-only legacy configuration falls back to the existing home route", () => {
  assert.equal(resolveLandingRoute({ role: "Agent", entitlements: ["run.access"] }), "/");
});

test("resolveLandingRoute: no entitlements at all falls back to the existing home route", () => {
  assert.equal(resolveLandingRoute({ role: "Agent", entitlements: [] }), "/");
});

test("resolveLandingRoute: Pit Crew never lands in Grow, even when Grow-entitled (must not break operational routing)", () => {
  assert.equal(resolveLandingRoute({ role: "Pit Crew", entitlements: ["grow.access", "run.access"] }), "/");
});

test("resolveLandingRoute: Brokerage Administrator follows the same entitlement rule as any other non-Pit-Crew role", () => {
  assert.equal(resolveLandingRoute({ role: "Brokerage Administrator", entitlements: ["grow.access"] }), "/grow");
  assert.equal(resolveLandingRoute({ role: "Brokerage Administrator", entitlements: ["run.access"] }), "/");
});

test("Grow stays highlighted on Contact 360 and not on other pages", () => {
  assert.equal(navLinkIsActive("/grow", "/grow"), true);
  assert.equal(navLinkIsActive("/grow/contacts/18207", "/grow"), true);
  assert.equal(navLinkIsActive("/grow/contacts/18207", "/properties"), false);
  assert.equal(navLinkIsActive("/grow/import", "/grow"), false);
  assert.equal(navLinkIsActive("/properties/12", "/properties"), false);
  assert.equal(navLinkIsActive("/properties/12", "/grow"), false);
});
