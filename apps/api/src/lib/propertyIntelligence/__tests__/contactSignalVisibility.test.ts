// AE GROW Completion W2-B (E-4) — Contact 360 must not silently withhold the
// contact's own signals.
//
// getContactPropertyIntelligenceSummary fetches every Active signal anchored to
// the party and then used to drop them through two silent paths:
//
//   1. `if (s.propertyId === null) continue` — a signal anchored to the contact
//      alone. packages/db/src/schema/propertyIntelligence.ts declares BOTH
//      anchors nullable with no CHECK requiring either, so this row is legal.
//   2. bucketing by propertyId, then only ever emitting entries built from
//      Active grow_relationships rows — so a signal about a property the
//      contact has no recorded relationship against rendered nowhere.
//
// (2) is fixed here: the property is emitted as its own entry, flagged
// SIGNAL_ONLY so nothing claims a relationship the agent never recorded.
//
// (1) was W2-B's KNOWN GAP and is closed by W2-D, which replaced the
// `continue` with a three-way classification off the rule registry. This suite
// keeps proving the W2-B behaviour against the new response shape
// (`summary.properties`); the contact-anchored and unusable categories are
// covered by ./contactAnchoredSignals.test.ts.
//
// Real Postgres, real fixtures, no mocks of the module under test — the
// convention every suite in this directory follows.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, growContactDncrStatuses, growOpportunitySignals, growRelationships, parties, properties } from "@aee/db";
import {
  getContactPropertyIntelligenceSummary,
  SIGNAL_ONLY_RELATIONSHIP_TYPE,
} from "../service.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `W2B Contact Signals ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

let seq = 0;

async function createParty(label: string): Promise<number> {
  const [row] = await db
    .insert(parties)
    .values({ brokerageId: A.brokerageId, partyType: "Person", firstName: "Signal", lastName: `${label}${suffix}` })
    .returning({ id: parties.id });
  return row.id;
}

async function createProperty(label: string): Promise<number> {
  const [row] = await db
    .insert(properties)
    .values({
      brokerageId: A.brokerageId,
      agentId: A.admin.user.id,
      formattedAddress: `${label} ${suffix}`,
      state: "QLD",
      suburb: "Testville",
      postcode: "4000",
    })
    .returning({ id: properties.id });
  return row.id;
}

async function createActiveRelationship(partyId: number, propertyId: number): Promise<void> {
  await db.insert(growRelationships).values({
    brokerageId: A.brokerageId,
    partyId,
    propertyId,
    relationshipType: "owner",
    status: "Active",
  });
}

/** One Active signal, anchored however the caller asks — both anchors are nullable in the schema. */
async function createSignal(partyId: number | null, propertyId: number | null, title: string): Promise<number> {
  const [row] = await db
    .insert(growOpportunitySignals)
    .values({
      brokerageId: A.brokerageId,
      partyId,
      propertyId,
      signalType: "long_ownership_tenure",
      title,
      explanation: "Test fixture — this row exists only to prove it is not silently dropped.",
      evidence: { factors: [] },
      source: "internal",
      confidenceBand: "WorthReviewing",
      status: "Active",
      dedupeKey: `w2b-${suffix}-${seq++}`,
    })
    .returning({ id: growOpportunitySignals.id });
  return row.id;
}

test("E-4: a signal about a property the contact has no Active relationship against is still surfaced", async () => {
  const partyId = await createParty("Orphaned");
  const recordedPropertyId = await createProperty("1 Recorded St");
  const signalOnlyPropertyId = await createProperty("2 Signal Only St");
  await createActiveRelationship(partyId, recordedPropertyId);

  const recordedSignalId = await createSignal(partyId, recordedPropertyId, "Signal on a recorded property");
  // The defect: this one was bucketed by propertyId and then thrown away,
  // because no Active grow_relationships row produced an entry to attach it to.
  const orphanedSignalId = await createSignal(partyId, signalOnlyPropertyId, "Signal on an unlinked property");

  const { properties: entries } = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
  const byProperty = new Map(entries.map((e) => [e.propertyId, e]));

  const recorded = byProperty.get(recordedPropertyId);
  assert.ok(recorded, "the recorded relationship is unchanged");
  assert.equal(recorded.relationshipType, "owner", "a real relationship is still reported as itself");
  assert.deepEqual(
    recorded.activeSignals.map((s) => s.id),
    [recordedSignalId],
  );

  const signalOnly = byProperty.get(signalOnlyPropertyId);
  assert.ok(signalOnly, "a signal with no related-property entry is no longer invisible");
  assert.deepEqual(
    signalOnly.activeSignals.map((s) => s.id),
    [orphanedSignalId],
  );
  assert.equal(
    signalOnly.relationshipType,
    SIGNAL_ONLY_RELATIONSHIP_TYPE,
    "AE never claims a relationship it was not told about — the entry says the signal is the only link",
  );
  assert.match(signalOnly.propertyAddress, /2 Signal Only St/, "the property is named, not just its id");
  assert.deepEqual(signalOnly.pendingMatches, [], "the same match lookup every other entry gets");

  assert.equal(entries.length, 2, "one entry per property, never a duplicate");
});

