import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProductNavLinks, hasEntitlement, navLinkIsActive, resolveLandingRoute } from "../productNav";
import { buildClassicNavLinks } from "../../minimal/minimalNav";

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

test("navLinkIsActive: Grow stays highlighted on the appraisal list, workspace and builder (BLOCKED_ON_GROK #1)", () => {
  for (const p of ["/grow/appraisals", "/grow/appraisals?view=full", "/grow/appraisals/12", "/grow/appraisals/12/build"]) {
    assert.equal(navLinkIsActive(p, "/grow"), true, p);
  }
  assert.equal(navLinkIsActive("/grow/appraisals/12/other", "/grow"), false);
  assert.equal(navLinkIsActive("/grow/import", "/grow"), false);
  assert.equal(navLinkIsActive("/grow/appraisals", "/properties"), false);
});

// #34 — Offer Centre link. Gated on the run.access entitlement (the same key
// GET /api/offers/centre requires) for Agents and Brokerage Administrators. Placed after Pit Crew and
// before Settings; Grow stays first.
test("Offer Centre link is visible with run.access and hidden without it", () => {
  for (const role of ["Agent", "Brokerage Administrator"]) {
    const withRun = buildProductNavLinks({ role, entitlements: ["run.access"] });
    assert.ok(withRun.some((l) => l.path === "/offers" && l.label === "Offer Centre"), `visible for ${role} with run.access`);
    assert.equal(withRun[0]?.path, "/grow");
    assert.equal(withRun[withRun.length - 1]?.path, "/settings");
    const without = buildProductNavLinks({ role, entitlements: ["grow.access"] });
    assert.ok(!without.some((l) => l.path === "/offers"), `hidden for ${role} without run.access`);
  }
});

// #34 rebase onto a7b2b0ef (Owner D5 classic nav): the Offer Centre link is a
// Run link. Grow-only brokerages never see it; Run-entitled ones see it after
// Pit Crew and before Settings, with every existing entry, order and label unchanged.
test("classic nav: Offer Centre only with run.access; Grow-only nav is unchanged", () => {
  const growOnly = buildClassicNavLinks({ role: "Brokerage Administrator", entitlements: ["grow.access"] });
  assert.ok(!growOnly.some((l) => l.path === "/offers"), "Grow-only: no Offer Centre");
  assert.deepEqual(
    growOnly.map((l) => `${l.path}|${l.label}`),
    ["/grow|Grow", "/communications|Communications", "/settings|Settings"],
    "Grow-only classic sidebar is exactly the staging a7b2b0ef list",
  );
  const both = buildProductNavLinks({ role: "Brokerage Administrator", entitlements: ["grow.access", "run.access"] });
  assert.deepEqual(
    both.map((l) => `${l.path}|${l.label}`),
    [
      "/grow|Grow",
      "/|Home",
      "/today|Today",
      "/properties|Properties",
      "/exceptions|Exceptions",
      "/communications|Communications",
      "/financial|Financial",
      "/pit-crew|Pit Crew",
      "/offers|Offer Centre",
      "/settings|Settings",
    ],
  );
  const classicBoth = buildClassicNavLinks({ role: "Agent", entitlements: ["grow.access", "run.access"] });
  assert.ok(classicBoth.some((l) => l.path === "/offers"), "Run-entitled agent sees Offer Centre in the classic sidebar");
  const withoutOffers = classicBoth.filter((l) => l.path !== "/offers").map((l) => l.path);
  assert.deepEqual(withoutOffers, ["/grow", "/", "/today", "/properties", "/exceptions", "/communications", "/settings"]);
});

// #34 / Owner t162u: offer details are confidential, so the Pit Crew role never gets the Offer Centre
// link (the API answers 403 for that role too), with or without run.access. Its other links are unchanged.
test("Offer Centre link is hidden for the Pit Crew role even with run.access", () => {
  const pc = buildProductNavLinks({ role: "Pit Crew", entitlements: ["grow.access", "run.access"] });
  assert.ok(!pc.some((l) => l.path === "/offers"), "Pit Crew: no Offer Centre");
  assert.ok(pc.some((l) => l.path === "/pit-crew"), "Pit Crew keeps its own workspace link");
  const classicPc = buildClassicNavLinks({ role: "Pit Crew", entitlements: ["grow.access", "run.access"] });
  assert.ok(!classicPc.some((l) => l.path === "/offers"), "Pit Crew classic sidebar: no Offer Centre");
  for (const role of [undefined, "Unknown"]) {
    assert.ok(!buildProductNavLinks({ role, entitlements: ["run.access"] }).some((l) => l.path === "/offers"), `no Offer Centre for role ${role}`);
  }
});
