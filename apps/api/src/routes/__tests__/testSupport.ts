import { eq, inArray } from "drizzle-orm";
import {
  db,
  users,
  brokerages,
  parties,
  properties,
  propertyParties,
  workflows,
  workflowSteps,
  amlVerifications,
  serviceOrders,
  documentPackages,
  documents,
  signatureRequests,
  agencyAgreementTerms,
  offers,
  transactions,
  auditLogs,
  domainEvents,
  entitlementGrants,
  aiActionRequests,
  growRelationships,
  growActivities,
  growOpportunities,
  importJobs,
  importRecords,
} from "@aee/db";

// Foundation Remediation Stage 4: shared helpers for the new lifecycle test
// suites (properties/offers/transactions/aml/documents/home). Not itself a
// *.test.ts file, so tsx --test's glob does not pick it up as a test.

export function extractSessionCookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const match = raw.match(/aee_session=[^;]+/);
  if (!match) {
    throw new Error(`No aee_session cookie found in response headers: ${JSON.stringify(raw)}`);
  }
  return match[0];
}

export interface DevLoginUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  brokerageId: number;
  brokerageName: string | null;
}

export interface DevLoginResult {
  cookie: string;
  user: DevLoginUser;
}

export async function devLogin(
  baseUrl: string,
  input: { email: string; firstName: string; lastName: string; brokerageName: string },
): Promise<DevLoginResult> {
  const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`dev-login failed for ${input.email}: ${res.status} ${await res.text()}`);
  }
  const cookie = extractSessionCookie(res);
  const body = (await res.json()) as { user: DevLoginUser };
  return { cookie, user: body.user };
}

