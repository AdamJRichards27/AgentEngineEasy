// R-F39 focused coverage for Run audit writes the Ready-to-List-through-Close
// slice does not reach: launch model actions, Pit Crew claim and handoff,
// AML exception resolve and retry, the e-sign completion audits in
// lib/documents.ts, and document-storage failure audits.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { ObjectStorageProvider } from "@aee/integration-object-storage";
import { and, eq, inArray } from "drizzle-orm";
import { db, auditLogs } from "@aee/db";
import {
  ingestDocumentVersion,
  setDocumentStorageProviderForTests,
} from "../documentStorage.js";
import {
  getOrCreateLaunchPlan,
  getLaunchPlanDetail,
  applyTemplate,
  setTargetLaunchDate,
  addCampaignItem,
  updateCampaignItemStatus,
  assignResponsibility,
  recordVendorAndCost,
  attachCampaignItemEvidence,
  setBudget,
  addPortalDestination,
  recordPortalSubmission,
  recordPortalFailure,
  confirmPortalLive,
  evaluateAndUpdateMarketReady,
  overrideMarketReady,
  confirmLaunchLive,
  pauseLaunchPlan,
  resumeLaunchPlan,
  cancelLaunchPlan,
  decideVendorApproval,
} from "../launch/model.js";
import type { ActorRef } from "../launch/types.js";
import { claimWorkItem, handoffWorkItem } from "../pitCrew/assignment.js";
import { createOrUpdateException, newCorrelationId } from "../exceptions/model.js";
import type { RiskFinding } from "../exceptions/types.js";
import {
  createBrokerageWithUsers,
  createListedProperty,
  cleanupBrokerages,
  type DevLoginResult,
} from "../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.AML_WEBHOOK_SECRET = "aml-webhook-test-secret";

class MemoryStorage implements ObjectStorageProvider {
  readonly objects = new Map<string, Buffer>();
  failNextPut: Error | null = null;
  lieAboutChecksum = false;

  async putObject(key: string, content: string | Buffer) {
    if (this.failNextPut) {
      const error = this.failNextPut;
      this.failNextPut = null;
      throw error;
    }
    this.objects.set(key, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content));
    return { key };
  }
  async getObject(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) {
      const error = new Error(`Missing object ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return Buffer.from(bytes);
  }
  async headObject(key: string) {
    const bytes = await this.getObject(key);
    const checksumSha256 = this.lieAboutChecksum
      ? "0".repeat(64)
      : createHash("sha256").update(bytes).digest("hex");
    if (this.lieAboutChecksum) this.lieAboutChecksum = false;
    return { key, size: bytes.length, checksumSha256 };
  }
  async deleteObject(key: string) {
    this.objects.delete(key);
  }
  async createSignedDownload(key: string, expiresInSeconds = 300) {
    await this.headObject(key);
    return { url: `memory://${encodeURIComponent(key)}`, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }
  async verifyIntegrity(key: string) {
    const bytes = await this.getObject(key);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    return { valid: true, expectedChecksum: checksum, actualChecksum: checksum };
  }
  async checkReadiness() {
    return { ready: true };
  }
}

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
const storage = new MemoryStorage();

function actorOf(login: DevLoginResult): ActorRef {
  return { id: login.user.id, role: login.user.role };
}

async function waitForPlan(propertyId: number, brokerageId: number) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const detail = await getLaunchPlanDetail(propertyId, brokerageId);
    if (detail) return detail;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const created = await getOrCreateLaunchPlan(propertyId, brokerageId, null);
  return getLaunchPlanDetail(created.plan.propertyId, brokerageId);
}

before(async () => {
  setDocumentStorageProviderForTests(storage);
  const { configureEvents } = await import("../events.js");
  configureEvents();
  const { registerLaunchEngine } = await import("../launch/bootstrap.js");
  registerLaunchEngine();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `Run Audit Paths A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Run Audit Paths B ${suffix}`);
});

after(async () => {
  setDocumentStorageProviderForTests(null);
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function auditsForProperty(propertyId: number, recordTypes: string[]) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.propertyId, propertyId), inArray(auditLogs.recordType, recordTypes)));
}

