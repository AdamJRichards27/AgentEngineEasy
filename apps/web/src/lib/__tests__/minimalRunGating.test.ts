import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildProductNavLinks } from "../productNav";
import { MINIMAL_RUN_PATHS, buildMinimalNavLinks, minimalHasRunAccess } from "../../minimal/minimalNav";
import { buildMinimalTodayModel, minimalTodayDestination } from "../../minimal/minimalTodayModel";
import { buildMinimalContactModel, type Contact360Input } from "../../minimal/minimalContactModel";
import type { GrowTodayAction, GrowTodaySummary } from "../growToday";

// Owner D5: the Minimal shell links to Run subject to permissions. Run links
// (and every in-page link into a Run screen) show only with run.access; role
// rules (Financial, Pit Crew) still apply on top. Fail closed.

const GROW_ONLY = ["grow.access", "grow.contacts.read"];
const GROW_RUN = [...GROW_ONLY, "run.access"];
const paths = (links: { path: string }[]) => links.map((l) => l.path);

test("Run paths are the Run surfaces in the product nav", () => {
  assert.deepEqual([...MINIMAL_RUN_PATHS].sort(), ["/", "/exceptions", "/financial", "/pit-crew", "/properties", "/properties/start", "/today"].sort());
});

test("without run.access the Minimal nav shows no Run link, for every role", () => {
  for (const role of ["Agent", "Brokerage Administrator", "Pit Crew", undefined]) {
    const links = paths(buildMinimalNavLinks({ role, entitlements: GROW_ONLY }));
    for (const p of MINIMAL_RUN_PATHS) assert.equal(links.includes(p), false, `${role}: ${p}`);
    assert.ok(links.includes("/grow"));
    assert.ok(links.includes("/communications"), "Communications is Grow-gated, not Run");
    assert.ok(links.includes("/settings"));
  }
});

test("with run.access the Minimal nav is the product nav plus Start property, role rules intact", () => {
  for (const role of ["Agent", "Brokerage Administrator", "Pit Crew"]) {
    const ctx = { role, entitlements: GROW_RUN };
    assert.deepEqual(paths(buildMinimalNavLinks(ctx)), [...paths(buildProductNavLinks(ctx)), "/properties/start"]);
  }
  assert.equal(paths(buildMinimalNavLinks({ role: "Agent", entitlements: GROW_RUN })).includes("/financial"), false);
  assert.equal(paths(buildMinimalNavLinks({ role: "Agent", entitlements: GROW_RUN })).includes("/pit-crew"), false);
});

test("run access is the exact run.access key", () => {
  assert.equal(minimalHasRunAccess([]), false);
  assert.equal(minimalHasRunAccess(["run.accessx", "Run.Access"]), false);
  assert.equal(minimalHasRunAccess(["run.access"]), true);
});

test("MinimalShell builds its links from buildMinimalNavLinks, never the raw product nav", () => {
  const shell = readFileSync(new URL("../../minimal/MinimalShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /buildMinimalNavLinks\(\{ role: user\.role, entitlements \}\)/);
  assert.doesNotMatch(shell, /buildProductNavLinks/);
  assert.doesNotMatch(shell, /href="\/properties\/start"/, "Start property comes from the gated list");
});

// ── Today ───────────────────────────────────────────────────────────────────
const propertyAction = {
  id: "signal:1", type: "property_intelligence_signal", priority: "DoNow", partyId: null, contactName: "",
  contactEmail: null, contactMobile: null, relationshipType: null, propertyId: 3, propertyLabel: "18 Campbell St",
  opportunityId: null, appraisalId: null, commitmentId: null, reason: "r", recommendedAction: "", dueAt: null,
  lastActivityAt: null, availableActions: [{ action: "view_property", propertyId: 3 }], rankScore: 1,
  confidenceBand: null, contactability: "contactable", contactabilityNote: null, whyItMatters: null,
} as unknown as GrowTodayAction;
const summary = {
  generatedAt: "2026-10-19T00:00:00Z", hasAnyGrowData: true,
  counts: { priorityActions: 1, followUpsDue: 0, openOpportunities: 0, contactsNeedingAttention: 0 },
  priorityActions: [propertyAction], signalSummary: { surfaced: 1, emergingSurfaced: 0, emergingWithheld: 0, withheldDoNotContact: 0 },
} as GrowTodaySummary;
const NOW = new Date("2026-10-19T01:00:00Z");

test("Today: 'Open property' and the Run Command Centre link need run.access", () => {
  assert.equal(minimalTodayDestination(propertyAction), null, "fails closed with no access argument");
  assert.equal(minimalTodayDestination(propertyAction, undefined, true)?.href, "/properties/3");
  const without = buildMinimalTodayModel(summary, NOW, (k) => GROW_ONLY.includes(k));
  assert.equal(without.hero?.destination, null);
  assert.equal(without.runCrossLink, null);
  const withRun = buildMinimalTodayModel(summary, NOW, (k) => GROW_RUN.includes(k));
  assert.equal(withRun.hero?.destination?.href, "/properties/3");
  assert.equal(withRun.runCrossLink?.href, "/today");
  const screen = readFileSync(new URL("../../minimal/MinimalToday.tsx", import.meta.url), "utf8");
  assert.match(screen, /model\.runCrossLink \?/);
  assert.doesNotMatch(screen, /growTodayCrossLink/);
});

// ── Contact 360 ─────────────────────────────────────────────────────────────
const contact: Contact360Input = {
  contact: { id: 9, displayName: "Ada Allow", email: null, mobile: null },
  roles: [],
  properties: [{ relationshipId: 1, propertyId: 3, propertyAddress: "18 Campbell St", relationshipType: "Owner", status: "Active", isPrimary: true }],
  opportunities: [], activities: [],
  intelligence: { nextFollowUpAt: null, nextFollowUpDescription: null, daysSinceLastInteraction: null },
};

test("Contact 360: linked properties link to the Run workspace only with run.access", () => {
  assert.equal(buildMinimalContactModel(contact).properties[0].href, null, "fails closed by default");
  assert.equal(buildMinimalContactModel(contact, { runAccess: false }).properties[0].href, null);
  assert.equal(buildMinimalContactModel(contact, { runAccess: true }).properties[0].href, "/properties/3");
  assert.equal(buildMinimalContactModel(contact).properties[0].label, "18 Campbell St", "the address still shows");
  const screen = readFileSync(new URL("../../minimal/MinimalContact360.tsx", import.meta.url), "utf8");
  assert.match(screen, /buildMinimalContactModel\(detail\.data, \{ runAccess: hasEntitlement\("run\.access"\) \}\)/);
});
