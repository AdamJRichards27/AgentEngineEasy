// R-F40 — property-scoped AML and document reads answer 404 for a property
// that is missing or belongs to another brokerage, the same status and body
// as GET /transactions/by-property. An own property with no records stays
// the previous empty 200. An own property with records stays the previous
// data. requireAuth and requiresRunAccess still run first.
//
// Foreign and missing responses are asserted from the HTTP body only.
// These tests do not read row counts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants } from "@aee/db";
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
const MISSING_ID = 2_000_000_000;
const NOT_FOUND = { error: "Not found" };

let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let emptyPropertyId: number;
let recordedPropertyId: number;
let sellerPartyId: number;
let packageId: number;

interface VerificationRow {
  propertyId: number;
  partyId: number;
  status: string;
  verificationType: string;
}

interface ServiceOrderRow {
  propertyId: number;
  partyId: number;
  serviceType: string;
  status: string;
  paymentStatus: string;
}

interface PackageDocument {
  propertyId: number;
  packageId: number;
  documentType: string;
  status: string;
}

interface PackageBody {
  documentPackage: { id: number; purpose: string; status: string; state: string } | null;
  documents: PackageDocument[];
  signatureRequest: unknown;
}

interface TermsBody {
  terms: {
    propertyId: number;
    commissionType: string;
    commissionRateBps: number | null;
    agreementTermDays: number;
  } | null;
}

function headers(cookie?: string, json = false): Record<string, string> {
  const result: Record<string, string> = {};
  if (cookie) result.cookie = cookie;
  if (json) result["content-type"] = "application/json";
  return result;
}

async function call(path: string, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, { headers: headers(cookie) });
}

async function bodyOf<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got ${res.status}: ${text}`);
  }
}

async function setRunAccess(brokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

const reads: Array<{ label: string; path: (propertyId: number) => string }> = [
  { label: "GET /aml/by-property/:propertyId", path: (id) => `/aml/by-property/${id}` },
  { label: "GET /aml/service-orders/by-property/:propertyId", path: (id) => `/aml/service-orders/by-property/${id}` },
  { label: "GET /documents/packages/by-property/:propertyId", path: (id) => `/documents/packages/by-property/${id}` },
  { label: "GET /documents/agency-agreement-terms/:propertyId", path: (id) => `/documents/agency-agreement-terms/${id}` },
];

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

  A = await createBrokerageWithUsers(baseUrl, `R-F40 Foreign 404 A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `R-F40 Foreign 404 B ${suffix}`);

  const bare = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: headers(A.agent.cookie, true),
    body: JSON.stringify({
      formattedAddress: `${suffix} Empty Property St`,
      state: "NSW",
      suburb: "Testville",
      postcode: "2000",
    }),
  });
  assert.equal(bare.status, 201, await bare.clone().text());
  emptyPropertyId = ((await bare.json()) as { property: { id: number } }).property.id;

  const recorded = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: headers(A.agent.cookie, true),
    body: JSON.stringify({
      formattedAddress: `${suffix} Recorded Property St`,
      state: "NSW",
      suburb: "Testville",
      postcode: "2000",
    }),
  });
  assert.equal(recorded.status, 201, await recorded.clone().text());
  recordedPropertyId = ((await recorded.json()) as { property: { id: number } }).property.id;

  const seller = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: headers(A.agent.cookie, true),
    body: JSON.stringify({
      propertyId: recordedPropertyId,
      role: "Seller",
      firstName: "Sam",
      lastName: "Seller",
      email: `seller-rf40-${suffix}@example.com`,
    }),
  });
  assert.equal(seller.status, 201, await seller.clone().text());
  sellerPartyId = ((await seller.json()) as { party: { id: number } }).party.id;

  const ready = await fetch(`${baseUrl}/api/properties/${recordedPropertyId}/ready-to-list`, {
    method: "POST",
    headers: headers(A.agent.cookie, true),
  });
  assert.equal(ready.status, 200, await ready.clone().text());
  packageId = ((await ready.json()) as { documentPackage: { id: number } }).documentPackage.id;

  const terms = await fetch(`${baseUrl}/api/documents/agency-agreement-terms/${recordedPropertyId}`, {
    method: "PUT",
    headers: headers(A.agent.cookie, true),
    body: JSON.stringify({ commissionType: "Percentage", commissionRateBps: 220, agreementTermDays: 90 }),
  });
  assert.equal(terms.status, 200, await terms.clone().text());
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("a foreign property and a missing property are the same 404 and carry no records", async () => {
  for (const read of reads) {
    const foreign = await call(read.path(recordedPropertyId), B.agent.cookie);
    const foreignText = await foreign.text();
    assert.equal(foreign.status, 404, `${read.label} foreign -> ${foreign.status} ${foreignText}`);
    assert.deepEqual(JSON.parse(foreignText), NOT_FOUND, read.label);

    const missing = await call(read.path(MISSING_ID), A.agent.cookie);
    const missingText = await missing.text();
    assert.equal(missing.status, 404, `${read.label} missing -> ${missing.status} ${missingText}`);
    assert.equal(missingText, foreignText, `${read.label} foreign and missing bodies differ`);
    assert.deepEqual(JSON.parse(missingText), NOT_FOUND, read.label);
  }
});

