// AB-3 (SPEC-03, D8): property → linked contact → appraisal entry point.
import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTACT_NOT_LINKED,
  type MinimalPropertyRelationship,
  resolveCreateAppraisal,
  resolveStartFailure,
  startAppraisalBody,
} from "../../minimal/properties/minimalPropertiesModel";

const rel = (partyId: number, over: Partial<MinimalPropertyRelationship> = {}): MinimalPropertyRelationship => ({
  partyId,
  propertyId: 7,
  status: "Active",
  role: "Owner",
  partyFirstName: `First${partyId}`,
  partyLastName: `Last${partyId}`,
  partyOrganisationName: null,
  ...over,
});

test("start body always carries entry:'property' so the server applies D8 validation", () => {
  assert.deepEqual(startAppraisalBody(3, 7), { partyId: 3, propertyId: 7, entry: "property" });
  const r = resolveCreateAppraisal(7, [], [rel(3)]);
  assert.equal(r.kind, "start");
  if (r.kind === "start") assert.equal(r.body.entry, "property");
});

test("0 linked contacts → link-contact notice, nothing started; inactive links do not count", () => {
  assert.equal(resolveCreateAppraisal(7, [], []).kind, "no-contact");
  assert.equal(resolveCreateAppraisal(7, [], [rel(3, { status: "Ended" })]).kind, "no-contact");
  assert.equal(resolveCreateAppraisal(7, [], [rel(3, { propertyId: 8 })]).kind, "no-contact");
});

test("many linked contacts → chooser with primary contact first", () => {
  const r = resolveCreateAppraisal(7, [], [rel(3), rel(4, { isPrimary: true }), rel(5)]);
  assert.equal(r.kind, "choose");
  if (r.kind === "choose") assert.deepEqual(r.choices.map((c) => c.partyId), [4, 3, 5]);
});

test("409 APPRAISAL_EXISTS opens the existing appraisal in the builder", () => {
  assert.deepEqual(resolveStartFailure({ status: 409, code: "APPRAISAL_EXISTS", appraisalId: 42 }, 7, "x"), {
    kind: "open-existing",
    builderHref: "/grow/appraisals/42/build",
  });
});

test("422 PROPERTY_CONTACT_NOT_LINKED points the agent at the property", () => {
  assert.deepEqual(resolveStartFailure({ status: 422, code: "PROPERTY_CONTACT_NOT_LINKED" }, 7, "x"), {
    kind: "notice",
    text: CONTACT_NOT_LINKED,
    href: "/properties/7",
    hrefLabel: "Open the property",
  });
});

test("404/403/other failures use the friendly fallback and never open anything", () => {
  for (const e of [{ status: 404 }, { status: 403 }, { status: 409, code: "APPRAISAL_EXISTS" }, null]) {
    assert.deepEqual(resolveStartFailure(e, 7, "fallback"), { kind: "notice", text: "fallback" });
  }
});
