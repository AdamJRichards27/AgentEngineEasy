import { test } from "node:test";
import assert from "node:assert/strict";
import { MobileMoreView } from "../../minimal/mobile/MobileMoreView";
import { applyAiAvailability } from "../../minimal/mobile/mobileCoachAvailability";
import { ASK_AE_LABEL, BUSINESS_COACH_LABEL, buildMobileNav } from "../../minimal/mobile/mobileNavModel";
import { GROW_WRITE_KEYS, agentToolsOffered, isReadOnlyUser, mobilePermissions } from "../../minimal/mobile/mobilePermissions";
import { text } from "./mobileTreeHelpers";

// AE 2.0, mobile More: Business Coach and Ask AE are AGENT tools. Offered to a user who is an Agent (the role), holds grow.ai.use, and is not read-only.
// Never to a Pit Crew or read-only user, and never inherited by a Brokerage Administrator, even where the brokerage's subscription hands grow.ai.use to
// every user in it (that is the case that matters: the entitlement alone does not distinguish the roles). Display only: the API enforces what it enforces.

const ALL_GROW = ["grow.access", "grow.contacts.read", "grow.contacts.manage", "grow.activities.manage", "grow.relationships.manage", "grow.opportunities.manage", "grow.properties.link", "grow.ai.use"];
const READ_ONLY = ["grow.access", "grow.contacts.read", "grow.ai.use"]; // reads, and the AI key reaches them through the brokerage's subscription
const WITH_RUN = [...ALL_GROW, "run.access"];
const nav = (role: string | undefined, entitlements: string[] | null) => buildMobileNav({ role, entitlements, momentumAvailable: true, marketActivityAvailable: false });
const labels = (role: string | undefined, entitlements: string[] | null) => nav(role, entitlements).more.map((i) => i.label);
const tools = (role: string | undefined, entitlements: string[] | null) => [labels(role, entitlements).includes(BUSINESS_COACH_LABEL), labels(role, entitlements).includes(ASK_AE_LABEL)];

test("an AGENT who can change things, holding grow.ai.use, is offered both tools", () => {
  assert.deepEqual(tools("Agent", ALL_GROW), [true, true]);
  assert.deepEqual(tools("Agent", WITH_RUN), [true, true], "also in a Run brokerage");
});

test("a Brokerage Administrator does NOT inherit the agent tools, whatever the brokerage subscription grants", () => {
  assert.deepEqual(tools("Brokerage Administrator", ALL_GROW), [false, false]);
  assert.deepEqual(tools("Brokerage Administrator", WITH_RUN), [false, false]);
});

test("a Pit Crew user does not get them, whatever the brokerage subscription grants", () => {
  assert.deepEqual(tools("Pit Crew", ALL_GROW), [false, false]);
  assert.deepEqual(tools("Pit Crew", WITH_RUN), [false, false]);
  assert.deepEqual(tools("Pit Crew", ["run.access"]), [false, false]);
});

test("a read-only user does not get them, even as an Agent holding grow.ai.use", () => {
  assert.deepEqual(tools("Agent", READ_ONLY), [false, false]);
  assert.deepEqual(tools("Agent", ["grow.access", "grow.contacts.read"]), [false, false], "and not without the key either");
});

test("fails closed: no role, an unknown role, a wrong-case role, a missing list or no key offers nothing", () => {
  const cases: Array<[string | undefined, string[] | null]> = [[undefined, ALL_GROW], ["Platform Owner", ALL_GROW], ["agent", ALL_GROW], ["Agent", null], ["Agent", ["grow.access"]], ["Agent", []]];
  for (const [role, ents] of cases) assert.deepEqual(tools(role, ents), [false, false], `${role} ${JSON.stringify(ents)}`);
  assert.equal(agentToolsOffered(null, "Agent"), false);
  assert.equal(agentToolsOffered(undefined, "Agent"), false);
});

