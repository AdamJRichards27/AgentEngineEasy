// Property Timeline (#131-#135) — the new unified read-model over
// domainEvents + a curated auditLogs allow-list (apps/api/src/lib/timeline.ts),
// exposed at GET /properties/:id/timeline (apps/api/src/routes/properties.ts).
// These tests prove: the full property + transaction lifecycle produces
// exactly one Timeline entry per real-world milestone (no duplicates — the
// "#131 design doc §0/§4: exactly one authoritative source per milestone
// type" claim, checked directly rather than just asserted); entries are
// returned in ascending chronological order; the financial-entitlement
// boundary (#134) redacts commission/funds/agent-paid figures for a plain
// Agent but shows them in full to a Brokerage Administrator; and the
// #123-precedent tenant chokepoint rejects a cross-tenant propertyId with
// the same "not found" a nonexistent one would get.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import {
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  cleanupBrokerages,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.AML_WEBHOOK_SECRET = "aml-webhook-test-secret";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `Property Timeline A ${suffix}`;
const brokerageBName = `Property Timeline B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

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

interface TimelineItem {
  id: string;
  entryType: string;
  category: string;
  occurredAt: string;
  label: string;
  sensitivity: "STANDARD" | "SENSITIVE";
  detail?: Record<string, unknown>;
  source: "domain_event" | "audit_log";
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got: ${res.status} ${text}`);
  }
}

async function getTimeline(cookie: string, propertyId: number): Promise<Response> {
  return fetch(`${baseUrl}/api/properties/${propertyId}/timeline`, { headers: { cookie } });
}

function amlWebhookHeaders(body: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    "content-type": "application/json",
    "x-aml-timestamp": timestamp,
    "x-aml-signature": createHmac("sha256", process.env.AML_WEBHOOK_SECRET!).update(`${timestamp}.`).update(body).digest("hex"),
  };
}