test("launch model actions record the plan's brokerage", async () => {
  const actor = actorOf(A.agent);
  const admin = actorOf(A.admin);
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `1 Launch Audit St ${suffix}` });
  const detail = await waitForPlan(propertyId, A.brokerageId);
  assert.ok(detail);

  await pauseLaunchPlan(detail.plan.id, A.brokerageId, actor, "Hold for vendor.");
  await resumeLaunchPlan(detail.plan.id, A.brokerageId, actor);
  await setBudget(detail.plan.id, A.brokerageId, admin, 100000);
  await setTargetLaunchDate(detail.plan.id, A.brokerageId, actor, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
  await applyTemplate(detail.plan.id, A.brokerageId, actor, "OFF_MARKET");
  const extra = await addCampaignItem(detail.plan.id, A.brokerageId, actor, { itemType: "PHOTOGRAPHY", title: "Extra photography" });
  await assignResponsibility(extra.id, A.brokerageId, actor, "LISTING_AGENT", actor.id);
  await attachCampaignItemEvidence(extra.id, A.brokerageId, actor, "Shoot sheet", "https://example.com/shoot");

  const afterTemplate = await getLaunchPlanDetail(propertyId, A.brokerageId);
  assert.ok(afterTemplate);
  for (const item of afterTemplate.items) {
    if (item.status !== "COMPLETE") {
      await updateCampaignItemStatus(item.id, A.brokerageId, actor, "COMPLETE");
    }
  }

  const primary = await addPortalDestination(detail.plan.id, A.brokerageId, actor, "realestate.com.au");
  const secondary = await addPortalDestination(detail.plan.id, A.brokerageId, actor, "Domain");
  await recordPortalSubmission(primary.id, A.brokerageId, actor);
  await confirmPortalLive(primary.id, A.brokerageId, actor);
  await recordPortalSubmission(secondary.id, A.brokerageId, actor);
  await recordPortalFailure(secondary.id, A.brokerageId, actor, "Portal rejected the listing.");

  const marketReady = await evaluateAndUpdateMarketReady(detail.plan.id, A.brokerageId, actor);
  assert.equal(marketReady.ready, true, `expected Market Ready before the budget breach, got ${JSON.stringify(marketReady.blockers)}`);

  await recordVendorAndCost(extra.id, A.brokerageId, actor, "Acme Photography", 150000);
  const withApproval = await getLaunchPlanDetail(propertyId, A.brokerageId);
  const approval = withApproval?.approvals.find((row) => row.status === "PENDING");
  assert.ok(approval, "crossing the cost threshold must raise a vendor approval");
  await decideVendorApproval(approval.id, A.brokerageId, admin, "APPROVED", 150000, "Approved over budget.");
  await overrideMarketReady(detail.plan.id, A.brokerageId, admin, "Proceed with the approved overage.");
  await confirmLaunchLive(detail.plan.id, A.brokerageId, actor);

  const { propertyId: otherPropertyId } = await createListedProperty(baseUrl, B.agent.cookie, { address: `2 Launch Audit St ${suffix}` });
  const other = await waitForPlan(otherPropertyId, B.brokerageId);
  assert.ok(other);
  await cancelLaunchPlan(other.plan.id, B.brokerageId, actorOf(B.agent), "Vendor withdrew.");

  const launchTypes = ["launch_plan", "campaign_item", "portal_destination", "vendor_approval"];
  const rowsA = await auditsForProperty(propertyId, launchTypes);
  const rowsB = await auditsForProperty(otherPropertyId, launchTypes);
  const actionsA = new Set(rowsA.map((row) => row.action));
  for (const action of [
    "launch_plan_created",
    "launch_paused",
    "launch_resumed",
    "launch_budget_set",
    "launch_target_date_changed",
    "launch_template_applied",
    "campaign_item_added",
    "campaign_item_responsibility_assigned",
    "campaign_item_evidence_attached",
    "campaign_item_status_changed",
    "portal_destination_added",
    "portal_submission_recorded",
    "portal_confirmed_live",
    "portal_submission_failed",
    "launch_market_ready_achieved",
    "campaign_item_vendor_cost_recorded",
    "launch_budget_exceeded",
    "vendor_approval_requested",
    "vendor_approval_decided",
    "market_ready_overridden",
    "launch_listing_live_confirmed",
  ]) {
    assert.ok(actionsA.has(action), `expected launch audit ${action}`);
  }
  assert.ok(rowsA.every((row) => row.brokerageId === A.brokerageId));
  assert.ok(rowsB.some((row) => row.action === "launch_cancelled"));
  assert.ok(rowsB.every((row) => row.brokerageId === B.brokerageId));
  assert.equal(rowsA.some((row) => row.brokerageId == null || row.brokerageId === B.brokerageId), false);
});