test("an own property with no records keeps today's empty 200", async () => {
  const aml = await call(`/aml/by-property/${emptyPropertyId}`, A.agent.cookie);
  assert.equal(aml.status, 200);
  assert.deepEqual(await bodyOf(aml), { verifications: [] });

  const orders = await call(`/aml/service-orders/by-property/${emptyPropertyId}`, A.agent.cookie);
  assert.equal(orders.status, 200);
  assert.deepEqual(await bodyOf(orders), { serviceOrders: [] });

  const packages = await call(`/documents/packages/by-property/${emptyPropertyId}`, A.agent.cookie);
  assert.equal(packages.status, 200);
  assert.deepEqual(await bodyOf(packages), { documentPackage: null, documents: [], signatureRequest: null });

  const terms = await call(`/documents/agency-agreement-terms/${emptyPropertyId}`, A.agent.cookie);
  assert.equal(terms.status, 200);
  assert.deepEqual(await bodyOf(terms), { terms: null });
});

test("an own property with records keeps today's data", async () => {
  const aml = await call(`/aml/by-property/${recordedPropertyId}`, A.agent.cookie);
  assert.equal(aml.status, 200);
  const amlBody = await bodyOf<{ verifications: VerificationRow[] }>(aml);
  assert.equal(amlBody.verifications.length, 1);
  assert.deepEqual(
    {
      propertyId: amlBody.verifications[0]?.propertyId,
      partyId: amlBody.verifications[0]?.partyId,
      status: amlBody.verifications[0]?.status,
      verificationType: amlBody.verifications[0]?.verificationType,
    },
    {
      propertyId: recordedPropertyId,
      partyId: sellerPartyId,
      status: "Awaiting Seller",
      verificationType: "Individual",
    },
  );

  const orders = await call(`/aml/service-orders/by-property/${recordedPropertyId}`, A.agent.cookie);
  assert.equal(orders.status, 200);
  const orderBody = await bodyOf<{ serviceOrders: ServiceOrderRow[] }>(orders);
  assert.equal(orderBody.serviceOrders.length, 1);
  assert.deepEqual(
    {
      propertyId: orderBody.serviceOrders[0]?.propertyId,
      partyId: orderBody.serviceOrders[0]?.partyId,
      serviceType: orderBody.serviceOrders[0]?.serviceType,
      status: orderBody.serviceOrders[0]?.status,
      paymentStatus: orderBody.serviceOrders[0]?.paymentStatus,
    },
    {
      propertyId: recordedPropertyId,
      partyId: sellerPartyId,
      serviceType: "AmlVerification",
      status: "Ordered",
      paymentStatus: "Pending",
    },
  );

  const packages = await call(`/documents/packages/by-property/${recordedPropertyId}`, A.agent.cookie);
  assert.equal(packages.status, 200);
  const packageBody = await bodyOf<PackageBody>(packages);
  assert.ok(packageBody.documentPackage);
  assert.equal(packageBody.documentPackage.id, packageId);
  assert.equal(packageBody.documentPackage.purpose, "ReadyToList");
  assert.equal(packageBody.documentPackage.status, "Preparing");
  assert.equal(packageBody.documentPackage.state, "NSW");
  assert.equal(packageBody.signatureRequest, null);
  assert.deepEqual(
    packageBody.documents.map((document) => ({
      propertyId: document.propertyId,
      packageId: document.packageId,
      documentType: document.documentType,
      status: document.status,
    })),
    [
      { propertyId: recordedPropertyId, packageId, documentType: "AgencyAgreement", status: "Draft" },
      { propertyId: recordedPropertyId, packageId, documentType: "AMLConsent", status: "Draft" },
      { propertyId: recordedPropertyId, packageId, documentType: "VendorDisclosure", status: "Draft" },
    ],
  );

  const terms = await call(`/documents/agency-agreement-terms/${recordedPropertyId}`, A.agent.cookie);
  assert.equal(terms.status, 200);
  const termsBody = await bodyOf<TermsBody>(terms);
  assert.ok(termsBody.terms);
  assert.equal(termsBody.terms.propertyId, recordedPropertyId);
  assert.equal(termsBody.terms.commissionType, "Percentage");
  assert.equal(termsBody.terms.commissionRateBps, 220);
  assert.equal(termsBody.terms.agreementTermDays, 90);
});

test("missing run.access is still 403 and an unauthenticated call is still 401", async () => {
  for (const read of reads) {
    const anonymous = await call(read.path(recordedPropertyId));
    const anonymousText = await anonymous.text();
    assert.equal(anonymous.status, 401, `${read.label} -> ${anonymous.status} ${anonymousText}`);
    assert.deepEqual(JSON.parse(anonymousText), { error: "Not authenticated" });
  }

  await setRunAccess(A.brokerageId, false);
  try {
    for (const read of reads) {
      const denied = await call(read.path(recordedPropertyId), A.agent.cookie);
      const deniedText = await denied.text();
      assert.equal(denied.status, 403, `${read.label} -> ${denied.status} ${deniedText}`);
      const body = JSON.parse(deniedText) as { error?: string; entitlementKey?: string; reason?: string };
      assert.equal(body.error, "Not entitled");
      assert.equal(body.reason, "ENTITLEMENT_MISSING");
      assert.equal(body.entitlementKey, "run.access");
    }
  } finally {
    await setRunAccess(A.brokerageId, true);
  }
});
