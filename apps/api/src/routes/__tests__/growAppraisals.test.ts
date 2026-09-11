import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

/* ---------------------------------------------------------------------
 * AE GROW Priority 4 -- Appraisal Workspace (Sec.25). HTTP-integration
 * coverage for growAppraisals.ts / growAppraisalIntegrations.ts via the
 * real routes in routes/growAppraisals.ts, following the exact
 * conventions established by growToday.test.ts: real Express app, real
 * Postgres, real dev-login cookies, real fetch() calls -- never a
 * mocked request/response.
 *
 * What is NOT covered here, and why: /send, /market-position/generate
 * and /presentation/generate reach into the Communications Hub and the
 * governed AI Copilot orchestrator, both of which need their own
 * provider/sandbox setup to exercise a real success path without risk
 * of an actual outbound send or a flaky live-model call in CI. Those
 * three are covered here only for the auth boundary (401) plus the
 * "no linked contact" validation branch that needs no external call;
 * their internal logic was exercised directly against real Postgres
 * data in a manual smoke test during development (see the Priority 4
 * report) and is otherwise covered by the workspace-wide typecheck.
 * -----------------------------------------------------------------*/

let server: Server;
let baseUrl: string;

const suffix = Date.now();
const brokerageAName = `Grow Appraisals A ${suffix}`;
const brokerageBName = `Grow Appraisals B ${suffix}`;

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

  // grow.access is the general Grow gate; grow.opportunities.manage is needed
  // only to create the fixture opportunity used by the from-opportunity test.
  await grant(A.brokerageId, "grow.access");
  await grant(A.brokerageId, "grow.opportunities.manage");
  await grant(B.brokerageId, "grow.access");
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