test("Pit Crew claim and handoff record the work item brokerage", async () => {
  async function createProperty(cookie: string, address: string): Promise<number> {
    const res = await fetch(`${baseUrl}/api/properties`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
    });
    assert.equal(res.status, 201);
    const { property } = (await res.json()) as { property: { id: number } };
    return property.id;
  }

  const propertyId = await createProperty(A.agent.cookie, `1 Pit Crew Audit St ${suffix}`);
  const otherPropertyId = await createProperty(B.agent.cookie, `2 Pit Crew Audit St ${suffix}`);
  const finding = (targetPropertyId: number, targetBrokerageId: number, key: string): RiskFinding => ({
    ruleId: "TEST_RF39_PITCREW_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `RF39 pit crew ${key}`,
    problemDescription: "A test problem.",
    businessImpact: "Test impact.",
    detectedCause: "Test cause.",
    ownerType: "UNASSIGNED_QUEUE",
    ownerUserId: null,
    propertyId: targetPropertyId,
    transactionId: null,
    dueAt: null,
    escalatesAt: null,
    recommendedAction: "Do the test thing.",
    resolutionRequirements: "The test condition clears.",
    dismissible: true,
    sourceRecordType: "property",
    sourceRecordId: String(targetPropertyId),
    dedupKey: `TEST_RF39_PITCREW_RULE:${targetBrokerageId}:${key}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
  });

  const sourceA = (await createOrUpdateException(finding(propertyId, A.brokerageId, "A"), A.brokerageId, propertyId, null, newCorrelationId(), null)).exception.id;
  const sourceB = (await createOrUpdateException(finding(otherPropertyId, B.brokerageId, "B"), B.brokerageId, otherPropertyId, null, newCorrelationId(), null)).exception.id;

  const claimed = await claimWorkItem({
    brokerageId: A.brokerageId,
    propertyId,
    sourceType: "EXCEPTION",
    sourceRecordId: sourceA,
    expectedVersion: 0,
    actorUserId: A.agent.user.id,
  });
  await handoffWorkItem({
    brokerageId: A.brokerageId,
    propertyId,
    sourceType: "EXCEPTION",
    sourceRecordId: sourceA,
    expectedVersion: claimed.version,
    actorUserId: A.agent.user.id,
    toUserId: A.admin.user.id,
    note: "Handing to the administrator.",
  });
  await claimWorkItem({
    brokerageId: B.brokerageId,
    propertyId: otherPropertyId,
    sourceType: "EXCEPTION",
    sourceRecordId: sourceB,
    expectedVersion: 0,
    actorUserId: B.agent.user.id,
  });

  const rowsA = await db.select().from(auditLogs).where(and(eq(auditLogs.recordId, sourceA), inArray(auditLogs.action, ["PC_CLAIMED", "PC_HANDOFF"])));
  const rowsB = await db.select().from(auditLogs).where(and(eq(auditLogs.recordId, sourceB), eq(auditLogs.action, "PC_CLAIMED")));
  assert.equal(rowsA.filter((row) => row.action === "PC_CLAIMED").length, 1);
  assert.equal(rowsA.filter((row) => row.action === "PC_HANDOFF").length, 1);
  assert.ok(rowsA.every((row) => row.brokerageId === A.brokerageId));
  assert.ok(rowsB.every((row) => row.brokerageId === B.brokerageId));
});

test("AML exception resolve and retry record the caller's brokerage", async () => {
  async function seedFailed(cookie: string, address: string) {
    const propertyRes = await fetch(`${baseUrl}/api/properties`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
    });
    assert.equal(propertyRes.status, 201);
    const { property } = (await propertyRes.json()) as { property: { id: number } };
    const partyRes = await fetch(`${baseUrl}/api/parties`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        propertyId: property.id,
        role: "Buyer",
        firstName: "Ada",
        lastName: "Buyer",
        email: `aml-${property.id}-${suffix}@example.com`,
      }),
    });
    assert.equal(partyRes.status, 201);
    const { party } = (await partyRes.json()) as { party: { id: number } };
    const requestRes = await fetch(`${baseUrl}/api/aml/request`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ propertyId: property.id, partyId: party.id }),
    });
    assert.equal(requestRes.status, 201);
    const { verification } = (await requestRes.json()) as { verification: { id: number; providerReference: string } };
    const body = JSON.stringify({ providerReference: verification.providerReference, outcome: "UNABLE_TO_VERIFY", reviewRequired: false });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const webhook = await fetch(`${baseUrl}/api/aml/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aml-timestamp": timestamp,
        "x-aml-signature": createHmac("sha256", process.env.AML_WEBHOOK_SECRET!).update(`${timestamp}.`).update(body).digest("hex"),
      },
      body,
    });
    assert.equal(webhook.status, 200);
    return { propertyId: property.id, verificationId: verification.id };
  }

  const resolved = await seedFailed(A.agent.cookie, `1 AML Audit St ${suffix}`);
  const retried = await seedFailed(A.agent.cookie, `2 AML Audit St ${suffix}`);
  const other = await seedFailed(B.agent.cookie, `3 AML Audit St ${suffix}`);

  const resolveRes = await fetch(`${baseUrl}/api/aml/${resolved.verificationId}/resolve-exception`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ notes: "Reviewed with the provider." }),
  });
  assert.equal(resolveRes.status, 200);
  const retryRes = await fetch(`${baseUrl}/api/aml/${retried.verificationId}/retry`, {
    method: "POST",
    headers: { cookie: A.agent.cookie },
  });
  assert.equal(retryRes.status, 200);
  const otherResolve = await fetch(`${baseUrl}/api/aml/${other.verificationId}/resolve-exception`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.admin.cookie },
    body: JSON.stringify({ notes: "Cleared for brokerage B." }),
  });
  assert.equal(otherResolve.status, 200);

  const rowsA = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.propertyId, resolved.propertyId), eq(auditLogs.action, "aml_exception_resolved")));
  const retryRows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.propertyId, retried.propertyId), eq(auditLogs.action, "aml_verification_retried")));
  const rowsB = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.propertyId, other.propertyId), eq(auditLogs.action, "aml_exception_resolved")));
  assert.equal(rowsA.length, 1);
  assert.equal(rowsA[0]?.brokerageId, A.brokerageId);
  assert.equal(retryRows.length, 1);
  assert.equal(retryRows[0]?.brokerageId, A.brokerageId);
  assert.equal(rowsB.length, 1);
  assert.equal(rowsB[0]?.brokerageId, B.brokerageId);
});

