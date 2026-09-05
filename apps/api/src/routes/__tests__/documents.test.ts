// Documents cross-tenant IDOR fix (#131/#135-class, most severe of the
// confirmed findings) — apps/api/src/lib/documents.ts and
// apps/api/src/routes/documents.ts.
//
// Before the fix, five route handlers loaded a document / document-package
// / agency-agreement-terms record by a raw client-supplied id (or
// propertyId) with zero brokerage check:
//   - GET  /:documentId/content                    — streamed ANY
//     brokerage's stored document content (signed contracts, agency
//     agreements) to any authenticated user.
//   - GET/PUT /agency-agreement-terms/:propertyId   — read/wrote ANY
//     brokerage's commission terms.
//   - POST /packages/:packageId/populate            — (re)generated ANY
//     brokerage's document package.
//   - POST /packages/:packageId/send-for-signature  — sent ANY brokerage's
//     package to real sellers for e-signature. `brokerageId` was already
//     present on the input type but only forwarded into an outgoing event
//     payload, never used to verify the package — a false sense of safety.
//   - GET  /packages/by-property/:propertyId        — leaked ANY
//     brokerage's document package/documents/signature-request state.
//
// This file proves each of those five is now scoped to req.authedUser's
// own brokerageId: a same-brokerage caller gets identical behaviour to
// before the fix (happy-path tests), and a cross-tenant caller gets an
// identical "not found"/empty rejection to a nonexistent id or property —
// never a distinguishing error, and never a real side effect (verified by
// re-reading the target record from its OWN brokerage afterwards).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `Documents Tenant Scoping A ${suffix}`;
const brokerageBName = `Documents Tenant Scoping B ${suffix}`;
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

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got: ${res.status} ${text}`);
  }
}

function headersFor(cookie: string) {
  return { "content-type": "application/json", cookie };
}

async function createBareProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: headersFor(cookie),
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = await json<{ property: { id: number } }>(res);
  return property.id;
}

/** Property -> Seller -> Ready to List, stopping right before agency terms are captured. */
async function createReadyToListProperty(cookie: string, address: string): Promise<{ propertyId: number; packageId: number }> {
  const propertyId = await createBareProperty(cookie, address);
  const sellerRes = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: headersFor(cookie),
    body: JSON.stringify({
      propertyId,
      role: "Seller",
      firstName: "Sam",
      lastName: "Seller",
      email: `seller-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`,
    }),
  });
  if (sellerRes.status !== 201) throw new Error(`add seller failed: ${sellerRes.status} ${await sellerRes.text()}`);

  const rtlRes = await fetch(`${baseUrl}/api/properties/${propertyId}/ready-to-list`, { method: "POST", headers: headersFor(cookie) });
  if (rtlRes.status !== 200) throw new Error(`ready-to-list failed: ${rtlRes.status} ${await rtlRes.text()}`);
  const { documentPackage } = await json<{ documentPackage: { id: number } }>(rtlRes);
  return { propertyId, packageId: documentPackage.id };
}

async function putAgencyTerms(cookie: string, propertyId: number, overrides: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/api/documents/agency-agreement-terms/${propertyId}`, {
    method: "PUT",
    headers: headersFor(cookie),
    body: JSON.stringify({ commissionType: "Percentage", commissionRateBps: 220, agreementTermDays: 90, ...overrides }),
  });
}

async function getByProperty(cookie: string, propertyId: number) {
  const res = await fetch(`${baseUrl}/api/documents/packages/by-property/${propertyId}`, { headers: { cookie } });
  return { res, body: await json<{ documentPackage: { id: number; status: string } | null; documents: Array<{ id: number; objectStorageKey: string | null }>; signatureRequest: { id: number } | null }>(res) };
}

// ---------------------------------------------------------------------
// GET/PUT /agency-agreement-terms/:propertyId
// ---------------------------------------------------------------------

test("PUT /agency-agreement-terms/:propertyId succeeds for the owning brokerage, unchanged", async () => {
  const propertyId = await createBareProperty(A.agent.cookie, `${Math.floor(Math.random() * 1_000_000)} Terms Happy Path Rd`);

  const res = await putAgencyTerms(A.agent.cookie, propertyId, { commissionRateBps: 250 });
  assert.equal(res.status, 200);
  const { terms } = await json<{ terms: { propertyId: number; commissionRateBps: number } }>(res);
  assert.equal(terms.propertyId, propertyId);
  assert.equal(terms.commissionRateBps, 250);
});