test("E-4/W2-D: a party-anchored signal with no property never becomes a property entry", async () => {
  const partyId = await createParty("ContactAnchored");
  const propertyId = await createProperty("3 Recorded Ave");
  await createActiveRelationship(partyId, propertyId);
  await createSignal(partyId, propertyId, "Signal on the recorded property");

  const initial = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
  assert.deepEqual(initial.contactAnchoredSignals, [], "nothing contact-anchored yet");

  // Legal per the schema: both anchors are nullable, with no CHECK requiring
  // one. This fixture's type is long_ownership_tenure, which is
  // property-DEPENDENT — so W2-D classifies it as unusable, not as a
  // contact-anchored signal. See ./contactAnchoredSignals.test.ts for the
  // rule types that genuinely are contact-anchored.
  await createSignal(partyId, null, "Signal about the contact themselves");

  const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
  assert.equal(summary.properties.length, 1, "it has no property, so it cannot become a property entry");
  assert.equal(summary.unusableSignalCount, 1, "a property-dependent row with no property is counted, not surfaced");
  assert.deepEqual(summary.contactAnchoredSignals, [], "and it is never laundered into the contact-anchored list");
  // W2-D removed countContactAnchoredSignals(): the list IS the count now, so
  // the two can no longer disagree. See service.ts's removal note.
  assert.equal(
    summary.contactAnchoredSignals.length,
    0,
    "the contact-anchored list holds intelligence about a person, never a data-integrity problem",
  );
});

test("E-4: a contact with no relationships at all still sees their signals", async () => {
  const partyId = await createParty("NoRelationships");
  const propertyId = await createProperty("4 Nowhere Cl");
  const signalId = await createSignal(partyId, propertyId, "The only thing AE knows about this contact");

  const { properties: entries } = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
  assert.equal(entries.length, 1, "before this fix the response was empty and said nothing");
  assert.equal(entries[0].propertyId, propertyId);
  assert.equal(entries[0].relationshipType, SIGNAL_ONLY_RELATIONSHIP_TYPE);
  assert.deepEqual(
    entries[0].activeSignals.map((s) => s.id),
    [signalId],
  );
});

test("E-4: a non-Active relationship's property is surfaced by its signal, not by the relationship", async () => {
  const partyId = await createParty("Historical");
  const propertyId = await createProperty("5 Historical Tce");
  await db.insert(growRelationships).values({
    brokerageId: A.brokerageId,
    partyId,
    propertyId,
    relationshipType: "owner",
    status: "Historical",
  });
  await createSignal(partyId, propertyId, "Signal on a historically-owned property");

  const { properties: entries } = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].relationshipType,
    SIGNAL_ONLY_RELATIONSHIP_TYPE,
    "a Historical relationship is not an Active one — the entry must not imply it is",
  );
});

test("E-4: a signal-only entry is still brokerage-scoped", async () => {
  const B = await createBrokerageWithUsers(baseUrl, `W2B Contact Signals Other ${suffix}`);
  try {
    const partyId = await createParty("CrossTenant");
    const [foreignProperty] = await db
      .insert(properties)
      .values({
        brokerageId: B.brokerageId,
        agentId: B.admin.user.id,
        formattedAddress: `6 Other Brokerage St ${suffix}`,
        state: "QLD",
        suburb: "Testville",
        postcode: "4000",
      })
      .returning({ id: properties.id, formattedAddress: properties.formattedAddress });

    // A signal row that points at another brokerage's property should never
    // cause that property's address to be handed to this contact. It also
    // must not vanish: the row is counted, and the panel's withholding
    // notice is what says so.
    const signalId = await createSignal(partyId, foreignProperty.id, "Signal pointing across a tenancy boundary");
    const secondId = await createSignal(partyId, foreignProperty.id, "A second signal on the same foreign property");
    try {
      const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
      assert.deepEqual(summary.properties, [], "the address lookup is re-scoped, not trusted from the signal row");
      assert.deepEqual(summary.contactAnchoredSignals, [], "a property-classified row is not laundered into a contact-anchored signal");
      assert.equal(summary.unusableSignalCount, 2, "both rows are disclosed as withheld, not dropped");
      assert.equal(JSON.stringify(summary).includes(foreignProperty.formattedAddress), false, "the foreign address is not in the response");
    } finally {
      // This signal belongs to brokerage A but references one of B's
      // properties, which is the whole point of the fixture — so it has to go
      // before B can be torn down.
      await db.delete(growOpportunitySignals).where(eq(growOpportunitySignals.id, signalId));
      await db.delete(growOpportunitySignals).where(eq(growOpportunitySignals.id, secondId));
    }
  } finally {
    await cleanupBrokerages([B.brokerageId]);
  }
});