/** Two signed-in identities in the same fresh brokerage: the first (Brokerage Administrator) and second (Agent) dev-login. */
export async function createBrokerageWithUsers(
  baseUrl: string,
  brokerageName: string,
): Promise<{ admin: DevLoginResult; agent: DevLoginResult; brokerageId: number }> {
  const admin = await devLogin(baseUrl, {
    email: `admin-${brokerageName.replace(/\s+/g, "-").toLowerCase()}@example.com`,
    firstName: "Admin",
    lastName: "User",
    brokerageName,
  });
  const agent = await devLogin(baseUrl, {
    email: `agent-${brokerageName.replace(/\s+/g, "-").toLowerCase()}@example.com`,
    firstName: "Agent",
    lastName: "User",
    brokerageName,
  });
  return { admin, agent, brokerageId: admin.user.brokerageId };
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got: ${res.status} ${text}`);
  }
}

/**
 * Drives a brand-new property all the way to `Listed` through the real
 * routes (Start Property -> add Seller -> Ready to List -> capture agency
 * terms -> populate -> send for signature -> simulate the e-sign webhook
 * completing -> simulate the AML webhook completing -> Go Live). Reused by
 * multiple test files so each one doesn't have to re-derive this sequence.
 */
export async function createListedProperty(
  baseUrl: string,
  cookie: string,
  opts?: { address?: string; sellerEmail?: string; state?: string },
): Promise<{ propertyId: number; sellerPartyId: number; packageId: number }> {
  const address = opts?.address ?? `${Math.floor(Math.random() * 100000)} Test Street, Testville`;
  const sellerEmail = opts?.sellerEmail ?? `seller-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
  const state = opts?.state ?? "NSW";

  const headers = { "content-type": "application/json", cookie };

  const propRes = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers,
    body: JSON.stringify({ formattedAddress: address, state, suburb: "Testville", postcode: "2000" }),
  });
  if (propRes.status !== 201) throw new Error(`create property failed: ${propRes.status} ${await propRes.text()}`);
  const { property } = await json<{ property: { id: number } }>(propRes);
  const propertyId = property.id;

  const partyRes = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers,
    body: JSON.stringify({ propertyId, role: "Seller", firstName: "Sam", lastName: "Seller", email: sellerEmail }),
  });
  if (partyRes.status !== 201) throw new Error(`add seller failed: ${partyRes.status} ${await partyRes.text()}`);
  const { party: sellerParty } = await json<{ party: { id: number } }>(partyRes);

  const rtlRes = await fetch(`${baseUrl}/api/properties/${propertyId}/ready-to-list`, { method: "POST", headers });
  if (rtlRes.status !== 200) throw new Error(`ready-to-list failed: ${rtlRes.status} ${await rtlRes.text()}`);
  const { documentPackage } = await json<{ documentPackage: { id: number } }>(rtlRes);
  const packageId = documentPackage.id;

  const termsRes = await fetch(`${baseUrl}/api/documents/agency-agreement-terms/${propertyId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ commissionType: "Percentage", commissionRateBps: 220, agreementTermDays: 90 }),
  });
  if (termsRes.status !== 200) throw new Error(`agency terms failed: ${termsRes.status} ${await termsRes.text()}`);

  const populateRes = await fetch(`${baseUrl}/api/documents/packages/${packageId}/populate`, { method: "POST", headers });
  if (populateRes.status !== 200) throw new Error(`populate failed: ${populateRes.status} ${await populateRes.text()}`);

  const sendRes = await fetch(`${baseUrl}/api/documents/packages/${packageId}/send-for-signature`, { method: "POST", headers });
  if (sendRes.status !== 201) throw new Error(`send-for-signature failed: ${sendRes.status} ${await sendRes.text()}`);
  const { signatureRequest } = await json<{ signatureRequest: { providerReference: string } }>(sendRes);

  const esignWebhookRes = await fetch(`${baseUrl}/api/documents/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerReference: signatureRequest.providerReference, status: "Completed" }),
  });
  if (esignWebhookRes.status !== 200) throw new Error(`esign webhook failed: ${esignWebhookRes.status} ${await esignWebhookRes.text()}`);

  const amlListRes = await fetch(`${baseUrl}/api/aml/by-property/${propertyId}`, { headers: { cookie } });
  const { verifications } = await json<{ verifications: Array<{ providerReference: string }> }>(amlListRes);
  if (verifications.length === 0) throw new Error("expected at least one AML verification");

  for (const v of verifications) {
    const amlWebhookRes = await fetch(`${baseUrl}/api/aml/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerReference: v.providerReference, outcome: "VERIFIED", reviewRequired: false }),
    });
    if (amlWebhookRes.status !== 200) throw new Error(`aml webhook failed: ${amlWebhookRes.status} ${await amlWebhookRes.text()}`);
  }

  const goLiveRes = await fetch(`${baseUrl}/api/properties/${propertyId}/go-live`, { method: "POST", headers });
  if (goLiveRes.status !== 200) throw new Error(`go-live failed: ${goLiveRes.status} ${await goLiveRes.text()}`);
  const { property: listed } = await json<{ property: { listingStatus: string } }>(goLiveRes);
  if (listed.listingStatus !== "Listed") throw new Error(`expected Listed, got ${listed.listingStatus}`);

  return { propertyId, sellerPartyId: sellerParty.id, packageId };
}

export async function getDomainEventsForProperty(propertyId: number, eventType?: string) {
  const rows = await db.select().from(domainEvents).where(eq(domainEvents.propertyId, propertyId));
  return eventType ? rows.filter((r) => r.eventType === eventType) : rows;
}

/**
 * Deletes every row this test suite could plausibly have created, scoped to
 * the given brokerage ids — mirrors auth.test.ts's after() hook but covers
 * every table Stage 4's new tests touch. Deletion order respects the FK
 * graph (children before parents). Never touches rows outside the given
 * brokerage ids, so the two pre-existing real users/brokerage are untouched.
 */
export async function cleanupBrokerages(brokerageIds: number[]): Promise<void> {
  const ids = brokerageIds.filter((id): id is number => typeof id === "number" && Number.isFinite(id));
  if (ids.length === 0) return;

  // F-05: Import (import_records / import_jobs) rows are deleted first, ahead
  // of both the Grow tables below and the existing property cascade --
  // import_records carries non-cascading FKs onto parties/properties/
  // grow_relationships for rows the import pipeline itself created (see
  // packages/db/src/schema/import.ts), so it must run before those deletes;
  // import_jobs itself only depends on brokerages/users.
  const importJobRows = await db.select({ id: importJobs.id }).from(importJobs).where(inArray(importJobs.brokerageId, ids));
  const importJobIds = importJobRows.map((j) => j.id);
  if (importJobIds.length > 0) {
    await db.delete(importRecords).where(inArray(importRecords.importJobId, importJobIds));
  }
  await db.delete(importJobs).where(inArray(importJobs.brokerageId, ids));

  // F-05: Grow (grow_activities / grow_opportunities / grow_relationships) rows are deleted
  // first and scoped directly by brokerageId -- all three have non-cascading FKs onto
  // parties/properties (see packages/db/src/schema/grow.ts), and grow_activities additionally
  // references grow_opportunities.id, so this order (activities, then opportunities, then
  // relationships) must run before parties/properties are deleted below or the deletes there
  // fail with a foreign key violation instead of silently succeeding.
  await db.delete(growActivities).where(inArray(growActivities.brokerageId, ids));
  await db.delete(growOpportunities).where(inArray(growOpportunities.brokerageId, ids));
  await db.delete(growRelationships).where(inArray(growRelationships.brokerageId, ids));

  const propertyRows = await db.select().from(properties).where(inArray(properties.brokerageId, ids));
  const propertyIds = propertyRows.map((p) => p.id);

  if (propertyIds.length > 0) {
    const packageRows = await db.select().from(documentPackages).where(inArray(documentPackages.propertyId, propertyIds));
    const packageIds = packageRows.map((p) => p.id);
    if (packageIds.length > 0) {
      await db.delete(signatureRequests).where(inArray(signatureRequests.packageId, packageIds));
    }
    await db.delete(documents).where(inArray(documents.propertyId, propertyIds));
    await db.delete(documentPackages).where(inArray(documentPackages.propertyId, propertyIds));
    await db.delete(amlVerifications).where(inArray(amlVerifications.propertyId, propertyIds));
    await db.delete(serviceOrders).where(inArray(serviceOrders.propertyId, propertyIds));

    const workflowRows = await db.select().from(workflows).where(inArray(workflows.propertyId, propertyIds));
    const workflowIds = workflowRows.map((w) => w.id);
    if (workflowIds.length > 0) {
      await db.delete(workflowSteps).where(inArray(workflowSteps.workflowId, workflowIds));
    }
    await db.delete(workflows).where(inArray(workflows.propertyId, propertyIds));

    await db.delete(transactions).where(inArray(transactions.propertyId, propertyIds));
    await db.delete(offers).where(inArray(offers.propertyId, propertyIds));
    await db.delete(propertyParties).where(inArray(propertyParties.propertyId, propertyIds));
    await db.delete(agencyAgreementTerms).where(inArray(agencyAgreementTerms.propertyId, propertyIds));
    await db.delete(auditLogs).where(inArray(auditLogs.propertyId, propertyIds));
    await db.delete(domainEvents).where(inArray(domainEvents.propertyId, propertyIds));
    await db.delete(properties).where(inArray(properties.id, propertyIds));
  }

  await db.delete(entitlementGrants).where(inArray(entitlementGrants.brokerageId, ids));
  await db.delete(aiActionRequests).where(inArray(aiActionRequests.brokerageId, ids));
  await db.delete(domainEvents).where(inArray(domainEvents.brokerageId, ids));
  await db.delete(parties).where(inArray(parties.brokerageId, ids));
  await db.delete(users).where(inArray(users.brokerageId, ids));
  await db.delete(brokerages).where(inArray(brokerages.id, ids));
}
