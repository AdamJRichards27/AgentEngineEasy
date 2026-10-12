// R-F39 — Run audit rows record the tenant brokerage.
//
// Drives the same Ready to List -> Close journey as
// runTransactionVerticalSlice.test.ts, for two brokerages at once, then
// asserts every Run audit row for the property, transaction, package,
// document versions, and automation tasks carries that tenant's
// brokerage_id. Party and appraisal writers are outside this change and
// are not part of the assertion.
//
// Property documents stay brokerage_id NULL. The documents ownership
// check requires that when property_id is set.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { db, auditLogs, automationAttentionItems, automationTasks, documents } from "@aee/db";
import {
  createBrokerageWithUsers,
  cleanupBrokerages,
  signedSandboxEsignWebhookHeaders,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.AML_WEBHOOK_SECRET = "aml-webhook-test-secret";

const OWNED_RECORD_TYPES = new Set([
  "property",
  "offer",
  "transaction",
  "transaction_condition",
  "agency_agreement_terms",
  "document_package",
  "document_object_version",
  "signature_request",
  "automation_task",
  "automation_attention_item",
  "aml_verification",
]);

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

let propertyA = 0;
let packageA = 0;
let transactionA = 0;
let propertyB = 0;
let packageB = 0;

function headers(cookie: string) {
  return { "content-type": "application/json", cookie };
}
async function postJson(path: string, cookie: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, { method: "POST", headers: headers(cookie), body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function getJson(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: { cookie } });
}
function amlWebhookHeaders(body: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    "content-type": "application/json",
    "x-aml-timestamp": timestamp,
    "x-aml-signature": createHmac("sha256", process.env.AML_WEBHOOK_SECRET!).update(`${timestamp}.`).update(body).digest("hex"),
  };
}
async function bodyOf<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got ${res.status}: ${text}`);
  }
}

async function openToReadyToList(cookie: string, address: string, sellerEmail: string) {
  const propRes = await postJson("/properties", cookie, {
    formattedAddress: address,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(propRes.status, 201);
  const { property } = await bodyOf<{ property: { id: number } }>(propRes);
  const partyRes = await postJson("/parties", cookie, {
    propertyId: property.id,
    role: "Seller",
    firstName: "Sam",
    lastName: "Seller",
    email: sellerEmail,
  });
  assert.equal(partyRes.status, 201);
  const rtlRes = await postJson(`/properties/${property.id}/ready-to-list`, cookie);
  assert.equal(rtlRes.status, 200);
  const { documentPackage } = await bodyOf<{ documentPackage: { id: number } }>(rtlRes);
  return { propertyId: property.id, packageId: documentPackage.id };
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
  A = await createBrokerageWithUsers(baseUrl, `Run Audit Brokerage A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Run Audit Brokerage B ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("two brokerages reach Ready to List at the same time", async () => {
  const [openedA, openedB] = await Promise.all([
    openToReadyToList(A.agent.cookie, "1 Audit Brokerage Ave", `seller-a-${suffix}@example.com`),
    openToReadyToList(B.agent.cookie, "2 Audit Brokerage Ave", `seller-b-${suffix}@example.com`),
  ]);
  propertyA = openedA.propertyId;
  packageA = openedA.packageId;
  propertyB = openedB.propertyId;
  packageB = openedB.packageId;
});