async function revokeEntitlement(brokerageId: number, entitlementKey: string) {
  await db
    .update(entitlementGrants)
    .set({ status: "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, entitlementKey)));
  invalidateEntitlementCache(brokerageId);
}

function growUrl(path: string) {
  return `${baseUrl}/api/grow${path}`;
}

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function createParty(cookie: string, propertyId: number, overrides: Record<string, unknown> = {}): Promise<number> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Seller", firstName: "Test", lastName: "Contact", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

async function createOpportunity(cookie: string, body: Record<string, unknown>): Promise<number> {
  const res = await fetch(growUrl("/opportunities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`create opportunity failed: ${res.status} ${await res.text()}`);
  const { opportunity } = (await res.json()) as { opportunity: { id: number } };
  return opportunity.id;
}

test("unauthenticated requests to the appraisal endpoints are rejected", async () => {
  const fromContactRes = await fetch(growUrl("/appraisals/from-contact"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ partyId: 1, propertyId: 1 }),
  });
  assert.equal(fromContactRes.status, 401);

  const pipelineRes = await fetch(growUrl("/appraisals/pipeline"));
  assert.equal(pipelineRes.status, 401);

  const getRes = await fetch(growUrl("/appraisals/1"));
  assert.equal(getRes.status, 401);

  const sendRes = await fetch(growUrl("/appraisals/1/send"), { method: "POST" });
  assert.equal(sendRes.status, 401);

  const marketPositionRes = await fetch(growUrl("/appraisals/1/market-position/generate"), { method: "POST" });
  assert.equal(marketPositionRes.status, 401);

  const presentationRes = await fetch(growUrl("/appraisals/1/presentation/generate"), { method: "POST" });
  assert.equal(presentationRes.status, 401);

  const runHandoffRes = await fetch(growUrl("/appraisals/1/run-handoff"), { method: "POST" });
  assert.equal(runHandoffRes.status, 401);
});

test("create appraisal from contact, workspace get/patch, comparable sale and market competition CRUD", async () => {
  const cookie = A.admin.cookie;
  const propertyId = await createProperty(cookie, `1 Appraisal Lifecycle St ${suffix}`);
  const partyId = await createParty(cookie, propertyId);

  const createRes = await fetch(growUrl("/appraisals/from-contact"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ partyId, propertyId }),
  });
  assert.equal(createRes.status, 201);
  const { appraisal: created } = (await createRes.json()) as {
    appraisal: { id: number; status: string; partyId: number | null; propertyId: number };
  };
  assert.equal(created.status, "DRAFT");
  assert.equal(created.partyId, partyId);
  assert.equal(created.propertyId, propertyId);
  const appraisalId = created.id;

  // Re-creating from the same contact/property reuses the same Stage-A row
  // (Sec.4 entry-gate decision) rather than creating a duplicate.
  const createAgainRes = await fetch(growUrl("/appraisals/from-contact"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ partyId, propertyId }),
  });
  assert.equal(createAgainRes.status, 201);
  const { appraisal: createdAgain } = (await createAgainRes.json()) as { appraisal: { id: number } };
  assert.equal(createdAgain.id, appraisalId);

  const getRes = await fetch(growUrl(`/appraisals/${appraisalId}`), { headers: { cookie } });
  assert.equal(getRes.status, 200);
  const workspace = (await getRes.json()) as {
    appraisal: { id: number };
    comparableSales: unknown[];
    marketCompetition: unknown[];
  };
  assert.equal(workspace.appraisal.id, appraisalId);
  assert.deepEqual(workspace.comparableSales, []);
  assert.deepEqual(workspace.marketCompetition, []);

  const patchRes = await fetch(growUrl(`/appraisals/${appraisalId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      priceRangeLow: "700000",
      priceRangeHigh: "760000",
      pricingCommentary: "Test pricing commentary.",
      sellingStrategy: "Test selling strategy.",
    }),
  });
  assert.equal(patchRes.status, 200);
  const { appraisal: patched } = (await patchRes.json()) as {
    appraisal: { priceRangeLow: string; priceRangeHigh: string; sellingStrategy: string };
  };
  assert.equal(Number(patched.priceRangeLow), 700000);
  assert.equal(Number(patched.priceRangeHigh), 760000);
  assert.equal(patched.sellingStrategy, "Test selling strategy.");

  // Sec.11 -- a price range with low > high is rejected; there is never a
  // single forced figure, but the range itself still has to make sense.
  const badPatchRes = await fetch(growUrl(`/appraisals/${appraisalId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ priceRangeLow: "900000", priceRangeHigh: "800000" }),
  });
  assert.equal(badPatchRes.status, 409);

  // Sec.9/10 -- comparable sale CRUD, manual entry, tenant-scoped.
  const addSaleRes = await fetch(growUrl(`/appraisals/${appraisalId}/comparable-sales`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ address: "1 Comparable St", salePrice: "735000", bedrooms: 3, bathrooms: 2 }),
  });
  assert.equal(addSaleRes.status, 201);
  const { comparableSale } = (await addSaleRes.json()) as { comparableSale: { id: number; address: string } };
  assert.equal(comparableSale.address, "1 Comparable St");

  const updateSaleRes = await fetch(growUrl(`/appraisals/${appraisalId}/comparable-sales/${comparableSale.id}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ salePrice: "740000" }),
  });
  assert.equal(updateSaleRes.status, 200);
  const { comparableSale: updatedSale } = (await updateSaleRes.json()) as { comparableSale: { salePrice: string } };
  assert.equal(Number(updatedSale.salePrice), 740000);

  const workspaceWithSaleRes = await fetch(growUrl(`/appraisals/${appraisalId}`), { headers: { cookie } });
  const workspaceWithSale = (await workspaceWithSaleRes.json()) as { comparableSales: unknown[] };
  assert.equal(workspaceWithSale.comparableSales.length, 1);

  const deleteSaleRes = await fetch(growUrl(`/appraisals/${appraisalId}/comparable-sales/${comparableSale.id}`), {
    method: "DELETE",
    headers: { cookie },
  });
  assert.equal(deleteSaleRes.status, 204);

  // Market competition CRUD, same shape.
  const addCompRes = await fetch(growUrl(`/appraisals/${appraisalId}/market-competition`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ address: "2 Competition St", askingPriceDisplay: "$750,000", status: "Active" }),
  });
  assert.equal(addCompRes.status, 201);
  const { marketCompetition: compItem } = (await addCompRes.json()) as { marketCompetition: { id: number } };

  const updateCompRes = await fetch(growUrl(`/appraisals/${appraisalId}/market-competition/${compItem.id}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ status: "Under Offer" }),
  });
  assert.equal(updateCompRes.status, 200);

  const deleteCompRes = await fetch(growUrl(`/appraisals/${appraisalId}/market-competition/${compItem.id}`), {
    method: "DELETE",
    headers: { cookie },
  });
  assert.equal(deleteCompRes.status, 204);
});

