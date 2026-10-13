// R-F35b — Launch, AML, Documents, Ready to List, and Go Live require
// run.access. A brokerage with that grant revoked (the same setup as
// transactionRunAccess.test.ts) is denied on every newly gated route and
// nothing is written. Restoring the grant leaves the existing Run path
// working. Provider webhooks and the signed-download redemption stay
// open without a session. Grow appraisal workspace, the Grow -> Run
// handoff refusal, and Grow contact communications stay as they are for
// a brokerage that does not hold run.access.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  db,
  entitlementGrants,
  properties,
  propertyParties,
  workflows,
  amlVerifications,
  serviceOrders,
  documentPackages,
  documents,
  agencyAgreementTerms,
  launchPlans,
  campaignItems,
  portalDestinations,
  vendorApprovals,
  auditLogs,
  domainEvents,
  appraisals,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import {
  createBrokerageWithUsers,
  createListedProperty,
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

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function call(method: string, path: string, cookie?: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (cookie) init.headers = headers(cookie, body !== undefined);
  else if (body !== undefined) init.headers = { "content-type": "application/json" };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${baseUrl}/api${path}`, init);
}

async function setRunAccess(brokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

async function grant(brokerageId: number, entitlementKey: string): Promise<void> {
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

async function assertNotEntitled(res: Response, label: string): Promise<void> {
  const text = await res.text();
  assert.equal(res.status, 403, `${label} -> ${res.status} ${text}`);
  const body = JSON.parse(text) as { error?: string; entitlementKey?: string; reason?: string; upgrade?: { action?: string; productCode?: string } };
  assert.equal(body.error, "Not entitled", label);
  assert.equal(body.reason, "ENTITLEMENT_MISSING", label);
  assert.equal(body.entitlementKey, "run.access", label);
  assert.deepEqual(body.upgrade, { action: "grow.checkout", productCode: "grow" }, label);
}

async function count(table: Parameters<ReturnType<typeof db.select>["from"]>[0], where: SQL | undefined): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table).where(where);
  return Number(row.n);
}

async function runPropertySnapshot(propertyId: number, brokerageId: number) {
  const [property] = await db
    .select({ workflowStage: properties.workflowStage, listingStatus: properties.listingStatus })
    .from(properties)
    .where(eq(properties.id, propertyId));
  const propertyWhere = eq(workflows.propertyId, propertyId);
  return {
    property,
    workflows: await count(workflows, propertyWhere),
    aml: await count(amlVerifications, eq(amlVerifications.propertyId, propertyId)),
    serviceOrders: await count(serviceOrders, eq(serviceOrders.propertyId, propertyId)),
    packages: await count(documentPackages, eq(documentPackages.propertyId, propertyId)),
    documents: await count(documents, eq(documents.propertyId, propertyId)),
    terms: await count(agencyAgreementTerms, eq(agencyAgreementTerms.propertyId, propertyId)),
    audits: await count(auditLogs, eq(auditLogs.propertyId, propertyId)),
    events: await count(domainEvents, eq(domainEvents.propertyId, propertyId)),
    sellerLinks: await count(propertyParties, and(eq(propertyParties.propertyId, propertyId), eq(propertyParties.role, "Seller"))),
    launchPlans: await count(launchPlans, eq(launchPlans.brokerageId, brokerageId)),
    campaignItems: await count(campaignItems, eq(campaignItems.brokerageId, brokerageId)),
    portals: await count(portalDestinations, eq(portalDestinations.brokerageId, brokerageId)),
    approvals: await count(vendorApprovals, eq(vendorApprovals.brokerageId, brokerageId)),
  };
}

function amlWebhookHeaders(body: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    "content-type": "application/json",
    "x-aml-timestamp": timestamp,
    "x-aml-signature": createHmac("sha256", process.env.AML_WEBHOOK_SECRET!).update(`${timestamp}.`).update(body).digest("hex"),
  };
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { registerExceptionEngine } = await import("../../lib/exceptions/bootstrap.js");
  registerExceptionEngine({ startScheduler: false });
  const { registerLaunchEngine } = await import("../../lib/launch/bootstrap.js");
  registerLaunchEngine();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `Run Lane Access ${suffix}`);
  await grant(A.brokerageId, "grow.access");
  await grant(A.brokerageId, "grow.opportunities.manage");
  await grant(A.brokerageId, "grow.contacts.read");
  await grant(A.brokerageId, "grow.contacts.manage");
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("an unauthenticated Run-lane read is 401 before the entitlement gate", async () => {
  const res = await fetch(`${baseUrl}/api/properties/1/launch`);
  assert.equal(res.status, 401);
  const aml = await fetch(`${baseUrl}/api/aml/by-property/1`);
  assert.equal(aml.status, 401);
  const docs = await fetch(`${baseUrl}/api/documents/packages/by-property/1`);
  assert.equal(docs.status, 401);
  const ready = await fetch(`${baseUrl}/api/properties/1/ready-to-list`, { method: "POST" });
  assert.equal(ready.status, 401);
});

test("without run.access every newly gated route is denied and writes nothing; webhooks stay open; Grow matches today; with run.access the Run path still completes", async () => {
  const cookie = A.agent.cookie;
  const propRes = await call("POST", "/properties", cookie, {
    formattedAddress: `${suffix} Run Lane St`,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(propRes.status, 201, await propRes.clone().text());
  const propertyId = ((await propRes.json()) as { property: { id: number } }).property.id;

  const sellerRes = await call("POST", "/parties", cookie, {
    propertyId,
    role: "Seller",
    firstName: "Sam",
    lastName: "Seller",
    email: `seller-run-lane-${suffix}@example.com`,
  });
  assert.equal(sellerRes.status, 201, await sellerRes.clone().text());
  const sellerPartyId = ((await sellerRes.json()) as { party: { id: number } }).party.id;

  const webhookPropRes = await call("POST", "/properties", cookie, {
    formattedAddress: `${suffix} Webhook Lane`,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(webhookPropRes.status, 201);
  const webhookPropertyId = ((await webhookPropRes.json()) as { property: { id: number } }).property.id;
  const buyerRes = await call("POST", "/parties", cookie, {
    propertyId: webhookPropertyId,
    role: "Buyer",
    firstName: "Bea",
    lastName: "Buyer",
    email: `buyer-run-lane-${suffix}@example.com`,
  });
  assert.equal(buyerRes.status, 201);
  const buyerPartyId = ((await buyerRes.json()) as { party: { id: number } }).party.id;
  const amlSeed = await call("POST", "/aml/request", cookie, { propertyId: webhookPropertyId, partyId: buyerPartyId });
  assert.equal(amlSeed.status, 201, await amlSeed.clone().text());
  const seeded = ((await amlSeed.json()) as { verification: { id: number; status: string; providerReference: string } }).verification;
  assert.equal(seeded.status, "Awaiting Seller");

  await setRunAccess(A.brokerageId, false);
  try {
    const before = await runPropertySnapshot(propertyId, A.brokerageId);
    const [seededBefore] = await db
      .select({ status: amlVerifications.status })
      .from(amlVerifications)
      .where(eq(amlVerifications.id, seeded.id));

    const fakePlan = "00000000-0000-4000-8000-000000000001";
    const fakeItem = "00000000-0000-4000-8000-000000000002";
    const fakeApproval = "00000000-0000-4000-8000-000000000003";
    const fakeDest = "00000000-0000-4000-8000-000000000004";
    const missingId = 2_147_483_646;
    const denied: Array<{ method: string; path: string; body?: unknown; label: string }> = [
      { method: "GET", path: `/properties/${propertyId}/launch`, label: "GET /properties/:propertyId/launch" },
      { method: "POST", path: `/properties/${propertyId}/launch`, label: "POST /properties/:propertyId/launch" },
      { method: "GET", path: `/launch/${fakePlan}/transitions`, label: "GET /launch/:id/transitions" },
      { method: "POST", path: `/launch/${fakePlan}/template`, body: { templateType: "AUCTION" }, label: "POST /launch/:id/template" },
      { method: "POST", path: `/launch/${fakePlan}/target-date`, body: { targetLaunchDate: "2027-06-01" }, label: "POST /launch/:id/target-date" },
      { method: "POST", path: `/launch/${fakePlan}/pause`, body: { reason: "Hold" }, label: "POST /launch/:id/pause" },
      { method: "POST", path: `/launch/${fakePlan}/resume`, label: "POST /launch/:id/resume" },
      { method: "POST", path: `/launch/${fakePlan}/cancel`, body: { reason: "Stop" }, label: "POST /launch/:id/cancel" },
      {
        method: "POST",
        path: `/launch/${fakePlan}/campaign-items`,
        body: { itemType: "PHOTOGRAPHY", title: "Photography" },
        label: "POST /launch/:id/campaign-items",
      },
      {
        method: "POST",
        path: `/launch/campaign-items/${fakeItem}/status`,
        body: { status: "COMPLETE" },
        label: "POST /launch/campaign-items/:itemId/status",
      },
      {
        method: "POST",
        path: `/launch/campaign-items/${fakeItem}/responsibility`,
        body: { ownerType: "LISTING_AGENT", ownerUserId: null },
        label: "POST /launch/campaign-items/:itemId/responsibility",
      },
      {
        method: "POST",
        path: `/launch/campaign-items/${fakeItem}/vendor-cost`,
        body: { vendorName: "Studio", costCents: 1000 },
        label: "POST /launch/campaign-items/:itemId/vendor-cost",
      },
      {
        method: "POST",
        path: `/launch/campaign-items/${fakeItem}/evidence`,
        body: { label: "Proof", url: "https://example.com/proof" },
        label: "POST /launch/campaign-items/:itemId/evidence",
      },
      {
        method: "POST",
        path: `/launch/${fakePlan}/vendor-approvals`,
        body: { approvalType: "BUDGET", requestedAmountCents: 1000 },
        label: "POST /launch/:id/vendor-approvals",
      },
      {
        method: "POST",
        path: `/launch/vendor-approvals/${fakeApproval}/decide`,
        body: { decision: "APPROVED" },
        label: "POST /launch/vendor-approvals/:approvalId/decide",
      },
      { method: "POST", path: `/launch/${fakePlan}/budget`, body: { budgetCents: 100000 }, label: "POST /launch/:id/budget" },
      {
        method: "POST",
        path: `/launch/${fakePlan}/portal-destinations`,
        body: { portalName: "Example" },
        label: "POST /launch/:id/portal-destinations",
      },
      { method: "POST", path: `/launch/portal-destinations/${fakeDest}/submit`, body: {}, label: "POST /launch/portal-destinations/:destId/submit" },
      {
        method: "POST",
        path: `/launch/portal-destinations/${fakeDest}/fail`,
        body: { failureReason: "Rejected" },
        label: "POST /launch/portal-destinations/:destId/fail",
      },
      { method: "POST", path: `/launch/portal-destinations/${fakeDest}/live`, body: {}, label: "POST /launch/portal-destinations/:destId/live" },
      { method: "POST", path: `/launch/${fakePlan}/market-ready/evaluate`, label: "POST /launch/:id/market-ready/evaluate" },
      {
        method: "POST",
        path: `/launch/${fakePlan}/market-ready/override`,
        body: { reason: "Override" },
        label: "POST /launch/:id/market-ready/override",
      },
      { method: "POST", path: `/launch/${fakePlan}/confirm-live`, label: "POST /launch/:id/confirm-live" },
      {
        method: "POST",
        path: "/aml/request",
        body: { propertyId, partyId: sellerPartyId },
        label: "POST /aml/request",
      },
      { method: "GET", path: `/aml/by-property/${propertyId}`, label: "GET /aml/by-property/:propertyId" },
      {
        method: "POST",
        path: `/aml/${missingId}/resolve-exception`,
        body: { notes: "Reviewed" },
        label: "POST /aml/:verificationId/resolve-exception",
      },
      { method: "POST", path: `/aml/${missingId}/retry`, label: "POST /aml/:verificationId/retry" },
      { method: "GET", path: `/aml/service-orders/by-property/${propertyId}`, label: "GET /aml/service-orders/by-property/:propertyId" },
      {
        method: "PUT",
        path: `/documents/agency-agreement-terms/${propertyId}`,
        body: { commissionType: "Percentage", commissionRateBps: 220, agreementTermDays: 90 },
        label: "PUT /documents/agency-agreement-terms/:propertyId",
      },
      { method: "GET", path: `/documents/agency-agreement-terms/${propertyId}`, label: "GET /documents/agency-agreement-terms/:propertyId" },
      { method: "POST", path: `/documents/packages/${missingId}/populate`, label: "POST /documents/packages/:packageId/populate" },
      { method: "POST", path: `/documents/packages/${missingId}/send-for-signature`, label: "POST /documents/packages/:packageId/send-for-signature" },
      { method: "GET", path: `/documents/${missingId}/content`, label: "GET /documents/:documentId/content" },
      { method: "POST", path: `/documents/${missingId}/versions`, label: "POST /documents/:documentId/versions" },
      { method: "POST", path: `/documents/${missingId}/signed-download`, label: "POST /documents/:documentId/signed-download" },
      { method: "POST", path: `/documents/${missingId}/quarantine`, label: "POST /documents/:documentId/quarantine" },
      { method: "DELETE", path: `/documents/${missingId}`, label: "DELETE /documents/:documentId" },
      { method: "GET", path: `/documents/packages/by-property/${propertyId}`, label: "GET /documents/packages/by-property/:propertyId" },
      { method: "POST", path: `/properties/${propertyId}/ready-to-list`, label: "POST /properties/:id/ready-to-list" },
      { method: "POST", path: `/properties/${propertyId}/go-live`, label: "POST /properties/:id/go-live" },
    ];

    assert.equal(denied.length, 40, "every newly gated route is in the denial list");
    for (const entry of denied) {
      await assertNotEntitled(await call(entry.method, entry.path, cookie, entry.body), entry.label);
    }

    assert.deepEqual(await runPropertySnapshot(propertyId, A.brokerageId), before);
    const [seededAfterDenial] = await db
      .select({ status: amlVerifications.status })
      .from(amlVerifications)
      .where(eq(amlVerifications.id, seeded.id));
    assert.equal(seededAfterDenial.status, seededBefore.status);

    const amlBody = JSON.stringify({ providerReference: seeded.providerReference, outcome: "VERIFIED", reviewRequired: false });
    const amlWebhook = await fetch(`${baseUrl}/api/aml/webhook`, { method: "POST", headers: amlWebhookHeaders(amlBody), body: amlBody });
    assert.equal(amlWebhook.status, 200, await amlWebhook.clone().text());
    const amlWebhookBody = (await amlWebhook.json()) as { processed: boolean };
    assert.equal(amlWebhookBody.processed, true);
    const [seededAfterWebhook] = await db
      .select({ status: amlVerifications.status })
      .from(amlVerifications)
      .where(eq(amlVerifications.id, seeded.id));
    assert.equal(seededAfterWebhook.status, "Complete");

    const esignBody = JSON.stringify({ providerReference: `missing-${suffix}`, status: "Completed" });
    const esignWebhook = await fetch(`${baseUrl}/api/documents/webhook`, {
      method: "POST",
      headers: signedSandboxEsignWebhookHeaders(esignBody),
      body: esignBody,
    });
    assert.equal(esignWebhook.status, 200, await esignWebhook.clone().text());
    const esignWebhookBody = (await esignWebhook.json()) as { reason: string };
    assert.equal(esignWebhookBody.reason, "signature_request_not_found");

    const redeem = await fetch(`${baseUrl}/api/documents/signed-download/1?expires=1&signature=not-a-real-signature`);
    assert.equal(redeem.status, 404);
    const redeemBody = (await redeem.json()) as { error?: string; entitlementKey?: string };
    assert.equal(redeemBody.entitlementKey, undefined);
    assert.notEqual(redeemBody.error, "Not entitled");

    const growPropRes = await call("POST", "/properties", cookie, {
      formattedAddress: `${suffix} Grow Lane`,
      state: "NSW",
      suburb: "Testville",
      postcode: "2000",
    });
    assert.equal(growPropRes.status, 201, await growPropRes.clone().text());
    const growPropertyId = ((await growPropRes.json()) as { property: { id: number } }).property.id;
    const growPartyRes = await call("POST", "/parties", cookie, {
      propertyId: growPropertyId,
      role: "Buyer",
      firstName: "Gail",
      lastName: "Grow",
      email: `grow-run-lane-${suffix}@example.com`,
    });
    assert.equal(growPartyRes.status, 201, await growPartyRes.clone().text());
    const growPartyId = ((await growPartyRes.json()) as { party: { id: number } }).party.id;

    const createdAppraisal = await call("POST", "/grow/appraisals/from-contact", cookie, {
      partyId: growPartyId,
      propertyId: growPropertyId,
    });
    assert.equal(createdAppraisal.status, 201, await createdAppraisal.clone().text());
    const appraisalId = ((await createdAppraisal.json()) as { appraisal: { id: number; status: string } }).appraisal.id;

    const workspace = await call("GET", `/grow/appraisals/${appraisalId}`, cookie);
    assert.equal(workspace.status, 200, await workspace.clone().text());
    const patched = await call("PATCH", `/grow/appraisals/${appraisalId}`, cookie, {
      pricingCommentary: "Still a Grow workspace without run.access.",
    });
    assert.equal(patched.status, 200, await patched.clone().text());

    const sellerLinksBeforeHandoff = await count(
      propertyParties,
      and(eq(propertyParties.propertyId, growPropertyId), eq(propertyParties.role, "Seller")),
    );
    const handoff = await call("POST", `/grow/appraisals/${appraisalId}/run-handoff`, cookie, {});
    await assertNotEntitled(handoff, "POST /grow/appraisals/:id/run-handoff");
    const sellerLinksAfterHandoff = await count(
      propertyParties,
      and(eq(propertyParties.propertyId, growPropertyId), eq(propertyParties.role, "Seller")),
    );
    assert.equal(sellerLinksAfterHandoff, sellerLinksBeforeHandoff);
    const [appraisalRow] = await db
      .select({ status: appraisals.status, pricingCommentary: appraisals.pricingCommentary })
      .from(appraisals)
      .where(eq(appraisals.id, appraisalId));
    assert.equal(appraisalRow.status, "DRAFT");
    assert.equal(appraisalRow.pricingCommentary, "Still a Grow workspace without run.access.");

    const threadRes = await call("POST", `/grow/contacts/${growPartyId}/communications/threads`, cookie, {
      subject: "Grow communications without run.access",
    });
    assert.equal(threadRes.status, 201, await threadRes.clone().text());
    const thread = (await threadRes.json()) as { id: number; propertyId: number | null };
    assert.equal(thread.propertyId, null);
    const participantRes = await call("POST", `/communications/threads/${thread.id}/participants`, cookie, {
      partyId: growPartyId,
      role: "Other",
    });
    assert.equal(participantRes.status, 201, await participantRes.clone().text());
    const participantId = ((await participantRes.json()) as { id: number }).id;
    const draft = await call("POST", `/communications/threads/${thread.id}/messages`, cookie, {
      channel: "EMAIL",
      classification: "TRANSACTIONAL",
      bodyText: "Grow draft without run.access.",
      recipientParticipantId: participantId,
    });
    assert.equal(draft.status, 201, await draft.clone().text());

    const timeline = await call("GET", `/properties/${growPropertyId}/timeline`, cookie);
    assert.equal(timeline.status, 200, await timeline.clone().text());
    const propertyRead = await call("GET", `/properties/${propertyId}`, cookie);
    assert.equal(propertyRead.status, 200);

    // R-F43 — the brokerage exception list is a Run read. It was left open
    // by R-F35b and is now the same entitlement 403.
    const exceptions = await call("GET", "/exceptions", cookie);
    await assertNotEntitled(exceptions, "GET /exceptions");

    await setRunAccess(A.brokerageId, true);

    const listed = await createListedProperty(baseUrl, cookie, {
      address: `${suffix} Listed Lane`,
      sellerEmail: `listed-run-lane-${suffix}@example.com`,
    });
    const launch = await call("GET", `/properties/${listed.propertyId}/launch`, cookie);
    assert.equal(launch.status, 200, await launch.clone().text());
    const amlList = await call("GET", `/aml/by-property/${listed.propertyId}`, cookie);
    assert.equal(amlList.status, 200);
    const packages = await call("GET", `/documents/packages/by-property/${listed.propertyId}`, cookie);
    assert.equal(packages.status, 200);
    const goLiveAgain = await call("POST", `/properties/${listed.propertyId}/go-live`, cookie);
    assert.equal(goLiveAgain.status, 200, await goLiveAgain.clone().text());
  } finally {
    await setRunAccess(A.brokerageId, true);
  }
});