test("brokerage A runs Ready to List through Close while brokerage B records its own offer", async () => {
  const termsRes = await fetch(`${baseUrl}/api/documents/agency-agreement-terms/${propertyA}`, {
    method: "PUT",
    headers: headers(A.agent.cookie),
    body: JSON.stringify({ commissionType: "Percentage", commissionRateBps: 220, agreementTermDays: 90 }),
  });
  assert.equal(termsRes.status, 200);

  const populateRes = await postJson(`/documents/packages/${packageA}/populate`, A.agent.cookie);
  assert.equal(populateRes.status, 200);
  const packageRes = await getJson(`/documents/packages/by-property/${propertyA}`, A.agent.cookie);
  const { documents: packageDocuments } = await bodyOf<{ documents: Array<{ id: number; title: string; brokerageId: number | null }> }>(packageRes);
  assert.ok(packageDocuments.length > 0);
  assert.ok(packageDocuments.every((document) => document.brokerageId == null), "property documents must keep brokerage_id NULL");

  const sendRes = await postJson(`/documents/packages/${packageA}/send-for-signature`, A.agent.cookie);
  assert.equal(sendRes.status, 201);
  const { signatureRequest } = await bodyOf<{ signatureRequest: { providerReference: string } }>(sendRes);
  const completedDocuments = packageDocuments.map((document) => ({
    documentId: document.id,
    contentBase64: Buffer.from(`Signed document: ${document.title}\n`, "utf8").toString("base64"),
    filename: `${document.title.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`,
    contentType: "text/plain",
  }));
  const esignWebhookBody = JSON.stringify({
    providerReference: signatureRequest.providerReference,
    status: "Completed",
    completedDocuments,
  });
  const esignWebhookRes = await fetch(`${baseUrl}/api/documents/webhook`, {
    method: "POST",
    headers: signedSandboxEsignWebhookHeaders(esignWebhookBody),
    body: esignWebhookBody,
  });
  assert.equal(esignWebhookRes.status, 200);

  const amlListRes = await getJson(`/aml/by-property/${propertyA}`, A.agent.cookie);
  const { verifications } = await bodyOf<{ verifications: Array<{ providerReference: string }> }>(amlListRes);
  assert.ok(verifications.length > 0);
  for (const verification of verifications) {
    const body = JSON.stringify({ providerReference: verification.providerReference, outcome: "VERIFIED", reviewRequired: false });
    const webhookRes = await fetch(`${baseUrl}/api/aml/webhook`, { method: "POST", headers: amlWebhookHeaders(body), body });
    assert.equal(webhookRes.status, 200);
  }

  const goLiveRes = await postJson(`/properties/${propertyA}/go-live`, A.agent.cookie);
  assert.equal(goLiveRes.status, 200);

  const [listingA, listingB] = await Promise.all([
    postJson(`/properties/${propertyA}/listing-details`, A.agent.cookie, {
      salesMethod: "Auction",
      priceDisplay: "Contact Agent",
      campaignStartDate: "2027-01-01",
      campaignEndDate: "2027-02-01",
    }),
    postJson(`/properties/${propertyB}/listing-details`, B.agent.cookie, {
      salesMethod: "Private Treaty",
      priceDisplay: "Offers over",
    }),
  ]);
  assert.equal(listingA.status, 200);
  assert.equal(listingB.status, 200);

  // B is not listed, so an offer is refused. List B, then both brokerages
  // record offers together.
  const termsB = await fetch(`${baseUrl}/api/documents/agency-agreement-terms/${propertyB}`, {
    method: "PUT",
    headers: headers(B.agent.cookie),
    body: JSON.stringify({ commissionType: "Percentage", commissionRateBps: 200, agreementTermDays: 60 }),
  });
  assert.equal(termsB.status, 200);
  const populateB = await postJson(`/documents/packages/${packageB}/populate`, B.agent.cookie);
  assert.equal(populateB.status, 200);
  const packageBRes = await getJson(`/documents/packages/by-property/${propertyB}`, B.agent.cookie);
  const { documents: documentsB } = await bodyOf<{ documents: Array<{ id: number; title: string }> }>(packageBRes);
  const sendB = await postJson(`/documents/packages/${packageB}/send-for-signature`, B.agent.cookie);
  assert.equal(sendB.status, 201);
  const { signatureRequest: signatureB } = await bodyOf<{ signatureRequest: { providerReference: string } }>(sendB);
  const completedB = documentsB.map((document) => ({
    documentId: document.id,
    contentBase64: Buffer.from(`Signed document: ${document.title}\n`, "utf8").toString("base64"),
    filename: `${document.title.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`,
    contentType: "text/plain",
  }));
  const esignBBody = JSON.stringify({
    providerReference: signatureB.providerReference,
    status: "Completed",
    completedDocuments: completedB,
  });
  const esignB = await fetch(`${baseUrl}/api/documents/webhook`, {
    method: "POST",
    headers: signedSandboxEsignWebhookHeaders(esignBBody),
    body: esignBBody,
  });
  assert.equal(esignB.status, 200);
  const amlBRes = await getJson(`/aml/by-property/${propertyB}`, B.agent.cookie);
  const { verifications: verificationsB } = await bodyOf<{ verifications: Array<{ providerReference: string }> }>(amlBRes);
  for (const verification of verificationsB) {
    const body = JSON.stringify({ providerReference: verification.providerReference, outcome: "VERIFIED", reviewRequired: false });
    const webhookRes = await fetch(`${baseUrl}/api/aml/webhook`, { method: "POST", headers: amlWebhookHeaders(body), body });
    assert.equal(webhookRes.status, 200);
  }
  const goLiveB = await postJson(`/properties/${propertyB}/go-live`, B.agent.cookie);
  assert.equal(goLiveB.status, 200);

  const [offerA, backupA, offerB] = await Promise.all([
    postJson(`/offers/by-property/${propertyA}`, A.agent.cookie, {
      offerPriceCents: 82000000,
      conditions: { depositCents: 4100000, settlementDate: "2027-03-10", conditions: "", additionalTerms: "Standard terms" },
      buyer: { firstName: "Bob", lastName: "Buyer", email: `buyer-a-${suffix}@example.com` },
    }),
    postJson(`/offers/by-property/${propertyA}`, A.agent.cookie, {
      offerPriceCents: 80000000,
      conditions: { depositCents: 4000000, settlementDate: "2027-04-01", conditions: "", additionalTerms: "" },
      buyer: { firstName: "Bea", lastName: "Backup", email: `backup-a-${suffix}@example.com` },
    }),
    postJson(`/offers/by-property/${propertyB}`, B.agent.cookie, {
      offerPriceCents: 50000000,
      conditions: { depositCents: 2500000, settlementDate: "2027-05-01", conditions: "", additionalTerms: "" },
      buyer: { firstName: "Beth", lastName: "Buyer", email: `buyer-b-${suffix}@example.com` },
    }),
  ]);
  assert.equal(offerA.status, 201);
  assert.equal(backupA.status, 201);
  assert.equal(offerB.status, 201);
  const { offer } = await bodyOf<{ offer: { id: number } }>(offerA);

  const acceptRes = await postJson(`/offers/${offer.id}/accept`, A.agent.cookie);
  assert.equal(acceptRes.status, 201);
  const { transaction } = await bodyOf<{ transaction: { id: number } }>(acceptRes);
  transactionA = transaction.id;

  const signRes = await postJson(`/transactions/${transactionA}/contract-signed`, A.agent.cookie);
  assert.equal(signRes.status, 200);
  const financeRes = await postJson(`/transactions/${transactionA}/finance-approved`, A.agent.cookie);
  assert.equal(financeRes.status, 200);

  const buyerAmlRes = await getJson(`/aml/by-property/${propertyA}`, A.agent.cookie);
  const { verifications: afterSign } = await bodyOf<{ verifications: Array<{ providerReference: string; status: string }> }>(buyerAmlRes);
  const buyerVerification = afterSign.find((verification) => verification.status !== "Complete");
  assert.ok(buyerVerification);
  const buyerBody = JSON.stringify({ providerReference: buyerVerification.providerReference, outcome: "VERIFIED", reviewRequired: false });
  const buyerWebhook = await fetch(`${baseUrl}/api/aml/webhook`, { method: "POST", headers: amlWebhookHeaders(buyerBody), body: buyerBody });
  assert.equal(buyerWebhook.status, 200);

  const solicitorRes = await postJson("/parties", A.agent.cookie, {
    propertyId: propertyA,
    role: "Solicitor",
    firstName: "Sarah",
    lastName: "Solicitor",
    email: `solicitor-${suffix}@example.com`,
  });
  assert.equal(solicitorRes.status, 201);
  const { party: solicitor } = await bodyOf<{ party: { id: number } }>(solicitorRes);
  const legalRes = await postJson(`/transactions/${transactionA}/legal-representatives`, A.agent.cookie, {
    buyerSolicitorPartyId: solicitor.id,
  });
  assert.equal(legalRes.status, 200);

  const addConditionRes = await postJson(`/transactions/${transactionA}/conditions`, A.agent.cookie, { description: "Subject to finance approval" });
  assert.equal(addConditionRes.status, 201);
  const { condition } = await bodyOf<{ condition: { id: number } }>(addConditionRes);
  const exchangeRes = await postJson(`/transactions/${transactionA}/exchange`, A.agent.cookie);
  assert.equal(exchangeRes.status, 200);
  const resolveRes = await postJson(`/transactions/conditions/${condition.id}/resolve`, A.agent.cookie, { status: "Satisfied" });
  assert.equal(resolveRes.status, 200);

  const scheduleRes = await postJson(`/transactions/${transactionA}/settlement-schedule`, A.agent.cookie, { settlementDate: "2027-03-10" });
  assert.equal(scheduleRes.status, 200);
  const completeRes = await postJson(`/transactions/${transactionA}/settlement-complete`, A.admin.cookie);
  assert.equal(completeRes.status, 200);
  const fundsRes = await postJson(`/transactions/${transactionA}/funds-received`, A.admin.cookie, { amountCents: 82000000 });
  assert.equal(fundsRes.status, 200);
  const paidRes = await postJson(`/transactions/${transactionA}/agent-paid`, A.admin.cookie);
  assert.equal(paidRes.status, 200);

  const [task] = await db
    .insert(automationTasks)
    .values({
      brokerageId: A.brokerageId,
      propertyId: propertyA,
      transactionId: transactionA,
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
      propertyId: propertyA,
      transactionId: transactionA,
      reasonCode: "OTHER",
      summary: "Confirm commission invoice raised",
      status: "OPEN",
    })
    .returning();
  const completeTask = await postJson(`/tasks/${task.id}/complete`, A.agent.cookie);
  assert.equal(completeTask.status, 200);
  const resolveItem = await postJson(`/tasks/attention-items/${item.id}/resolve`, A.agent.cookie, { notes: "Invoice raised" });
  assert.equal(resolveItem.status, 200);

  const closeRes = await postJson(`/transactions/${transactionA}/close`, A.admin.cookie);
  if (closeRes.status !== 200) {
    assert.equal(closeRes.status, 409);
    const forced = await postJson(`/transactions/${transactionA}/close`, A.admin.cookie, { force: true });
    assert.equal(forced.status, 200);
  }
});

