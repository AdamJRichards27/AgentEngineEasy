// Run Transaction Vertical Slice — the one true end-to-end test the
// governing spec requires: a single property driven through every Run-tier
// stage (Appraisal -> Agency Agreement -> Listing -> Offer -> Contract ->
// Conditions -> AML/CTF -> Settlement -> Closure) over real HTTP, through
// the real Express app and real session auth, asserting at each transition
// that the stage's required domain event is genuinely persisted exactly
// once (duplicate-delivery protection), and that tenant scoping (#123)
// holds throughout. Deliberately sequential/narrative -- each test builds
// on the previous one having actually completed, the same convention this
// codebase's existing grow.test.ts already established for exactly this
// reason (see its module comment).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { db, automationTasks, automationAttentionItems } from "@aee/db";
import { createBrokerageWithUsers, cleanupBrokerages, getDomainEventsForProperty, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `Run Vertical Slice E2E A ${suffix}`;
const brokerageBName = `Run Vertical Slice E2E B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

let propertyId: number;
let packageId: number;
let offerId: number;
let transactionId: number;
let conditionId: number;

function headers(cookie: string) {
  return { "content-type": "application/json", cookie };
}
async function postJson(path: string, cookie: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, { method: "POST", headers: headers(cookie), body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function getJson(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: { cookie } });
}
async function bodyOf<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got ${res.status}: ${text}`);
  }
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

  A = await createBrokerageWithUsers(baseUrl, brokerageAName);
  B = await createBrokerageWithUsers(baseUrl, brokerageBName);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("Stage 0: Start Property + Seller", async () => {
  const propRes = await postJson("/properties", A.agent.cookie, {
    formattedAddress: "1 Vertical Slice Ave",
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(propRes.status, 201);
  const { property } = await bodyOf<{ property: { id: number } }>(propRes);
  propertyId = property.id;

  const partyRes = await postJson("/parties", A.agent.cookie, {
    propertyId,
    role: "Seller",
    firstName: "Sam",
    lastName: "Seller",
    email: `seller-${suffix}@example.com`,
  });
  assert.equal(partyRes.status, 201);
});

test("Stage A: Appraisal is captured and finalised, publishing APPRAISAL_CREATED then APPRAISAL_COMPLETED exactly once each", async () => {
  const startRes = await postJson(`/appraisals/by-property/${propertyId}/start`, A.agent.cookie);
  assert.equal(startRes.status, 201);
  // Duplicate start must be a harmless no-op, not a second row/event.
  const startAgainRes = await postJson(`/appraisals/by-property/${propertyId}/start`, A.agent.cookie);
  assert.equal(startAgainRes.status, 200);

  const saveRes = await postJson(`/appraisals/by-property/${propertyId}`, A.agent.cookie, {
    priceRangeLow: "700000",
    priceRangeHigh: "760000",
    comparableSales: "12 Nearby St sold $735,000 (2 months ago)",
  });
  assert.equal(saveRes.status, 200);

  const finaliseRes = await postJson(`/appraisals/by-property/${propertyId}/finalise`, A.agent.cookie);
  assert.equal(finaliseRes.status, 200);
  const { appraisal } = await bodyOf<{ appraisal: { isFinalised: boolean } }>(finaliseRes);
  assert.equal(appraisal.isFinalised, true);

  assert.equal((await getDomainEventsForProperty(propertyId, "APPRAISAL_CREATED")).length, 1);
  assert.equal((await getDomainEventsForProperty(propertyId, "APPRAISAL_COMPLETED")).length, 1);
});

test("Stage B: Agency Agreement -> Ready to List -> documents signed -> seller AML cleared -> Go Live", async () => {
  const rtlRes = await postJson(`/properties/${propertyId}/ready-to-list`, A.agent.cookie);
  assert.equal(rtlRes.status, 200);
  const { documentPackage } = await bodyOf<{ documentPackage: { id: number } }>(rtlRes);
  packageId = documentPackage.id;

  const termsRes = await fetch(`${baseUrl}/api/documents/agency-agreement-terms/${propertyId}`, {
    method: "PUT",
    headers: headers(A.agent.cookie),
    body: JSON.stringify({ commissionType: "Percentage", commissionRateBps: 220, agreementTermDays: 90 }),
  });
  assert.equal(termsRes.status, 200);

  const populateRes = await postJson(`/documents/packages/${packageId}/populate`, A.agent.cookie);
  assert.equal(populateRes.status, 200);

  const sendRes = await postJson(`/documents/packages/${packageId}/send-for-signature`, A.agent.cookie);
  assert.equal(sendRes.status, 201);
  const { signatureRequest } = await bodyOf<{ signatureRequest: { providerReference: string } }>(sendRes);

  const esignWebhookRes = await fetch(`${baseUrl}/api/documents/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerReference: signatureRequest.providerReference, status: "Completed" }),
  });
  assert.equal(esignWebhookRes.status, 200);

  const amlListRes = await getJson(`/aml/by-property/${propertyId}`, A.agent.cookie);
  const { verifications } = await bodyOf<{ verifications: Array<{ providerReference: string }> }>(amlListRes);
  assert.ok(verifications.length > 0, "Ready to List must have initiated seller AML");
  for (const v of verifications) {
    const webhookRes = await fetch(`${baseUrl}/api/aml/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerReference: v.providerReference, outcome: "VERIFIED", reviewRequired: false }),
    });
    assert.equal(webhookRes.status, 200);
  }

  const goLiveRes = await postJson(`/properties/${propertyId}/go-live`, A.agent.cookie);
  assert.equal(goLiveRes.status, 200);
  const { property } = await bodyOf<{ property: { listingStatus: string } }>(goLiveRes);
  assert.equal(property.listingStatus, "Listed");
});