test("the permission object and the helpers agree with the nav model for every role and entitlement combination", () => {
  const sets: Array<[string, string[]]> = [["all grow", ALL_GROW], ["with run", WITH_RUN], ["read-only", READ_ONLY], ["run only", ["run.access"]], ["none", []]];
  for (const role of ["Agent", "Brokerage Administrator", "Pit Crew", undefined, "Platform Owner"]) {
    for (const [label, ents] of sets) {
      const p = mobilePermissions(ents, role);
      assert.equal(p.businessCoach, agentToolsOffered(ents, role), `coach ${label} ${role}`);
      assert.equal(p.askAe, agentToolsOffered(ents, role), `ask ${label} ${role}`);
      assert.deepEqual(tools(role, ents), [p.businessCoach, p.askAe], `nav ${label} ${role}`);
    }
  }
});

test("read-only means holding none of the Grow write keys, and each write key alone is enough to not be read-only", () => {
  assert.equal(isReadOnlyUser(READ_ONLY), true);
  assert.equal(isReadOnlyUser([]), true);
  assert.equal(isReadOnlyUser(null), true);
  for (const key of GROW_WRITE_KEYS) assert.equal(isReadOnlyUser(["grow.access", key]), false, key);
  assert.deepEqual([...GROW_WRITE_KEYS].sort(), ["grow.activities.manage", "grow.contacts.manage", "grow.opportunities.manage", "grow.relationships.manage"]);
});

test("nothing ELSE changes: for a non-agent the AI key has NO effect on More at all; for an agent removing it removes exactly the two tools", () => {
  const without = (ents: string[]) => ents.filter((k) => k !== "grow.ai.use");
  for (const role of ["Brokerage Administrator", "Pit Crew"]) {
    assert.deepEqual(labels(role, WITH_RUN), labels(role, without(WITH_RUN)), `${role}: the key changes nothing`);
    assert.ok(labels(role, WITH_RUN).length > 0, `${role} still has More items`);
  }
  assert.deepEqual(labels("Agent", READ_ONLY), labels("Agent", without(READ_ONLY)), "read-only: the key changes nothing");
  assert.deepEqual(labels("Agent", WITH_RUN).filter((l) => l !== BUSINESS_COACH_LABEL && l !== ASK_AE_LABEL), labels("Agent", without(WITH_RUN)), "agent: exactly the two tools, nothing else");
  assert.ok(nav("Brokerage Administrator", WITH_RUN).moreGroups.some((g) => g.key === "run"), "a Brokerage Administrator keeps the Run group");
  assert.equal(nav("Agent", ["grow.access", "grow.activities.manage", "grow.ai.use"]).upgrade?.label, "Add Run", "the Add Run offer is untouched");
});

test("the rendered More page: an agent sees both tools; an administrator, Pit Crew and a read-only user see neither (and no empty heading)", () => {
  const page = (role: string, ents: string[]) => text(MobileMoreView({ nav: applyAiAvailability(nav(role, ents), { coachEnabled: true, askEnabled: true }) }));
  const agent = page("Agent", ALL_GROW);
  assert.match(agent, /Business Coach/);
  assert.match(agent, /Ask AE/);
  for (const [role, ents] of [["Brokerage Administrator", WITH_RUN], ["Pit Crew", WITH_RUN], ["Agent", READ_ONLY]] as Array<[string, string[]]>) {
    const t = page(role, ents);
    assert.doesNotMatch(t, /Business Coach/, `${role} ${ents.length}`);
    assert.doesNotMatch(t, /Ask AE/, `${role} ${ents.length}`);
  }
});

test("the tools are listed where the deployment has them: each hidden when its own probe flag is off", () => {
  const base = nav("Agent", ALL_GROW);
  const names = (on: { coachEnabled: boolean; askEnabled: boolean }) => applyAiAvailability(base, on).more.map((i) => i.label);
  assert.deepEqual([names({ coachEnabled: true, askEnabled: false }).includes(ASK_AE_LABEL), names({ coachEnabled: false, askEnabled: true }).includes(BUSINESS_COACH_LABEL)], [false, false]);
});