test("every Run audit row for the journey carries that brokerage and no other", async () => {
  async function ownedRows(propertyId: number, packageId: number, transactionId: number) {
    const rows = await db
      .select()
      .from(auditLogs)
      .where(
        or(
          eq(auditLogs.propertyId, propertyId),
          and(eq(auditLogs.recordType, "document_package"), eq(auditLogs.recordId, String(packageId))),
          transactionId > 0
            ? and(eq(auditLogs.recordType, "transaction"), eq(auditLogs.recordId, String(transactionId)))
            : eq(auditLogs.propertyId, propertyId),
        ),
      );
    return rows.filter((row) => OWNED_RECORD_TYPES.has(row.recordType));
  }

  const rowsA = await ownedRows(propertyA, packageA, transactionA);
  const rowsB = await ownedRows(propertyB, packageB, 0);
  assert.ok(rowsA.length > 0, "brokerage A must have written Run audit rows");
  assert.ok(rowsB.length > 0, "brokerage B must have written Run audit rows");

  const nullA = rowsA.filter((row) => row.brokerageId == null).map((row) => row.action);
  const nullB = rowsB.filter((row) => row.brokerageId == null).map((row) => row.action);
  assert.deepEqual(nullA, [], "brokerage A Run audit rows must not have a null brokerage_id");
  assert.deepEqual(nullB, [], "brokerage B Run audit rows must not have a null brokerage_id");
  assert.ok(rowsA.every((row) => row.brokerageId === A.brokerageId));
  assert.ok(rowsB.every((row) => row.brokerageId === B.brokerageId));
  assert.equal(rowsA.some((row) => row.brokerageId === B.brokerageId), false);
  assert.equal(rowsB.some((row) => row.brokerageId === A.brokerageId), false);

  const actionsA = new Set(rowsA.map((row) => row.action));
  for (const action of [
    "property_created",
    "PROPERTY_READY_TO_LIST",
    "agency_agreement_terms_updated",
    "document_version_generated",
    "document_package_sent_for_signature",
    "document_version_ingested_from_esign",
    "listing_live",
    "listing_details_updated",
    "offer_received",
    "offer_auto_declined",
    "offer_accepted",
    "contract_signed",
    "finance_approved",
    "transaction_legal_representatives_updated",
    "transaction_condition_added",
    "contract_exchanged",
    "transaction_condition_resolved",
    "transaction_unconditional",
    "settlement_scheduled",
    "settlement_completed",
    "commission_calculated",
    "funds_received",
    "agent_paid",
    "automation_task_completed",
    "automation_attention_item_resolved",
  ]) {
    assert.ok(actionsA.has(action), `expected audit action ${action}`);
  }
  assert.ok(actionsA.has("transaction_closed") || actionsA.has("transaction_closed_forced"));

  const actionsB = new Set(rowsB.map((row) => row.action));
  for (const action of ["property_created", "PROPERTY_READY_TO_LIST", "listing_details_updated", "offer_received", "listing_live"]) {
    assert.ok(actionsB.has(action), `expected brokerage B audit action ${action}`);
  }

  const packageDocuments = await db.select().from(documents).where(eq(documents.packageId, packageA));
  assert.ok(packageDocuments.length > 0);
  assert.ok(packageDocuments.every((document) => document.propertyId === propertyA));
  assert.ok(packageDocuments.every((document) => document.brokerageId == null));
});
