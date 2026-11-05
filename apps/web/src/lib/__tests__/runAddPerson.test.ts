import assert from "node:assert/strict";
import test from "node:test";
import { validOverrideReason, createNewBody, linkExistingBody, runContactDetail, runContactName, runDuplicatePanel, shouldSearch } from "../runAddPerson";

test("t274u R03: selecting an existing contact posts partyId (no new contact fields)", () => {
  assert.deepEqual(linkExistingBody(7, 42, "Buyer"), { propertyId: 7, partyId: 42, role: "Buyer" });
});

test("t275u: create-new relies on the server's default duplicate block; Create anyway sends the recorded reason only when valid", () => {
  assert.deepEqual(createNewBody(7, { role: "Seller", firstName: "A" }), { propertyId: 7, role: "Seller", firstName: "A" });
  assert.deepEqual(createNewBody(7, {}, "  Different Lena  ").duplicateOverride, { reason: "Different Lena" });
  assert.equal("duplicateOverride" in createNewBody(7, {}, "no"), false, "a too-short reason is never sent");
  assert.equal(validOverrideReason("abcd"), false);
  assert.equal(validOverrideReason("abcde"), true);
});

test("t274u R03: duplicate panel — contactId present offers Use/Open existing; masked (no id) offers only Create anyway", () => {
  const seen = runDuplicatePanel([{ code: "POTENTIAL_DUPLICATE_CONTACT", kind: "email", contactId: 9 }], true)!;
  assert.equal(seen.existingContactId, 9);
  assert.equal(seen.canUseExisting, true);
  assert.equal(seen.openHref, "/grow/contacts/9");
  const hidden = runDuplicatePanel([{ code: "POTENTIAL_DUPLICATE_CONTACT", kind: "phone" }], true)!;
  assert.equal(hidden.existingContactId, null);
  assert.equal(hidden.canUseExisting, false);
  assert.equal(hidden.openHref, null);
  assert.equal(hidden.canCreateAnyway, true);
  assert.equal(runDuplicatePanel([], true), null);
});

test("t274u R03: result labels and search threshold", () => {
  const p = { id: 3, partyType: "Person", firstName: "Hana", lastName: "Consent", organisationName: null, email: "h***@example.com", mobile: "04** *** 111" };
  assert.equal(runContactName(p), "Hana Consent");
  assert.equal(runContactDetail(p), "h***@example.com · 04** *** 111");
  assert.equal(runContactName({ ...p, firstName: null, lastName: null, organisationName: "Acme" }), "Acme");
  assert.equal(shouldSearch("h"), false);
  assert.equal(shouldSearch(" ha "), true);
});