test("GET /agency-agreement-terms/:propertyId succeeds for the owning brokerage, unchanged", async () => {
  const propertyId = await createBareProperty(A.agent.cookie, `${Math.floor(Math.random() * 1_000_000)} Terms Get Happy Path Rd`);
  const putRes = await putAgencyTerms(A.agent.cookie, propertyId, { commissionRateBps: 300 });
  assert.equal(putRes.status, 200);

  const res = await fetch(`${baseUrl}/api/documents/agency-agreement-terms/${propertyId}`, { headers: { cookie: A.agent.cookie } });
  assert.equal(res.status, 200);
  const { terms } = await json<{ terms: { propertyId: number; commissionRateBps: number } | null }>(res);
  assert.ok(terms);
  assert.equal(terms!.commissionRateBps, 300);
});

test("PUT /agency-agreement-terms/:propertyId rejects a property belonging to a different brokerage as if it didn't exist, and writes nothing", async () => {
  const propertyId = await createBareProperty(A.agent.cookie, `${Math.floor(Math.random() * 1_000_000)} Terms Cross Tenant Rd`);
  const originalPut = await putAgencyTerms(A.agent.cookie, propertyId, { commissionRateBps: 220 });
  assert.equal(originalPut.status, 200);

  const crossTenant = await putAgencyTerms(B.agent.cookie, propertyId, { commissionRateBps: 999 });
  assert.equal(crossTenant.status, 400, "upsertAgencyAgreementTerms throws, and the route maps it to 400 like every other write in this router");
  const crossTenantBody = await json<{ error: string }>(crossTenant);
  assert.match(crossTenantBody.error, /not found/i);

  // Prove nothing actually changed — not just an error-code detail.
  const stillA = await fetch(`${baseUrl}/api/documents/agency-agreement-terms/${propertyId}`, { headers: { cookie: A.agent.cookie } });
  const stillABody = await json<{ terms: { commissionRateBps: number } | null }>(stillA);
  assert.equal(stillABody.terms!.commissionRateBps, 220, "the cross-tenant PUT must not have touched A's commission terms");
});

test("GET /agency-agreement-terms/:propertyId rejects a property belonging to a different brokerage as if it didn't exist", async () => {
  const propertyId = await createBareProperty(A.agent.cookie, `${Math.floor(Math.random() * 1_000_000)} Terms Get Cross Tenant Rd`);
  const putRes = await putAgencyTerms(A.agent.cookie, propertyId, { commissionRateBps: 220 });
  assert.equal(putRes.status, 200);

  const crossTenant = await fetch(`${baseUrl}/api/documents/agency-agreement-terms/${propertyId}`, { headers: { cookie: B.agent.cookie } });
  assert.equal(crossTenant.status, 400);
  const body = await json<{ error: string }>(crossTenant);
  // The message echoes back whatever id the caller supplied (same
  // convention as e.g. lib/transactionConditions.ts's loadTransactionInBrokerage)
  // — that's not a leak, since B already knows the id it asked for either
  // way. What must not exist is a DIFFERENT wording that would let B tell
  // "belongs to another brokerage" apart from "doesn't exist at all".
  assert.equal(body.error, `Property ${propertyId} not found`);

  // A genuinely nonexistent propertyId under B's own brokerage goes through
  // the exact same code path and produces the same status + template.
  const nonexistent = await fetch(`${baseUrl}/api/documents/agency-agreement-terms/999999999`, { headers: { cookie: B.agent.cookie } });
  assert.equal(nonexistent.status, crossTenant.status);
  const nonexistentBody = await json<{ error: string }>(nonexistent);
  assert.equal(nonexistentBody.error, "Property 999999999 not found");
});

// ---------------------------------------------------------------------
// POST /packages/:packageId/populate
// ---------------------------------------------------------------------