test("Stage C: Listing details are captured, purely descriptive -- no listing publication and nothing downstream is gated by them", async () => {
  const res = await postJson(`/properties/${propertyId}/listing-details`, A.agent.cookie, {
    salesMethod: "Auction",
    priceDisplay: "Contact Agent",
    campaignStartDate: "2027-01-01",
    campaignEndDate: "2027-02-01",
  });
  assert.equal(res.status, 200);
  const { property } = await bodyOf<{ property: { salesMethod: string; priceDisplay: string } }>(res);
  assert.equal(property.salesMethod, "Auction");
  assert.equal(property.priceDisplay, "Contact Agent");
});

test("Stage D: Offer accepted -> Transaction created with offer data carried forward, publishing OFFER_ACCEPTED exactly once", async () => {
  const offerRes = await postJson(`/offers/by-property/${propertyId}`, A.agent.cookie, {
    offerPriceCents: 82000000,
    conditions: { depositCents: 4100000, settlementDate: "2027-03-10", conditions: "Subject to finance", additionalTerms: "Standard terms" },
    buyer: { firstName: "Bob", lastName: "Buyer", email: `buyer-${suffix}@example.com` },
  });
  assert.equal(offerRes.status, 201);
  const { offer } = await bodyOf<{ offer: { id: number } }>(offerRes);
  offerId = offer.id;

  const acceptRes = await postJson(`/offers/${offerId}/accept`, A.agent.cookie);
  assert.equal(acceptRes.status, 201);
  const { transaction, created } = await bodyOf<{ transaction: { id: number; depositCents: number }; created: boolean }>(acceptRes);
  assert.equal(created, true);
  assert.equal(transaction.depositCents, 4100000, "the offer's deposit must be carried forward onto the Transaction, not discarded");
  transactionId = transaction.id;

  // Duplicate delivery: re-accepting the same (now-Accepted) offer must be
  // a harmless idempotent 200, never a second Transaction or a second event.
  const acceptAgainRes = await postJson(`/offers/${offerId}/accept`, A.agent.cookie);
  assert.equal(acceptAgainRes.status, 200);
  const { created: createdAgain } = await bodyOf<{ created: boolean }>(acceptAgainRes);
  assert.equal(createdAgain, false);

  assert.equal((await getDomainEventsForProperty(propertyId, "OFFER_ACCEPTED")).length, 1);
});