test("e-sign webhook completion audits record the property brokerage", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `1 Esign Audit St ${suffix}` });
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.propertyId, propertyId), eq(auditLogs.action, "document_version_ingested_from_esign")));
  assert.ok(rows.length > 0, "completed e-sign webhook must write an ingestion audit");
  assert.ok(rows.every((row) => row.brokerageId === A.brokerageId));
});

test("document storage failure audits record the brokerage passed into ingestion", async () => {
  const propertyRes = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ formattedAddress: `1 Storage Audit St ${suffix}`, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  assert.equal(propertyRes.status, 201);
  const { property } = (await propertyRes.json()) as { property: { id: number } };
  const seller = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({
      propertyId: property.id,
      role: "Seller",
      firstName: "Storage",
      lastName: "Seller",
      email: `storage-audit-${suffix}@example.com`,
    }),
  });
  assert.equal(seller.status, 201);
  const ready = await fetch(`${baseUrl}/api/properties/${property.id}/ready-to-list`, {
    method: "POST",
    headers: { cookie: A.agent.cookie },
  });
  assert.equal(ready.status, 200);
  const listing = await fetch(`${baseUrl}/api/documents/packages/by-property/${property.id}`, { headers: { cookie: A.agent.cookie } });
  const { documents: packageDocuments } = (await listing.json()) as { documents: Array<{ id: number }> };
  assert.ok(packageDocuments.length >= 2);
  const [writeDocumentId, integrityDocumentId] = [packageDocuments[0].id, packageDocuments[1].id];

  storage.failNextPut = new Error("deterministic object write failure");
  await assert.rejects(
    ingestDocumentVersion({
      documentId: writeDocumentId,
      brokerageId: A.brokerageId,
      actorUserId: A.agent.user.id,
      bytes: Buffer.from("retry this exact document"),
      originalFilename: "agreement.txt",
      declaredMimeType: "text/plain",
      source: "upload",
    }),
    /deterministic object write failure/,
  );

  storage.lieAboutChecksum = true;
  await assert.rejects(
    ingestDocumentVersion({
      documentId: integrityDocumentId,
      brokerageId: A.brokerageId,
      actorUserId: A.agent.user.id,
      bytes: Buffer.from("checksum mismatch document"),
      originalFilename: "mismatch.txt",
      declaredMimeType: "text/plain",
      source: "upload",
    }),
    /acknowledgement did not match/,
  );

  const rows = await db.select().from(auditLogs).where(eq(auditLogs.propertyId, property.id));
  const failed = rows.filter((row) => row.action === "document_version_storage_write_failed");
  const quarantined = rows.filter((row) => row.action === "document_version_integrity_quarantined");
  assert.equal(failed.length, 1);
  assert.equal(quarantined.length, 1);
  assert.equal(failed[0]?.brokerageId, A.brokerageId);
  assert.equal(quarantined[0]?.brokerageId, A.brokerageId);
  assert.ok(rows.filter((row) => row.recordType === "document_object_version").every((row) => row.brokerageId === A.brokerageId));
});