test("POST /packages/:packageId/populate succeeds for the owning brokerage, unchanged", async () => {
  const { propertyId, packageId } = await createReadyToListProperty(A.agent.cookie, `${Math.floor(Math.random() * 1_000_000)} Populate Happy Path Rd`);
  const termsRes = await putAgencyTerms(A.agent.cookie, propertyId);
  assert.equal(termsRes.status, 200);

  const res = await fetch(`${baseUrl}/api/documents/packages/${packageId}/populate`, { method: "POST", headers: headersFor(A.agent.cookie) });
  assert.equal(res.status, 200);
  const body = await json<{ documentPackage: { id: number; status: string }; documents: Array<{ status: string }> }>(res);
  assert.equal(body.documentPackage.id, packageId);
  assert.equal(body.documentPackage.status, "Ready");
  assert.ok(body.documents.length > 0);
  assert.ok(body.documents.every((d) => d.status === "Generated"));
});

test("POST /packages/:packageId/populate rejects a package belonging to a different brokerage as if it didn't exist, and generates nothing", async () => {
  const { propertyId, packageId } = await createReadyToListProperty(A.agent.cookie, `${Math.floor(Math.random() * 1_000_000)} Populate Cross Tenant Rd`);
  const termsRes = await putAgencyTerms(A.agent.cookie, propertyId);
  assert.equal(termsRes.status, 200);

  const crossTenant = await fetch(`${baseUrl}/api/documents/packages/${packageId}/populate`, { method: "POST", headers: headersFor(B.agent.cookie) });
  assert.equal(crossTenant.status, 400, "populateDocumentPackage throws, and the route maps every error to 400");
  const body = await json<{ error: string }>(crossTenant);
  assert.match(body.error, /not found/i);

  // Prove the package genuinely was NOT populated by the rejected attempt.
  const { body: byProperty } = await getByProperty(A.agent.cookie, propertyId);
  assert.equal(byProperty.documentPackage!.status, "Preparing", "still unpopulated — the cross-tenant call must not have generated anything");
  assert.ok(byProperty.documents.every((d) => d.objectStorageKey === null));
});

// ---------------------------------------------------------------------
// POST /packages/:packageId/send-for-signature
// ---------------------------------------------------------------------

test("POST /packages/:packageId/send-for-signature succeeds for the owning brokerage, unchanged", async () => {
  const { propertyId, packageId } = await createReadyToListProperty(A.agent.cookie, `${Math.floor(Math.random() * 1_000_000)} Send Happy Path Rd`);
  const termsRes = await putAgencyTerms(A.agent.cookie, propertyId);
  assert.equal(termsRes.status, 200);
  const populateRes = await fetch(`${baseUrl}/api/documents/packages/${packageId}/populate`, { method: "POST", headers: headersFor(A.agent.cookie) });
  assert.equal(populateRes.status, 200);

  const res = await fetch(`${baseUrl}/api/documents/packages/${packageId}/send-for-signature`, { method: "POST", headers: headersFor(A.agent.cookie) });
  assert.equal(res.status, 201);
  const body = await json<{ signatureRequest: { id: number; status: string }; created: boolean }>(res);
  assert.equal(body.created, true);
  assert.equal(body.signatureRequest.status, "Sent");

  const { body: byProperty } = await getByProperty(A.agent.cookie, propertyId);
  assert.equal(byProperty.documentPackage!.status, "Sent");
  assert.ok(byProperty.signatureRequest);
});

test("POST /packages/:packageId/send-for-signature rejects a package belonging to a different brokerage as if it didn't exist, and sends nothing", async () => {
  const { propertyId, packageId } = await createReadyToListProperty(A.agent.cookie, `${Math.floor(Math.random() * 1_000_000)} Send Cross Tenant Rd`);
  const termsRes = await putAgencyTerms(A.agent.cookie, propertyId);
  assert.equal(termsRes.status, 200);
  const populateRes = await fetch(`${baseUrl}/api/documents/packages/${packageId}/populate`, { method: "POST", headers: headersFor(A.agent.cookie) });
  assert.equal(populateRes.status, 200);

  const crossTenant = await fetch(`${baseUrl}/api/documents/packages/${packageId}/send-for-signature`, { method: "POST", headers: headersFor(B.agent.cookie) });
  assert.equal(crossTenant.status, 400, "sendPackageForSignature throws, and the route maps every error to 400");
  const body = await json<{ error: string }>(crossTenant);
  assert.match(body.error, /not found/i);

  // Prove no real e-sign envelope was created against A's sellers — the
  // actual compliance/consequence this fix closes, not just a status code.
  const { body: byProperty } = await getByProperty(A.agent.cookie, propertyId);
  assert.equal(byProperty.documentPackage!.status, "Ready", "must still be Ready, not Sent, after the rejected cross-tenant attempt");
  assert.equal(byProperty.signatureRequest, null, "no SignatureRequest must have been created by the cross-tenant caller");
});