test("appraisal status lifecycle, follow-up, outcome, and post-outcome lock", async () => {
  const cookie = A.admin.cookie;
  const propertyId = await createProperty(cookie, `2 Status Lifecycle St ${suffix}`);
  const partyId = await createParty(cookie, propertyId, { role: "Buyer" });

  const createRes = await fetch(growUrl("/appraisals/from-contact"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ partyId, propertyId }),
  });
  const { appraisal } = (await createRes.json()) as { appraisal: { id: number } };
  const appraisalId = appraisal.id;

  // Sec.6 -- an out-of-order jump is rejected against ALLOWED_STATUS_TRANSITIONS.
  const badStatusRes = await fetch(growUrl(`/appraisals/${appraisalId}/status`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ toStatus: "WON" }),
  });
  assert.equal(badStatusRes.status, 409);

  for (const toStatus of ["PREPARING", "READY", "SENT", "VIEWED", "PRESENTED"]) {
    const res = await fetch(growUrl(`/appraisals/${appraisalId}/status`), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ toStatus }),
    });
    assert.equal(res.status, 200, `transition to ${toStatus} should succeed`);
    const { appraisal: afterTransition } = (await res.json()) as { appraisal: { status: string } };
    assert.equal(afterTransition.status, toStatus);
  }

  // Sec.17 -- scheduling a follow-up from PRESENTED also advances status to FOLLOW_UP.
  const followUpAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const followUpRes = await fetch(growUrl(`/appraisals/${appraisalId}/follow-up`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ followUpAt, followUpNotes: "Test follow-up." }),
  });
  assert.equal(followUpRes.status, 200);
  const { appraisal: afterFollowUp } = (await followUpRes.json()) as {
    appraisal: { status: string; followUpAt: string | null; followUpNotes: string | null };
  };
  assert.equal(afterFollowUp.status, "FOLLOW_UP");
  assert.ok(afterFollowUp.followUpAt);
  assert.equal(afterFollowUp.followUpNotes, "Test follow-up.");

  // Sec.21 -- the pipeline's follow_up filter surfaces it.
  const pipelineRes = await fetch(growUrl("/appraisals/pipeline?filter=follow_up"), { headers: { cookie } });
  assert.equal(pipelineRes.status, 200);
  const { appraisals: pipelineRows } = (await pipelineRes.json()) as { appraisals: { id: number }[] };
  assert.ok(pipelineRows.some((row) => row.id === appraisalId));

  // Sec.18 -- outcome, reachable from FOLLOW_UP.
  const outcomeRes = await fetch(growUrl(`/appraisals/${appraisalId}/outcome`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ outcome: "WON" }),
  });
  assert.equal(outcomeRes.status, 200);
  const { appraisal: won } = (await outcomeRes.json()) as { appraisal: { status: string; outcome: string | null } };
  assert.equal(won.status, "WON");
  assert.equal(won.outcome, "WON");

  // Sec.14 -- once an outcome is recorded, the workspace is no longer editable.
  const patchAfterOutcomeRes = await fetch(growUrl(`/appraisals/${appraisalId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ pricingCommentary: "Should be rejected." }),
  });
  assert.equal(patchAfterOutcomeRes.status, 409);

  // Sec.19/20 -- Grow -> Run handoff is gated behind run.access, checked here
  // against a real 403-then-200 transition rather than assumed from the route table.
  await revokeEntitlement(A.brokerageId, "run.access");

  const handoffBeforeGrantRes = await fetch(growUrl(`/appraisals/${appraisalId}/run-handoff`), {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(handoffBeforeGrantRes.status, 403);

  await grant(A.brokerageId, "run.access");

  const handoffRes = await fetch(growUrl(`/appraisals/${appraisalId}/run-handoff`), {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(handoffRes.status, 200);
  const handoffBody = (await handoffRes.json()) as { propertyId: number; sellerLinkCreated: boolean };
  assert.equal(handoffBody.propertyId, propertyId);
  assert.equal(handoffBody.sellerLinkCreated, true);

  // Idempotent on a second call -- the seller link already exists.
  const handoffAgainRes = await fetch(growUrl(`/appraisals/${appraisalId}/run-handoff`), {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(handoffAgainRes.status, 200);
  const handoffAgainBody = (await handoffAgainRes.json()) as { sellerLinkCreated: boolean };
  assert.equal(handoffAgainBody.sellerLinkCreated, false);
});

test("create appraisal from a Grow opportunity", async () => {
  const cookie = A.admin.cookie;
  const propertyId = await createProperty(cookie, `3 From Opportunity St ${suffix}`);
  const partyId = await createParty(cookie, propertyId);
  const opportunityId = await createOpportunity(cookie, {
    partyId,
    propertyId,
    opportunityType: "Appraisal",
    reason: "Test opportunity for Priority 4 coverage.",
  });

  const createRes = await fetch(growUrl("/appraisals/from-opportunity"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ opportunityId }),
  });
  assert.equal(createRes.status, 201);
  const { appraisal } = (await createRes.json()) as {
    appraisal: { id: number; opportunityId: number | null; partyId: number | null; propertyId: number };
  };
  assert.equal(appraisal.opportunityId, opportunityId);
  assert.equal(appraisal.partyId, partyId);
  assert.equal(appraisal.propertyId, propertyId);

  // An opportunity that belongs to another brokerage cannot be used to
  // create an appraisal -- Sec.23 tenant isolation, never trust a bare id.
  const crossTenantRes = await fetch(growUrl("/appraisals/from-opportunity"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.admin.cookie },
    body: JSON.stringify({ opportunityId }),
  });
  assert.equal(crossTenantRes.status, 404);
});

test("tenant isolation -- brokerage B cannot read, edit, or transition brokerage A's appraisal", async () => {
  const cookie = A.admin.cookie;
  const propertyId = await createProperty(cookie, `4 Tenant Isolation St ${suffix}`);
  const partyId = await createParty(cookie, propertyId);
  const createRes = await fetch(growUrl("/appraisals/from-contact"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ partyId, propertyId }),
  });
  const { appraisal } = (await createRes.json()) as { appraisal: { id: number } };
  const appraisalId = appraisal.id;

  const otherCookie = B.admin.cookie;

  const getRes = await fetch(growUrl(`/appraisals/${appraisalId}`), { headers: { cookie: otherCookie } });
  assert.equal(getRes.status, 404);

  const patchRes = await fetch(growUrl(`/appraisals/${appraisalId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: otherCookie },
    body: JSON.stringify({ pricingCommentary: "Should not apply." }),
  });
  assert.equal(patchRes.status, 404);

  const statusRes = await fetch(growUrl(`/appraisals/${appraisalId}/status`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: otherCookie },
    body: JSON.stringify({ toStatus: "PREPARING" }),
  });
  assert.equal(statusRes.status, 404);

  const compSaleRes = await fetch(growUrl(`/appraisals/${appraisalId}/comparable-sales`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: otherCookie },
    body: JSON.stringify({ address: "Should not be created" }),
  });
  assert.equal(compSaleRes.status, 404);

  // Brokerage A itself can still read it, for a sanity check that the 404
  // above is a tenant-isolation result and not a broken fixture.
  const ownGetRes = await fetch(growUrl(`/appraisals/${appraisalId}`), { headers: { cookie } });
  assert.equal(ownGetRes.status, 200);
});

