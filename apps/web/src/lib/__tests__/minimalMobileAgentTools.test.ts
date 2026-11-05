import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MobileMoreView } from "../../minimal/mobile/MobileMoreView";
import { aiAvailabilityFrom, applyAiAvailability, type AiCapabilitiesAnswer } from "../../minimal/mobile/mobileCoachAvailability";
import { ASK_AE_LABEL, BUSINESS_COACH_LABEL, buildMobileNav } from "../../minimal/mobile/mobileNavModel";
import { aiToolsMayBeOffered } from "../../minimal/mobile/mobilePermissions";
import { text } from "./mobileTreeHelpers";

// AE 2.0, mobile More. Who may use Ask AE and the Business Coach is the SERVER's decision (apps/api lib/agentAiAccess.ts: an Agent, or an
// administrator on AE_AGENT_AI_ADMIN_USER_IDS; never Pit Crew or a read-only user), exposed by GET /ai/capabilities as agentAiAllowed, copilotEnabled and
// businessCoachEnabled (the last two already combined with it). The phone lists a tool exactly when the server says so. It re-derives no role or
// read-only rule: these tests pin that, for every role the phone could meet.
const KEYS = ["grow.access", "grow.contacts.read", "grow.activities.manage", "grow.ai.use"];
const ROLES = ["Agent", "Brokerage Administrator", "Pit Crew", "Platform Owner", undefined];
const ALLOWED: AiCapabilitiesAnswer = { agentAiAllowed: true, copilotEnabled: true, businessCoachEnabled: true };
const REFUSED = (why: string): AiCapabilitiesAnswer => ({ agentAiAllowed: false, agentAiRefusal: why, copilotEnabled: false, businessCoachEnabled: false } as AiCapabilitiesAnswer);
const nav = (role: string | undefined, entitlements: string[] | null) => buildMobileNav({ role, entitlements, momentumAvailable: true, marketActivityAvailable: false });
const shown = (role: string | undefined, ents: string[] | null, answer: AiCapabilitiesAnswer | null | undefined) => {
  const labels = applyAiAvailability(nav(role, ents), aiAvailabilityFrom(answer)).more.map((i) => i.label);
  return [labels.includes(BUSINESS_COACH_LABEL), labels.includes(ASK_AE_LABEL)];
};

test("when the server allows the tools they are shown, whatever the role: an allow-listed administrator sees them exactly as an Agent does", () => {
  for (const role of ROLES) assert.deepEqual(shown(role, KEYS, ALLOWED), [true, true], String(role));
});

test("when the server refuses (Pit Crew, an administrator not on the list, a read-only user, any other reason) NOTHING is shown, even to an Agent", () => {
  for (const why of ["PIT_CREW", "ADMIN_NOT_AUTHORISED", "READ_ONLY", "ROLE"]) for (const role of ROLES) assert.deepEqual(shown(role, KEYS, REFUSED(why)), [false, false], `${why} ${role}`);
});

test("an explicit agentAiAllowed:false wins even if a flag says true; each tool follows its own flag; only a literal true shows a tool", () => {
  assert.deepEqual(shown("Agent", KEYS, { agentAiAllowed: false, copilotEnabled: true, businessCoachEnabled: true }), [false, false]);
  assert.deepEqual(shown("Agent", KEYS, { agentAiAllowed: true, copilotEnabled: true, businessCoachEnabled: false }), [false, true]);
  assert.deepEqual(shown("Agent", KEYS, { agentAiAllowed: true, copilotEnabled: false, businessCoachEnabled: true }), [true, false]);
  assert.deepEqual(shown("Agent", KEYS, { copilotEnabled: true, businessCoachEnabled: true }), [true, true], "an older server that sends no agentAiAllowed: the flags decide");
  for (const loose of ["true", 1, "yes", {}]) assert.deepEqual(shown("Agent", KEYS, { agentAiAllowed: true, copilotEnabled: loose, businessCoachEnabled: loose } as unknown as AiCapabilitiesAnswer), [false, false], String(loose));
});

test("fails closed: no answer yet, a failed probe, or no entitlement shows nothing; the probe is only asked of a user who holds the entitlement", () => {
  for (const role of ROLES) {
    assert.deepEqual(shown(role, KEYS, undefined), [false, false], `loading ${role}`);
    assert.deepEqual(shown(role, KEYS, null), [false, false], `failed ${role}`);
    assert.deepEqual(shown(role, ["grow.access", "grow.activities.manage"], ALLOWED), [false, false], `no grow.ai.use ${role}`);
    assert.deepEqual(shown(role, null, ALLOWED), [false, false], `no entitlements ${role}`);
  }
  assert.equal(aiToolsMayBeOffered(KEYS), true);
  assert.equal(aiToolsMayBeOffered(["grow.access"]), false);
  assert.equal(aiToolsMayBeOffered(null), false);
  assert.equal(aiToolsMayBeOffered(undefined), false);
});

test("the phone derives no role or read-only rule for the AI tools: the navigation is identical for every role given the same entitlements and the same answer", () => {
  const base = JSON.stringify(applyAiAvailability(nav("Agent", KEYS), aiAvailabilityFrom(ALLOWED)).more.filter((i) => i.label === BUSINESS_COACH_LABEL || i.label === ASK_AE_LABEL));
  for (const role of ROLES) assert.equal(JSON.stringify(applyAiAvailability(nav(role, KEYS), aiAvailabilityFrom(ALLOWED)).more.filter((i) => i.label === BUSINESS_COACH_LABEL || i.label === ASK_AE_LABEL)), base, String(role));
  for (const file of ["mobilePermissions.ts", "mobileNavModel.ts", "mobileCoachAvailability.ts", "useMobileNav.ts"]) {
    const src = readFileSync(new URL(`../../minimal/mobile/${file}`, import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(src, /agentToolsOffered|isReadOnlyUser|GROW_WRITE_KEYS|AGENT_ROLE|role\s*===\s*"Agent"/, `${file}: no client-side AI role rule`);
  }
});

test("the rendered More page follows the server: tools present when allowed, absent when refused, and no empty heading either way", () => {
  const page = (answer: AiCapabilitiesAnswer) => text(MobileMoreView({ nav: applyAiAvailability(nav("Brokerage Administrator", KEYS), aiAvailabilityFrom(answer)) }));
  assert.match(page(ALLOWED), /Business Coach/);
  assert.match(page(ALLOWED), /Ask AE/);
  assert.doesNotMatch(page(REFUSED("ADMIN_NOT_AUTHORISED")), /Business Coach|Ask AE/);
  assert.match(page(REFUSED("ADMIN_NOT_AUTHORISED")), /Grow/, "the Grow group is still there with its other items");
});