test("Property Timeline: full property+transaction lifecycle produces exactly one entry per milestone, in ascending order, with financial redaction for a plain Agent", async () => {
  const headers = { "content-type": "application/json", cookie: A.agent.cookie };

  const { propertyId, sellerPartyId, transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: "1 Timeline Test Rd",
    conditionsText: "", // no transaction condition -> unconditional fires immediately on exchange
  });

  // Drive the transaction all the way to Closed through the real routes.
  const contractSignedRes = await fetch(`${baseUrl}/api/transactions/${transactionId}/contract-signed`, { method: "POST", headers });
  assert.equal(contractSignedRes.status, 200, await contractSignedRes.text());

  // Contract-signed triggers buyer AML — complete it via the webhook so the
  // eventual close() below is a clean (non-forced) close.
  const amlListRes = await fetch(`${baseUrl}/api/aml/by-property/${propertyId}`, { headers: { cookie: A.agent.cookie } });
  const { verifications } = await json<{ verifications: Array<{ partyId: number; status: string; providerReference: string }> }>(amlListRes);
  const buyerVerification = verifications.find((v) => v.partyId !== sellerPartyId && v.status !== "Complete");
  assert.ok(buyerVerification, "expected a buyer AML verification to have been initiated at contract-signed");
  const amlBody = JSON.stringify({ providerReference: buyerVerification!.providerReference, outcome: "VERIFIED", reviewRequired: false });
  const buyerAmlWebhookRes = await fetch(`${baseUrl}/api/aml/webhook`, {
    method: "POST",
    headers: amlWebhookHeaders(amlBody),
    body: amlBody,
  });
  assert.equal(buyerAmlWebhookRes.status, 200, await buyerAmlWebhookRes.text());

  const exchangeRes = await fetch(`${baseUrl}/api/transactions/${transactionId}/exchange`, { method: "POST", headers });
  const exchangeBody = await exchangeRes.text();
  assert.equal(exchangeRes.status, 200, exchangeBody);
  const { transaction: afterExchange } = JSON.parse(exchangeBody) as { transaction: { unconditionalAt: string | null } };
  assert.ok(afterExchange.unconditionalAt, "zero-condition transaction should become unconditional the moment it's exchanged");

  const scheduleRes = await fetch(`${baseUrl}/api/transactions/${transactionId}/settlement-schedule`, {
    method: "POST",
    headers,
    body: JSON.stringify({ settlementDate: "2027-02-01" }),
  });
  assert.equal(scheduleRes.status, 200, await scheduleRes.text());

  const completeRes = await fetch(`${baseUrl}/api/transactions/${transactionId}/settlement-complete`, { method: "POST", headers });
  const completeBody = await completeRes.text();
  assert.equal(completeRes.status, 200, completeBody);
  const { transaction: settled } = JSON.parse(completeBody) as { transaction: { grossCommissionCents: number; gstCents: number } };
  assert.ok(settled.grossCommissionCents > 0, "settlement-complete should auto-calculate a non-zero commission");

  const fundsRes = await fetch(`${baseUrl}/api/transactions/${transactionId}/funds-received`, {
    method: "POST",
    headers,
    body: JSON.stringify({ amountCents: settled.grossCommissionCents + settled.gstCents }),
  });
  assert.equal(fundsRes.status, 200, await fundsRes.text());

  const agentPaidRes = await fetch(`${baseUrl}/api/transactions/${transactionId}/agent-paid`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie }, // role-gated to Brokerage Administrator
  });
  assert.equal(agentPaidRes.status, 200, await agentPaidRes.text());

  const closeRes = await fetch(`${baseUrl}/api/transactions/${transactionId}/close`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
  });
  assert.equal(closeRes.status, 200, await closeRes.text());

  // --- As a plain Agent: every entry present, financial figures redacted ---
  const agentTimelineRes = await getTimeline(A.agent.cookie, propertyId);
  const agentTimelineBody = await agentTimelineRes.text();
  assert.equal(agentTimelineRes.status, 200, agentTimelineBody);
  const { timeline: agentTimeline } = JSON.parse(agentTimelineBody) as { timeline: TimelineItem[] };

  const expectedSingular = [
    "PROPERTY_CREATED",
    "party_added", // the seller
    "AML_REQUESTED", // >= 1 (seller + buyer) — checked as "at least one" below, not exactly-one
    "AML_COMPLETED",
    "DOCUMENT_PACKAGE_CREATED",
    "READY_TO_LIST",
    "AGENCY_AGREEMENT_SENT",
    "AGENCY_AGREEMENT_SIGNED",
    "LISTING_LIVE",
    "OFFER_RECEIVED",
    "OFFER_ACCEPTED",
    "CONTRACT_SIGNED",
    "CONTRACT_EXCHANGED",
    "TRANSACTION_UNCONDITIONAL",
    "SETTLEMENT_SCHEDULED",
    "SETTLEMENT_COMPLETED",
    "COMMISSION_CALCULATED",
    "FUNDS_RECEIVED",
    "AGENT_PAID",
    "TRANSACTION_CLOSED",
  ];
  for (const entryType of expectedSingular) {
    const matches = agentTimeline.filter((item) => item.entryType === entryType);
    assert.ok(matches.length >= 1, `expected at least one ${entryType} Timeline entry, found ${matches.length}`);
  }
  // Exactly-one milestones (no duplicate-source double counting — #131 §0/§4):
  // every entry type funded by exactly one row-producing action in this test.
  for (const entryType of [
    "PROPERTY_CREATED",
    "DOCUMENT_PACKAGE_CREATED",
    "READY_TO_LIST",
    "AGENCY_AGREEMENT_SENT",
    "AGENCY_AGREEMENT_SIGNED",
    "LISTING_LIVE",
    "OFFER_RECEIVED",
    "OFFER_ACCEPTED",
    "CONTRACT_SIGNED",
    "CONTRACT_EXCHANGED",
    "TRANSACTION_UNCONDITIONAL",
    "SETTLEMENT_SCHEDULED",
    "SETTLEMENT_COMPLETED",
    "COMMISSION_CALCULATED",
    "FUNDS_RECEIVED",
    "AGENT_PAID",
    "TRANSACTION_CLOSED",
  ]) {
    const matches = agentTimeline.filter((item) => item.entryType === entryType);
    assert.equal(matches.length, 1, `expected exactly one ${entryType} entry, found ${matches.length}`);
  }

  // Ascending chronological order.
  for (let i = 1; i < agentTimeline.length; i++) {
    assert.ok(
      agentTimeline[i - 1]!.occurredAt <= agentTimeline[i]!.occurredAt,
      `Timeline not in ascending order at index ${i}: ${agentTimeline[i - 1]!.occurredAt} > ${agentTimeline[i]!.occurredAt}`,
    );
  }

  // Financial redaction for a plain Agent.
  const commissionEntry = agentTimeline.find((item) => item.entryType === "COMMISSION_CALCULATED")!;
  assert.equal(commissionEntry.sensitivity, "SENSITIVE");
  assert.equal(commissionEntry.label, "Commission calculated");
  assert.doesNotMatch(commissionEntry.label, /\$/);
  assert.equal(commissionEntry.detail, undefined);

  const fundsEntry = agentTimeline.find((item) => item.entryType === "FUNDS_RECEIVED")!;
  assert.equal(fundsEntry.sensitivity, "SENSITIVE");
  assert.equal(fundsEntry.label, "Funds received");
  assert.doesNotMatch(fundsEntry.label, /\$/);
  assert.equal(fundsEntry.detail, undefined);

  const agentPaidEntry = agentTimeline.find((item) => item.entryType === "AGENT_PAID")!;
  assert.equal(agentPaidEntry.sensitivity, "SENSITIVE");
  assert.equal(agentPaidEntry.detail, undefined);

  // Non-financial entries are untouched for the same viewer.
  const closedEntry = agentTimeline.find((item) => item.entryType === "TRANSACTION_CLOSED")!;
  assert.equal(closedEntry.sensitivity, "STANDARD");
  assert.equal(closedEntry.label, "Transaction closed");

  // --- As a Brokerage Administrator: the same figures are shown in full ---
  const adminTimelineRes = await getTimeline(A.admin.cookie, propertyId);
  assert.equal(adminTimelineRes.status, 200);
  const { timeline: adminTimeline } = await json<{ timeline: TimelineItem[] }>(adminTimelineRes);

  const adminCommissionEntry = adminTimeline.find((item) => item.entryType === "COMMISSION_CALCULATED")!;
  assert.match(adminCommissionEntry.label, /\$/, "a Brokerage Administrator should see the real commission figure");
  assert.equal(typeof adminCommissionEntry.detail?.grossCommissionCents, "number");

  const adminFundsEntry = adminTimeline.find((item) => item.entryType === "FUNDS_RECEIVED")!;
  assert.match(adminFundsEntry.label, /\$/, "a Brokerage Administrator should see the real funds-received figure");
  assert.equal(typeof adminFundsEntry.detail?.amountCents, "number");
});

test("GET /properties/:id/timeline rejects a propertyId belonging to a different brokerage as 404, identical to a nonexistent property", async () => {
  const { propertyId: bPropertyId } = await createTransactionFromListedProperty(baseUrl, B.agent.cookie, {
    address: "2 Cross Tenant Timeline Rd",
    conditionsText: "",
  });

  const crossTenant = await getTimeline(A.agent.cookie, bPropertyId);
  assert.equal(crossTenant.status, 404);
  const crossTenantBody = await json<{ error: string }>(crossTenant);
  assert.match(crossTenantBody.error, /not found/i);

  const nonexistent = await getTimeline(A.agent.cookie, 999_999_999);
  assert.equal(nonexistent.status, 404);
  const nonexistentBody = await json<{ error: string }>(nonexistent);
  assert.match(nonexistentBody.error, /not found/i);
});