// ---------------------------------------------------------------------
// GET /packages/by-property/:propertyId
// ---------------------------------------------------------------------

test("GET /packages/by-property/:propertyId succeeds for the owning brokerage, unchanged", async () => {
  const { propertyId, packageId } = await createReadyToListProperty(A.agent.cookie, `${Math.floor(Math.random() * 1_000_000)} By Property Happy Path Rd`);

  const { res, body } = await getByProperty(A.agent.cookie, propertyId);
  assert.equal(res.status, 200);
  assert.equal(body.documentPackage!.id, packageId);
});

test("GET /packages/by-property/:propertyId returns nothing for a different brokerage's property, identical to a property with no package at all", async () => {
  const { propertyId } = await createReadyToListProperty(A.agent.cookie, `${Math.floor(Math.random() * 1_000_000)} By Property Cross Tenant Rd`);

  const crossTenant = await getByProperty(B.agent.cookie, propertyId);
  assert.equal(crossTenant.res.status, 200, "the route returns a null/empty shape rather than 404ing, so it must never leak another tenant's package");
  assert.deepEqual(crossTenant.body, { documentPackage: null, documents: [], signatureRequest: null });

  // Same shape as a genuinely package-less property in B's own brokerage.
  const bareInB = await createBareProperty(B.agent.cookie, `${Math.floor(Math.random() * 1_000_000)} By Property No Package Rd`);
  const noPackage = await getByProperty(B.agent.cookie, bareInB);
  assert.deepEqual(noPackage.body, crossTenant.body);

  const sameTenant = await getByProperty(A.agent.cookie, propertyId);
  assert.equal(sameTenant.res.status, 200);
  assert.ok(sameTenant.body.documentPackage, "the owning brokerage must still see its own package");
});

// ---------------------------------------------------------------------
// GET /:documentId/content
// ---------------------------------------------------------------------

test("GET /:documentId/content succeeds for the owning brokerage, unchanged", async () => {
  const listed = await createListedProperty(baseUrl, A.agent.cookie, { address: `${Math.floor(Math.random() * 1_000_000)} Content Happy Path St` });
  const { body } = await getByProperty(A.agent.cookie, listed.propertyId);
  const doc = body.documents.find((d) => d.objectStorageKey);
  assert.ok(doc, "createListedProperty must have generated at least one document with stored content");

  const res = await fetch(`${baseUrl}/api/documents/${doc!.id}/content`, { headers: { cookie: A.agent.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  const text = await res.text();
  assert.ok(text.length > 0);
  assert.ok(text.includes("Content Happy Path St"), "the generated content must actually be this property's document, not a placeholder");
});

test("GET /:documentId/content rejects a document belonging to a different brokerage exactly like a nonexistent id — real signed contract content must not leak cross-tenant", async () => {
  const listed = await createListedProperty(baseUrl, A.agent.cookie, { address: `${Math.floor(Math.random() * 1_000_000)} Content Cross Tenant St` });
  const { body } = await getByProperty(A.agent.cookie, listed.propertyId);
  const doc = body.documents.find((d) => d.objectStorageKey);
  assert.ok(doc);

  const crossTenant = await fetch(`${baseUrl}/api/documents/${doc!.id}/content`, { headers: { cookie: B.agent.cookie } });
  assert.equal(crossTenant.status, 404);
  const crossTenantBody = await json<{ error: string }>(crossTenant);

  const nonexistent = await fetch(`${baseUrl}/api/documents/999999999/content`, { headers: { cookie: B.agent.cookie } });
  assert.equal(nonexistent.status, 404);
  const nonexistentBody = await json<{ error: string }>(nonexistent);

  assert.equal(crossTenantBody.error, nonexistentBody.error, "cross-tenant and nonexistent document ids must be indistinguishable");

  // The owning brokerage must still be able to read it, unaffected.
  const sameTenant = await fetch(`${baseUrl}/api/documents/${doc!.id}/content`, { headers: { cookie: A.agent.cookie } });
  assert.equal(sameTenant.status, 200);
});
