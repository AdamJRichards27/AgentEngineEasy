// F-1 — Open commitments that are due today or overdue appear on Grow Today.
//
// growCommitments already exists (Contact 360, proposal cards, complete/cancel).
// This file proves the read path on GET /grow/today, which previously never
// queried that table. Completed and Cancelled stay off the list. A
// do-not-contact party keeps the card and loses outreach, which is the same
// treatment opportunity and appraisal cards already use.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { db, entitlementGrants, growCommitments, growContactDncrStatuses } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

const DAY = 24 * 60 * 60 * 1000;

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

function endOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `Grow Today Commitments A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Grow Today Commitments B ${suffix}`);
  for (const key of ["grow.access", "grow.relationships.manage", "grow.activities.manage"]) {
    await grant(A.brokerageId, key);
    await grant(B.brokerageId, key);
  }
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function grant(brokerageId: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
}

function growUrl(path: string) {
  return `${baseUrl}/api/grow${path}`;
}

async function createProperty(cookie: string, address: string) {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function createParty(cookie: string, propertyId: number, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Buyer", firstName: "Test", lastName: "Contact", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

async function createRelationship(cookie: string, body: Record<string, unknown>) {
  const res = await fetch(growUrl("/relationships"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`create relationship failed: ${res.status} ${await res.text()}`);
}

async function fetchToday(cookie: string) {
  const res = await fetch(growUrl("/today"), { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as any };
}

async function insertCommitment(values: {
  brokerageId: number;
  partyId: number;
  propertyId: number | null;
  description: string;
  dueAt: Date;
  status: "Open" | "Completed" | "Cancelled";
  createdBy: number;
}) {
  const [row] = await db.insert(growCommitments).values(values).returning({ id: growCommitments.id });
  return row.id;
}

test("F-1 — due-today and overdue Open commitments appear; future, Completed, and Cancelled do not", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Grow Today Commitments Filter ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const propertyId = await createProperty(fresh.agent.cookie, `1 Commitment St ${suffix}`);
    const partyId = await createParty(fresh.agent.cookie, propertyId, {
      firstName: "Casey",
      lastName: "Committed",
      email: `casey-committed-${suffix}@example.com`,
      mobile: "+61411110001",
    });

    const today0 = startOfTodayUtc();
    const today1 = endOfTodayUtc();
    const overdueId = await insertCommitment({
      brokerageId: fresh.brokerageId,
      partyId,
      propertyId,
      description: "Call Casey about the appraisal they asked for.",
      dueAt: new Date(today0.getTime() - 2 * DAY),
      status: "Open",
      createdBy: fresh.agent.user.id,
    });
    const dueTodayId = await insertCommitment({
      brokerageId: fresh.brokerageId,
      partyId,
      propertyId,
      description: "Send Casey the market report promised for today.",
      dueAt: new Date(today0.getTime() + 12 * 60 * 60 * 1000),
      status: "Open",
      createdBy: fresh.agent.user.id,
    });
    const startsTodayId = await insertCommitment({
      brokerageId: fresh.brokerageId,
      partyId,
      propertyId,
      description: "Due at the start of today.",
      dueAt: today0,
      status: "Open",
      createdBy: fresh.agent.user.id,
    });
    const endsTodayId = await insertCommitment({
      brokerageId: fresh.brokerageId,
      partyId,
      propertyId,
      description: "Due at the end of today.",
      dueAt: today1,
      status: "Open",
      createdBy: fresh.agent.user.id,
    });
    const futureId = await insertCommitment({
      brokerageId: fresh.brokerageId,
      partyId,
      propertyId,
      description: "Call Casey next month.",
      dueAt: new Date(today1.getTime() + DAY),
      status: "Open",
      createdBy: fresh.agent.user.id,
    });
    const completedId = await insertCommitment({
      brokerageId: fresh.brokerageId,
      partyId,
      propertyId,
      description: "Already done — must not return.",
      dueAt: new Date(today0.getTime() - DAY),
      status: "Completed",
      createdBy: fresh.agent.user.id,
    });
    const cancelledId = await insertCommitment({
      brokerageId: fresh.brokerageId,
      partyId,
      propertyId,
      description: "Cancelled — must not return.",
      dueAt: today0,
      status: "Cancelled",
      createdBy: fresh.agent.user.id,
    });

    const { status, body } = await fetchToday(fresh.agent.cookie);
    assert.equal(status, 200);
    assert.equal(body.hasAnyGrowData, true, "a due commitment is Grow data; the onboarding empty state must not hide it");

    const byId = new Map<string, any>(body.priorityActions.map((a: any) => [a.id, a]));
    const overdue = byId.get(`commitment:${overdueId}`);
    const dueToday = byId.get(`commitment:${dueTodayId}`);
    const startsToday = byId.get(`commitment:${startsTodayId}`);
    const endsToday = byId.get(`commitment:${endsTodayId}`);
    assert.ok(overdue, "an overdue Open commitment is on Today");
    assert.equal(overdue.type, "commitment");
    assert.equal(overdue.commitmentId, overdueId);
    assert.equal(overdue.priority, "DoNow");
    assert.equal(overdue.partyId, partyId);
    assert.equal(overdue.contactName, "Casey Committed");
    assert.equal(overdue.propertyId, propertyId);
    assert.match(overdue.propertyLabel, /1 Commitment St/);
    assert.match(overdue.reason, /Open commitment was due/);
    assert.match(overdue.reason, /Call Casey about the appraisal/);
    assert.equal(overdue.recommendedAction, "Call Casey about the appraisal they asked for.");
    assert.equal(overdue.contactability, "contactable");
    assert.equal(overdue.contactEmail, `casey-committed-${suffix}@example.com`);
    assert.equal(overdue.contactMobile, "+61411110001");
    assert.ok(overdue.availableActions.some((b: any) => b.action === "email"));
    assert.ok(overdue.availableActions.some((b: any) => b.action === "sms"));
    assert.ok(overdue.availableActions.some((b: any) => b.action === "view_contact"));
    assert.ok(overdue.availableActions.some((b: any) => b.action === "add_note"));
    assert.ok(!overdue.availableActions.some((b: any) => b.action === "update_next_action"));

    assert.ok(dueToday, "an Open commitment due later today is on Today");
    assert.equal(dueToday.priority, "DoToday");
    assert.equal(dueToday.commitmentId, dueTodayId);
    assert.match(dueToday.reason, /Open commitment is due today/);

    assert.ok(startsToday, "a commitment due at the start of today is due today, not overdue");
    assert.equal(startsToday.priority, "DoToday");
    assert.ok(endsToday, "a commitment due at the end of today is still today");
    assert.equal(endsToday.priority, "DoToday");

    assert.equal(byId.has(`commitment:${futureId}`), false, "a future Open commitment is not Today's work");
    assert.equal(byId.has(`commitment:${completedId}`), false, "a Completed commitment is not Today's work");
    assert.equal(byId.has(`commitment:${cancelledId}`), false, "a Cancelled commitment is not Today's work");

    const commitmentCards = body.priorityActions.filter((a: any) => a.type === "commitment");
    assert.equal(commitmentCards.length, 4);
    assert.ok(body.counts.followUpsDue >= 4, "each surfaced commitment counts as a follow-up due");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("F-1 — a do-not-contact party keeps the commitment card and loses outreach", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Grow Today Commitments DNC ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const propertyId = await createProperty(fresh.agent.cookie, `2 DNC Commitment St ${suffix}`);
    const partyId = await createParty(fresh.agent.cookie, propertyId, {
      firstName: "Dana",
      lastName: "DoNotCall",
      email: `dana-dnc-${suffix}@example.com`,
      mobile: "+61411110002",
    });
    const commitmentId = await insertCommitment({
      brokerageId: fresh.brokerageId,
      partyId,
      propertyId,
      description: "Ring Dana back about the listing.",
      dueAt: new Date(startOfTodayUtc().getTime() - DAY),
      status: "Open",
      createdBy: fresh.agent.user.id,
    });
    await db.insert(growContactDncrStatuses).values({
      brokerageId: fresh.brokerageId,
      partyId,
      channel: "PHONE_CALL",
      status: "LISTED",
      source: "test-fixture",
      recordedByUserId: fresh.agent.user.id,
    });

    const { body } = await fetchToday(fresh.agent.cookie);
    const card = body.priorityActions.find((a: any) => a.id === `commitment:${commitmentId}`);
    assert.ok(card, "the obligation stays visible — suppression must not delete a recorded promise");
    assert.equal(card.type, "commitment");
    assert.equal(card.contactability, "do_not_contact");
    assert.equal(card.contactName, "Dana DoNotCall");
    assert.ok(typeof card.contactabilityNote === "string" && card.contactabilityNote.length > 0);
    assert.equal(card.contactEmail, null);
    assert.equal(card.contactMobile, null);
    assert.ok(!card.availableActions.some((b: any) => b.action === "email"));
    assert.ok(!card.availableActions.some((b: any) => b.action === "sms"));
    assert.ok(card.availableActions.some((b: any) => b.action === "view_contact"));
    assert.ok(card.availableActions.some((b: any) => b.action === "add_note"));
    assert.match(card.recommendedAction, /Do not contact/i);
    assert.ok(!card.recommendedAction.includes("Ring Dana back"), "the outreach instruction must not be the recommendation");
    assert.match(card.reason, /Ring Dana back about the listing/, "the promise itself stays readable so the agent knows what was committed");
    assert.equal(card.rankScore, 0);
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes(`dana-dnc-${suffix}@example.com`));
    assert.ok(!serialised.includes("+61411110002"));
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("F-1 — a due commitment suppresses the cold-contact nudge for that same person, and stays inside the brokerage", async () => {
  const propertyId = await createProperty(A.agent.cookie, `3 Dedup Commitment St ${suffix}`);
  const partyId = await createParty(A.agent.cookie, propertyId, {
    firstName: "Riley",
    lastName: "Promised",
    email: `riley-promised-${suffix}@example.com`,
  });
  await createRelationship(A.agent.cookie, { partyId, propertyId, relationshipType: "owner" });
  const commitmentId = await insertCommitment({
    brokerageId: A.brokerageId,
    partyId,
    propertyId,
    description: "Prepare the appraisal Riley was promised.",
    dueAt: new Date(startOfTodayUtc().getTime() - 3 * DAY),
    status: "Open",
    createdBy: A.agent.user.id,
  });

  const otherPropertyId = await createProperty(B.agent.cookie, `4 Other Brokerage St ${suffix}`);
  const otherPartyId = await createParty(B.agent.cookie, otherPropertyId, {
    firstName: "Blair",
    lastName: "OtherBrokerage",
    email: `blair-other-${suffix}@example.com`,
  });
  const otherCommitmentId = await insertCommitment({
    brokerageId: B.brokerageId,
    partyId: otherPartyId,
    propertyId: otherPropertyId,
    description: "Brokerage B's own promise.",
    dueAt: startOfTodayUtc(),
    status: "Open",
    createdBy: B.agent.user.id,
  });

  const aToday = await fetchToday(A.agent.cookie);
  assert.equal(aToday.status, 200);
  const aCardsForParty = aToday.body.priorityActions.filter((a: any) => a.partyId === partyId);
  assert.ok(aCardsForParty.some((a: any) => a.id === `commitment:${commitmentId}`));
  assert.ok(
    !aCardsForParty.some((a: any) => a.type === "relationship_cold"),
    "Rule D must not also tell the agent to reconnect with someone who already has a due commitment",
  );
  assert.ok(!aToday.body.priorityActions.some((a: any) => a.id === `commitment:${otherCommitmentId}`));
  assert.ok(!JSON.stringify(aToday.body).includes(`blair-other-${suffix}@example.com`));

  const bToday = await fetchToday(B.agent.cookie);
  assert.ok(bToday.body.priorityActions.some((a: any) => a.id === `commitment:${otherCommitmentId}`));
  assert.ok(!bToday.body.priorityActions.some((a: any) => a.id === `commitment:${commitmentId}`));
});