test("E-4: an in-tenant signal with no relationship stays visible beside a withheld foreign one", async () => {
  const B = await createBrokerageWithUsers(baseUrl, `W2B Contact Signals Mixed ${suffix}`);
  try {
    const partyId = await createParty("Mixed");
    const localPropertyId = await createProperty("7 Local Signal Only St");
    const localSignalId = await createSignal(partyId, localPropertyId, "Signal on an in-tenant property with no relationship");
    const [foreignProperty] = await db
      .insert(properties)
      .values({
        brokerageId: B.brokerageId,
        agentId: B.admin.user.id,
        formattedAddress: `8 Foreign Mixed St ${suffix}`,
        state: "QLD",
        suburb: "Testville",
        postcode: "4000",
      })
      .returning({ id: properties.id, formattedAddress: properties.formattedAddress });
    const foreignSignalId = await createSignal(partyId, foreignProperty.id, "Signal that must be counted, not shown");
    try {
      const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
      assert.equal(summary.properties.length, 1, "the in-tenant property is still a signal-only entry");
      assert.equal(summary.properties[0].propertyId, localPropertyId);
      assert.equal(summary.properties[0].relationshipType, SIGNAL_ONLY_RELATIONSHIP_TYPE);
      assert.deepEqual(
        summary.properties[0].activeSignals.map((s) => s.id),
        [localSignalId],
      );
      assert.equal(summary.unusableSignalCount, 1, "the foreign row is the one that is withheld");
      assert.equal(JSON.stringify(summary).includes(foreignProperty.formattedAddress), false);
    } finally {
      await db.delete(growOpportunitySignals).where(eq(growOpportunitySignals.id, foreignSignalId));
    }
  } finally {
    await cleanupBrokerages([B.brokerageId]);
  }
});

test("E-4: an Active relationship to another brokerage's property does not leak the address", async () => {
  const B = await createBrokerageWithUsers(baseUrl, `W2B Contact Signals Rel ${suffix}`);
  try {
    const partyId = await createParty("ForeignRelationship");
    const [foreignProperty] = await db
      .insert(properties)
      .values({
        brokerageId: B.brokerageId,
        agentId: B.admin.user.id,
        formattedAddress: `9 Foreign Relationship St ${suffix}`,
        state: "QLD",
        suburb: "Testville",
        postcode: "4000",
      })
      .returning({ id: properties.id, formattedAddress: properties.formattedAddress });
    await db.insert(growRelationships).values({
      brokerageId: A.brokerageId,
      partyId,
      propertyId: foreignProperty.id,
      relationshipType: "owner",
      status: "Active",
    });
    const signalId = await createSignal(partyId, foreignProperty.id, "Signal riding a cross-tenant relationship");
    try {
      const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
      assert.deepEqual(summary.properties, [], "the relationship join does not carry a foreign address");
      assert.equal(summary.unusableSignalCount, 1, "the signal is disclosed as withheld");
      assert.equal(JSON.stringify(summary).includes(foreignProperty.formattedAddress), false);
    } finally {
      await db.delete(growOpportunitySignals).where(eq(growOpportunitySignals.id, signalId));
      await db.delete(growRelationships).where(eq(growRelationships.partyId, partyId));
    }
  } finally {
    await cleanupBrokerages([B.brokerageId]);
  }
});

test("E-4: a contactability restriction does not erase a withheld unverifiable signal", async () => {
  const B = await createBrokerageWithUsers(baseUrl, `W2B Contact Signals Dnc ${suffix}`);
  try {
    const partyId = await createParty("RestrictedUnverified");
    const [foreignProperty] = await db
      .insert(properties)
      .values({
        brokerageId: B.brokerageId,
        agentId: B.admin.user.id,
        formattedAddress: `10 Foreign Dnc St ${suffix}`,
        state: "QLD",
        suburb: "Testville",
        postcode: "4000",
      })
      .returning({ id: properties.id, formattedAddress: properties.formattedAddress });
    const signalId = await createSignal(partyId, foreignProperty.id, "Unverifiable signal on a suppressed contact");
    await db.insert(growContactDncrStatuses).values({
      brokerageId: A.brokerageId,
      partyId,
      channel: "PHONE_CALL",
      status: "LISTED",
      source: "test-fixture",
      checkedAt: new Date(),
      recordedByUserId: A.admin.user.id,
    });
    try {
      const summary = await getContactPropertyIntelligenceSummary(partyId, A.brokerageId);
      assert.equal(summary.unusableSignalCount, 1, "gate 19 withholds outreach, not the fact that the signal exists");
      assert.ok(summary.outreachRestriction, "the restriction is still returned with the count");
      assert.equal(summary.outreachRestriction?.outreachProhibited, true);
      assert.deepEqual(summary.properties, []);
      assert.deepEqual(summary.contactAnchoredSignals, []);
      assert.equal(JSON.stringify(summary).includes(foreignProperty.formattedAddress), false);
    } finally {
      await db.delete(growOpportunitySignals).where(eq(growOpportunitySignals.id, signalId));
    }
  } finally {
    await cleanupBrokerages([B.brokerageId]);
  }
});
