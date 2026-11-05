// Owner t275u: the desktop carries Pit Crew's recorded contact-owner authority; the
// relationship UI follows it. The server validates and audits (API tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { actingAuthorityHeaders, getActingAuthority, setActingAuthority, validActingAuthority } from "../actingAuthority";
import { canManageRelationships } from "../relationshipPermission";

const has = (keys: string[]) => (k: string) => keys.includes(k);

test("t275u: authority needs an owner id and a 3-200 character instruction reference", () => {
  assert.equal(validActingAuthority({ ownerId: 2, ownerName: "Ava", authorityRef: "ab" }), false);
  assert.equal(validActingAuthority({ ownerId: 0, ownerName: "Ava", authorityRef: "INS-1" }), false);
  assert.equal(validActingAuthority({ ownerId: 2, ownerName: "Ava", authorityRef: "INS-1" }), true);
});

test("t275u: headers are sent only while acting; clearing stops them", () => {
  setActingAuthority(null);
  assert.deepEqual(actingAuthorityHeaders(), {});
  setActingAuthority({ ownerId: 2, ownerName: "Ava", authorityRef: " INS-1 " });
  assert.deepEqual(actingAuthorityHeaders(), { "X-AE-On-Behalf-Of": "2", "X-AE-Authority-Ref": "INS-1" });
  setActingAuthority(null);
  assert.equal(getActingAuthority(), null);
});

test("t275u: Pit Crew may manage relationships only while acting; brokerage entitlement alone grants nothing; agents unchanged", () => {
  const all = has(["run.access", "grow.relationships.manage"]);
  assert.equal(canManageRelationships(all, "Pit Crew", null), false);
  assert.equal(canManageRelationships(has([]), "Pit Crew", { ownerId: 2, ownerName: "Ava", authorityRef: "INS-1" }), true);
  assert.equal(canManageRelationships(has(["run.access"]), "Agent", null), true);
  assert.equal(canManageRelationships(has(["grow.contacts.read"]), "Agent", null), false);
});

test("t275u: Ask AE / Business Coach surfaces say agent-only when the server refuses the role", async () => {
  const { aiAgentOnlyRefused, aiSurfaceAvailability, aiSurfaceUnavailableCopy } = await import("../aiCapability");
  const refused = { copilotEnabled: false, businessCoachEnabled: false, agentAiAllowed: false };
  assert.equal(aiAgentOnlyRefused(refused), true);
  assert.equal(aiSurfaceAvailability(refused, { isGrow: true, isCoach: true }), "unavailable");
  assert.equal(aiSurfaceAvailability(refused, { isGrow: false, isCoach: false }), "hidden", "Run/Home copilot panel hidden");
  assert.match(aiSurfaceUnavailableCopy(true, true).body, /agents only/);
  assert.equal(aiAgentOnlyRefused({ copilotEnabled: true, businessCoachEnabled: true, agentAiAllowed: true }), false);
});
