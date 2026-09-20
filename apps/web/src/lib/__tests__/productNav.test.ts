import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProductNavGroups,
  buildProductNavLinks,
  buildQuickActions,
  hasEntitlement,
  resolveLandingRoute,
} from "../productNav";

// Pure-logic tests for the central product navigation/landing definition. No React, no network.

test("Today is standalone and grouped navigation follows the product hierarchy", () => {
  const groups = buildProductNavGroups({ role: "Agent", entitlements: ["grow.access"] });
  assert.deepEqual(
    groups.map((group) => group.id),
    ["today", "grow", "run", "support", "system"],
  );
  assert.equal(groups[0]?.standalone, true);
  assert.deepEqual(groups[0]?.links.map((link) => link.path), ["/today"]);
  assert.deepEqual(groups[2]?.links.map((link) => link.path), ["/", "/properties", "/exceptions"]);
  assert.ok(groups[1]?.links.some((link) => link.path === "/communications"));
  assert.ok(!groups[2]?.links.some((link) => link.path === "/communications"));
});

test("Communications remains ungated while moving into the Grow group", () => {
  const groups = buildProductNavGroups({ role: "Agent", entitlements: [] });
  const grow = groups.find((group) => group.id === "grow");
  assert.ok(grow?.links.some((link) => link.path === "/communications"));
});

test("Grow links point at existing tab state and pages, without fabricated routes", () => {
  const grow = buildProductNavGroups({
    role: "Agent",
    entitlements: ["grow.access", "grow.import.review"],
  }).find((group) => group.id === "grow");
  assert.deepEqual(grow?.links.map((link) => link.path), [
    "/grow?tab=today",
    "/grow?tab=opportunities",
    "/grow?tab=contacts",
    "/grow?tab=nurture",
    "/grow?tab=performance",
    "/grow?tab=askAE",
    "/communications",
    "/grow/import",
  ]);
  assert.ok(grow?.links.every((link) => link.path.startsWith("/grow") || link.path === "/communications"));
});

test("flat compatibility links preserve all grouped destinations", () => {
  const roles = ["Agent", "Pit Crew", "Brokerage Administrator", undefined];
  for (const role of roles) {
    const links = buildProductNavLinks({ role, entitlements: [] });
    assert.equal(links[0]?.path, "/today", `Today must be first for role=${role}`);
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

test("resolveLandingRoute: a Run-only configuration falls back to Today", () => {
  assert.equal(resolveLandingRoute({ role: "Agent", entitlements: ["run.access"] }), "/today");
});

test("resolveLandingRoute: no entitlements at all falls back to Today", () => {
  assert.equal(resolveLandingRoute({ role: "Agent", entitlements: [] }), "/today");
});

test("resolveLandingRoute: Pit Crew never lands in Grow, even when Grow-entitled (must not break operational routing)", () => {
  assert.equal(resolveLandingRoute({ role: "Pit Crew", entitlements: ["grow.access", "run.access"] }), "/");
});

test("resolveLandingRoute: Brokerage Administrator follows the same entitlement rule as any other non-Pit-Crew role", () => {
  assert.equal(resolveLandingRoute({ role: "Brokerage Administrator", entitlements: ["grow.access"] }), "/grow");
  assert.equal(resolveLandingRoute({ role: "Brokerage Administrator", entitlements: ["run.access"] }), "/today");
});

test("Quick actions start with the actual property workflow and omit unsupported create shortcuts", () => {
  const actions = buildQuickActions({ role: "Agent", entitlements: [] });
  assert.equal(actions[0]?.path, "/properties/start");
  assert.deepEqual(actions.map((action) => action.path), ["/properties/start"]);
  assert.ok(!actions.some((action) => /create contact|create opportunity/i.test(action.label)));
});

test("Import quick action requires Grow access and execute permission, not review alone", () => {
  assert.deepEqual(
    buildQuickActions({ role: "Agent", entitlements: ["grow.access", "grow.import.review"] }).map((action) => action.path),
    ["/properties/start"],
  );
  assert.ok(
    buildQuickActions({ role: "Agent", entitlements: ["grow.access", "grow.import.execute"] }).some(
      (action) => action.path === "/grow/import",
    ),
  );
  assert.ok(
    !buildQuickActions({ role: "Agent", entitlements: ["grow.access"] }).some((action) => action.path === "/grow/import"),
  );
  assert.ok(!buildQuickActions({ role: "Agent", entitlements: [] }).some((action) => action.path === "/grow/import"));
});
