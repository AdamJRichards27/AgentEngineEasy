// WS2 — AE Minimal A Properties: cards from the existing GET /properties,
// GET /grow/appraisals/pipeline and GET /grow/opportunities, and the
// "Create Appraisal" resolution (feasibility item 8, D8 linked-contact path).
// AE keeps one appraisal per property (getOrCreateAppraisal), so the
// prototype's "create a new one anyway" choice is not offered.
import assert from "node:assert/strict";
import test from "node:test";
import type { AppraisalListRow } from "../appraisalUi";
import {
  buildMinimalPropertyCards,
  propertyLocationLine,
  propertyRelationshipsPath,
  resolveCreateAppraisal,
  selectPropertiesView,
  type MinimalPropertyRelationship,
  type MinimalPropertyRow,
} from "../../minimal/properties/minimalPropertiesModel";

const prop = (id: number, over: Partial<MinimalPropertyRow> = {}): MinimalPropertyRow => ({
  id,
  formattedAddress: `${id} Park Rd, Milton QLD 4064`,
  suburb: "Milton",
  state: "QLD",
  postcode: "4064",
  workflowStage: "Appraisal",
  listingStatus: "Not Listed",
  ...over,
});

const row = (over: Partial<AppraisalListRow>): AppraisalListRow => ({
  id: 1,
  status: "DRAFT",
  outcome: null,
  propertyId: 1,
  propertyAddress: "1 Park Rd",
  partyId: 3,
  partyDisplayName: "Jo Smith",
  ownerUserId: 1,
  ownerName: "Adam",
  ...over,
});

const rel = (partyId: number, propertyId: number | null, over: Partial<MinimalPropertyRelationship> = {}): MinimalPropertyRelationship => ({
  partyId,
  propertyId,
  status: "Active",
  role: "Owner",
  partyFirstName: `First${partyId}`,
  partyLastName: `Last${partyId}`,
  partyOrganisationName: null,
  ...over,
});

test("location line uses suburb, state and postcode, skipping blanks", () => {
  assert.equal(propertyLocationLine(prop(1)), "Milton QLD 4064");
  assert.equal(propertyLocationLine(prop(1, { suburb: null, state: "QLD", postcode: null })), "QLD");
  assert.equal(propertyLocationLine(prop(1, { suburb: null, state: null, postcode: null })), "Location not recorded");
});

test("cards carry stage, appraisal and open-opportunity counts from existing data only", () => {
  const cards = buildMinimalPropertyCards(
    [prop(1), prop(2, { listingStatus: "Listed", workflowStage: "Live" })],
    [row({ id: 10, propertyId: 1, status: "PRESENTED" })],
    [
      { id: 5, propertyId: 1, status: "Open" },
      { id: 6, propertyId: 1, status: "Lost" },
      { id: 7, propertyId: 2, status: "Open" },
      { id: 8, propertyId: null, status: "Open" },
    ],
  );
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], {
    id: 1,
    address: "1 Park Rd, Milton QLD 4064",
    location: "Milton QLD 4064",
    stage: "Appraisal",
    listingStatus: "Not Listed",
    href: "/properties/1",
    appraisal: { id: 10, statusLabel: "Presented", href: "/grow/appraisals/10", closed: false },
    openOpportunityCount: 1,
  });
  assert.equal(cards[1].appraisal, null);
  assert.equal(cards[1].openOpportunityCount, 1);
});

test("Create Appraisal: an open appraisal on the property is opened, never duplicated", () => {
  const r = resolveCreateAppraisal(1, [row({ id: 10, propertyId: 1 })], [rel(3, 1)]);
  assert.deepEqual(r, { kind: "existing", appraisalId: 10, contactName: "Jo Smith", builderHref: "/grow/appraisals/10/build" });
});

test("Create Appraisal: a finished appraisal blocks a new one with an explanation", () => {
  const r = resolveCreateAppraisal(1, [row({ id: 10, propertyId: 1, status: "WON" })], [rel(3, 1)]);
  assert.equal(r.kind, "closed");
  if (r.kind === "closed") {
    assert.equal(r.appraisalId, 10);
    assert.match(r.message, /one appraisal/i);
  }
});

test("Create Appraisal: one active linked contact starts from-contact directly", () => {
  const r = resolveCreateAppraisal(1, [], [rel(3, 1), rel(3, 1, { role: "Seller" }), rel(4, 2), rel(5, 1, { status: "Historical" })]);
  assert.deepEqual(r, { kind: "start", body: { partyId: 3, propertyId: 1, entry: "property" } });
});

test("Create Appraisal: several linked contacts ask the agent to choose", () => {
  const r = resolveCreateAppraisal(1, [], [rel(3, 1), rel(4, 1, { partyFirstName: null, partyLastName: null, partyOrganisationName: "Acme Pty Ltd" })]);
  assert.deepEqual(r, {
    kind: "choose",
    choices: [
      { partyId: 3, label: "First3 Last3 · Owner" },
      { partyId: 4, label: "Acme Pty Ltd · Owner" },
    ],
    propertyId: 1,
  });
});

test("Create Appraisal: no linked contact explains the next step", () => {
  const r = resolveCreateAppraisal(1, [], [rel(3, 2)]);
  assert.equal(r.kind, "no-contact");
  if (r.kind === "no-contact") assert.match(r.message, /link a contact/i);
});

test("relationships lookup reuses the existing search by address", () => {
  assert.equal(
    propertyRelationshipsPath("1 Park Rd, Milton QLD 4064"),
    "/grow/relationships?search=1%20Park%20Rd%2C%20Milton%20QLD%204064&limit=100",
  );
});

test("flag-gated view selector", () => {
  assert.equal(selectPropertiesView(false), "classic");
  assert.equal(selectPropertiesView(true), "minimal");
  assert.equal(selectPropertiesView(true, "?view=full"), "classic");
  assert.equal(selectPropertiesView(false, "?view=minimal"), "classic");
});