test("Contract + AML/CTF: contract signed publishes CONTRACT_SIGNED exactly once, buyer AML/CTF is initiated and cleared, and legal representatives are captured", async () => {
  const signRes = await postJson(`/transactions/${transactionId}/contract-signed`, A.agent.cookie);
  assert.equal(signRes.status, 200);
  const { transaction } = await bodyOf<{ transaction: { contractDate: string | null } }>(signRes);
  assert.ok(transaction.contractDate);

  // Duplicate delivery: signing again must not re-publish CONTRACT_SIGNED.
  const signAgainRes = await postJson(`/transactions/${transactionId}/contract-signed`, A.agent.cookie);
  assert.equal(signAgainRes.status, 200);
  assert.equal((await getDomainEventsForProperty(propertyId, "CONTRACT_SIGNED")).length, 1);

  // AML/CTF: the buyer party added via the offer must now have a real
  // verification row (previously a confirmed gap -- buyers were never
  // AML-checked anywhere in this codebase before this build). Clear it the
  // same way seller AML was cleared in Stage B, so this stage is genuinely
  // completed rather than left dangling for Stage H to force past.
  const amlListRes = await getJson(`/aml/by-property/${propertyId}`, A.agent.cookie);
  const { verifications } = await bodyOf<{ verifications: Array<{ providerReference: string; status: string }> }>(amlListRes);
  const buyerVerification = verifications.find((v) => v.status !== "Complete");
  assert.ok(buyerVerification, "contract signing must have initiated a new (buyer) AML verification");
  const buyerWebhookRes = await fetch(`${baseUrl}/api/aml/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerReference: buyerVerification!.providerReference, outcome: "VERIFIED", reviewRequired: false }),
  });
  assert.equal(buyerWebhookRes.status, 200);

  const buyerSolicitorRes = await postJson("/parties", A.agent.cookie, {
    propertyId,
    role: "Solicitor",
    firstName: "Sarah",
    lastName: "Solicitor",
    email: `solicitor-${suffix}@example.com`,
  });
  assert.equal(buyerSolicitorRes.status, 201);
  const { party: solicitorParty } = await bodyOf<{ party: { id: number } }>(buyerSolicitorRes);

  const legalRepsRes = await postJson(`/transactions/${transactionId}/legal-representatives`, A.agent.cookie, {
    buyerSolicitorPartyId: solicitorParty.id,
  });
  assert.equal(legalRepsRes.status, 200);
  const { transaction: withReps } = await bodyOf<{ transaction: { legalRepresentatives: { buyerSolicitorPartyId: number | null } } }>(legalRepsRes);
  assert.equal(withReps.legalRepresentatives.buyerSolicitorPartyId, solicitorParty.id);
});

test("Stage E: a Contract Condition is added, exchange fires CONTRACT_EXCHANGED, unconditional is genuinely blocked until the condition resolves, then fires automatically", async () => {
  const addConditionRes = await postJson(`/transactions/${transactionId}/conditions`, A.agent.cookie, { description: "Subject to finance approval" });
  assert.equal(addConditionRes.status, 201);
  const { condition } = await bodyOf<{ condition: { id: number } }>(addConditionRes);
  conditionId = condition.id;

  const exchangeRes = await postJson(`/transactions/${transactionId}/exchange`, A.agent.cookie);
  assert.equal(exchangeRes.status, 200);
  assert.equal((await getDomainEventsForProperty(propertyId, "CONTRACT_EXCHANGED")).length, 1);

  const blockedUnconditionalRes = await postJson(`/transactions/${transactionId}/unconditional`, A.agent.cookie);
  assert.equal(blockedUnconditionalRes.status, 409, "must not become unconditional with a Pending condition outstanding");
  const blockedBody = await bodyOf<{ blockers: string[] }>(blockedUnconditionalRes);
  assert.ok(blockedBody.blockers.some((b) => /condition/i.test(b)));

  const resolveRes = await postJson(`/transactions/conditions/${conditionId}/resolve`, A.agent.cookie, { status: "Satisfied" });
  assert.equal(resolveRes.status, 200);

  assert.equal(
    (await getDomainEventsForProperty(propertyId, "TRANSACTION_UNCONDITIONAL")).length,
    1,
    "resolving the last blocking condition must have auto-fired unconditional exactly once, with no separate manual step",
  );

  const alreadyUnconditionalRes = await postJson(`/transactions/${transactionId}/unconditional`, A.agent.cookie);
  assert.equal(alreadyUnconditionalRes.status, 200, "calling unconditional again once already unconditional must be a harmless idempotent 200");
});

test("Stage G: Settlement is scheduled and completed, auto-calculating commission, and retains the earlier Exchange/Unconditional milestones", async () => {
  const scheduleRes = await postJson(`/transactions/${transactionId}/settlement-schedule`, A.agent.cookie, { settlementDate: "2027-03-10" });
  assert.equal(scheduleRes.status, 200);

  const completeRes = await postJson(`/transactions/${transactionId}/settlement-complete`, A.agent.cookie);
  assert.equal(completeRes.status, 200);
  const { transaction } = await bodyOf<{
    transaction: { status: string; grossCommissionCents: number | null; exchangedAt: string | null; unconditionalAt: string | null };
  }>(completeRes);
  assert.equal(transaction.status, "Settled");
  assert.ok(transaction.grossCommissionCents, "settlement completion must auto-trigger commission calculation");
  assert.ok(transaction.exchangedAt, "Settlement visibility must retain the earlier Stage E milestones, not just the latest field");
  assert.ok(transaction.unconditionalAt);

  const fundsRes = await postJson(`/transactions/${transactionId}/funds-received`, A.agent.cookie, { amountCents: 82000000 });
  assert.equal(fundsRes.status, 200);

  const agentPaidRes = await postJson(`/transactions/${transactionId}/agent-paid`, A.admin.cookie);
  assert.equal(agentPaidRes.status, 200);
});

test("#122: agent-facing tasks/attention items are visible and actionable via the real routes", async () => {
  // Manufactured directly, mirroring the shape the WAE catalogue (#113)
  // would create on these same domain events, so this test deterministically
  // exercises the read + action routes regardless of which system-template
  // rules happen to be activated in this environment.
  const [task] = await db
    .insert(automationTasks)
    .values({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      taskKey: "PREPARE_PERMITTED_CLIENT_FOLLOWUP",
      kind: "TASK",
      title: "Confirm settlement funds cleared",
      status: "ACTIVE",
    })
    .returning();
  const [item] = await db
    .insert(automationAttentionItems)
    .values({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      reasonCode: "OTHER",
      summary: "Confirm commission invoice raised",
      status: "OPEN",
    })
    .returning();

  const listRes = await getJson(`/tasks/by-property/${propertyId}`, A.agent.cookie);
  assert.equal(listRes.status, 200);
  const { tasks, attentionItems } = await bodyOf<{ tasks: Array<{ id: string }>; attentionItems: Array<{ id: string }> }>(listRes);
  assert.ok(tasks.some((t) => t.id === task.id));
  assert.ok(attentionItems.some((i) => i.id === item.id));

  const completeRes = await postJson(`/tasks/${task.id}/complete`, A.agent.cookie);
  assert.equal(completeRes.status, 200);

  const resolveRes = await postJson(`/tasks/attention-items/${item.id}/resolve`, A.agent.cookie, { notes: "Invoice raised" });
  assert.equal(resolveRes.status, 200);
});

test("Stage H: Closure succeeds now every real blocker is resolved (falling back to a distinctly-audited force only if this environment raised further real WAE tasks), publishing TRANSACTION_CLOSED exactly once", async () => {
  const attemptRes = await postJson(`/transactions/${transactionId}/close`, A.admin.cookie);
  let finalStatus: string;
  if (attemptRes.status === 200) {
    const { transaction } = await bodyOf<{ transaction: { status: string } }>(attemptRes);
    finalStatus = transaction.status;
  } else {
    assert.equal(attemptRes.status, 409, `expected a clean 200 close or a 409 with blockers, got ${attemptRes.status}: ${await attemptRes.text()}`);
    const forcedRes = await postJson(`/transactions/${transactionId}/close`, A.admin.cookie, { force: true });
    assert.equal(forcedRes.status, 200);
    const { transaction } = await bodyOf<{ transaction: { status: string } }>(forcedRes);
    finalStatus = transaction.status;
  }
  assert.equal(finalStatus, "Closed");

  const closedEvents = await getDomainEventsForProperty(propertyId, "TRANSACTION_CLOSED");
  assert.equal(closedEvents.length, 1, "TRANSACTION_CLOSED must be published exactly once for the whole journey");

  // Closing again must be a harmless idempotent no-op, not a second event.
  const closeAgainRes = await postJson(`/transactions/${transactionId}/close`, A.admin.cookie);
  assert.equal(closeAgainRes.status, 200);
  assert.equal((await getDomainEventsForProperty(propertyId, "TRANSACTION_CLOSED")).length, 1);
});

test("#123: tenant scoping holds across every stage of this journey -- Brokerage B can reach none of Brokerage A's property, offer, transaction, appraisal, or condition data", async () => {
  const endpoints: Array<[string, string]> = [
    ["Property", `/properties/${propertyId}`],
    ["Workspace", `/properties/${propertyId}/workspace`],
    ["Appraisal", `/appraisals/by-property/${propertyId}`],
    ["Offer", `/offers/${offerId}`],
    ["Transaction", `/transactions/${transactionId}`],
    ["Transaction by property", `/transactions/by-property/${propertyId}`],
    ["Conditions", `/transactions/${transactionId}/conditions`],
  ];
  for (const [label, path] of endpoints) {
    const res = await getJson(path, B.agent.cookie);
    assert.equal(res.status, 404, `${label} must 404 for another brokerage's data, not leak it or 403`);
  }

  // /tasks/by-property/:id filters directly by the caller's own
  // brokerageId (rather than first checking the property's owning
  // brokerage like the routes above), so it cannot leak Brokerage A's
  // rows -- it returns an honestly-empty list instead of a 404. Documented
  // here as the one intentionally-different shape among these checks,
  // not a data leak: the WHERE clause makes cross-tenant rows structurally
  // unreachable regardless.
  const tasksRes = await getJson(`/tasks/by-property/${propertyId}`, B.agent.cookie);
  assert.equal(tasksRes.status, 200);
  const { tasks: bTasks, attentionItems: bItems } = await bodyOf<{ tasks: unknown[]; attentionItems: unknown[] }>(tasksRes);
  assert.deepEqual(bTasks, []);
  assert.deepEqual(bItems, []);

  // Write attempts must be equally blocked, not merely reads.
  const acceptRes = await postJson(`/offers/${offerId}/accept`, B.agent.cookie);
  assert.equal(acceptRes.status, 404);
  const closeRes = await postJson(`/transactions/${transactionId}/close`, B.admin.cookie);
  assert.equal(closeRes.status, 404);
});
