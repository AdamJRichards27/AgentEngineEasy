// GP-1 — manual opportunity lifecycle, contact name on the list, and
// opportunityType validation. No schema change: status Closed and stage Lost
// are the values already named on grow_opportunities.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import {
  appraisals,
  auditLogs,
  db,
  domainEvents,
  entitlementGrants,
  growOpportunities,
  parties,
} from "@aee/db";
import {
  OPPORTUNITY_ACTIVE_APPRAISAL,
  OPPORTUNITY_APPRAISAL_BOOKED_MANUAL,
  OPPORTUNITY_CONVERTED_MANUAL,
  OPPORTUNITY_LOST_REASON_REQUIRED,
  OPPORTUNITY_REOPEN_UNSUPPORTED,
} from "@aee/domain";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let agentB: DevLoginResult;
let readOnly: { admin: DevLoginResult; brokerageId: number };

const ids: Record<string, number> = {};

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

  A = await createBrokerageWithUsers(baseUrl, `GP1 Lifecycle A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `GP1 Lifecycle B ${suffix}`);
  const readOnlyCreated = await createBrokerageWithUsers(baseUrl, `GP1 Lifecycle Read ${suffix}`);
  readOnly = { admin: readOnlyCreated.admin, brokerageId: readOnlyCreated.brokerageId };
  agentB = await devLogin(baseUrl, {
    email: `gp1-agent-b-${suffix}@example.com`,
    firstName: "Agent",
    lastName: "Bee",
    brokerageName: `GP1 Lifecycle A ${suffix}`,
  });

  for (const brokerageId of [A.brokerageId, B.brokerageId]) {
    for (const entitlementKey of ["grow.access", "grow.opportunities.manage", "grow.contacts.manage", "grow.contacts.read"]) {
      await grant(brokerageId, entitlementKey);
    }
  }
  await grant(readOnly.brokerageId, "grow.access");

  const [ada] = await db
    .insert(parties)
    .values({ brokerageId: A.brokerageId, partyType: "Person", firstName: "Ada", lastName: `Lifecycle${suffix}` })
    .returning({ id: parties.id });
  const [bea] = await db
    .insert(parties)
    .values({ brokerageId: A.brokerageId, partyType: "Person", firstName: "Bea", lastName: `Other${suffix}` })
    .returning({ id: parties.id });
  const [harbour] = await db
    .insert(parties)
    .values({ brokerageId: A.brokerageId, partyType: "Organisation", organisationName: `Harbour Management ${suffix}` })
    .returning({ id: parties.id });
  const [zelda] = await db
    .insert(parties)
    .values({ brokerageId: B.brokerageId, partyType: "Person", firstName: "Zelda", lastName: `Foreign${suffix}` })
    .returning({ id: parties.id });
  ids.ada = ada!.id;
  ids.bea = bea!.id;
  ids.harbour = harbour!.id;
  ids.zelda = zelda!.id;

  const at = (iso: string) => new Date(iso);
  const seeds: Array<{ key: string; partyId: number; type: string; reason: string; at: string; brokerage: "A" | "B" }> = [
    { key: "adaOld", partyId: ada!.id, type: "Appraisal", reason: "unrelated beta", at: "2024-04-02T00:00:00.000Z", brokerage: "A" },
    { key: "adaNew", partyId: ada!.id, type: "Listing", reason: "unrelated alpha", at: "2024-04-03T00:00:00.000Z", brokerage: "A" },
    { key: "beaPm", partyId: bea!.id, type: "PropertyManagement", reason: `Ada mentioned ${suffix}`, at: "2024-04-04T00:00:00.000Z", brokerage: "A" },
    { key: "harbour", partyId: harbour!.id, type: "Other", reason: "lease review", at: "2024-04-01T00:00:00.000Z", brokerage: "A" },
    { key: "foreignOpp", partyId: zelda!.id, type: "Listing", reason: "foreign listing", at: "2099-01-01T00:00:00.000Z", brokerage: "B" },
  ];
  for (const seed of seeds) {
    const brokerage = seed.brokerage === "A" ? A : B;
    const [row] = await db
      .insert(growOpportunities)
      .values({
        brokerageId: brokerage.brokerageId,
        partyId: seed.partyId,
        opportunityType: seed.type,
        status: "Open",
        stage: "Qualified",
        reason: seed.reason,
        ownerUserId: brokerage.admin.user.id,
        createdAt: at(seed.at),
        updatedAt: at(seed.at),
      })
      .returning({ id: growOpportunities.id });
    ids[seed.key] = row!.id;
  }

  const [bad] = await db
    .insert(growOpportunities)
    .values({
      brokerageId: A.brokerageId,
      partyId: zelda!.id,
      opportunityType: "Other",
      status: "Open",
      stage: "New",
      reason: `local reason ${suffix}`,
      ownerUserId: A.admin.user.id,
      createdAt: at("2024-04-05T00:00:00.000Z"),
      updatedAt: at("2024-04-05T00:00:00.000Z"),
    })
    .returning({ id: growOpportunities.id });
  ids.badParty = bad!.id;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId, readOnly?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
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

type Opp = {
  id: number;
  opportunityType: string;
  reason: string | null;
  contactName: string | null;
  stage: string;
  status: string;
  brokerageId: number;
};

type ListBody = {
  opportunities?: Opp[];
  nextCursor: string | null;
  total: number;
  error?: string;
};

async function send(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { cookie };
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function getOpportunities(cookie: string, params: Record<string, string | undefined> = {}): Promise<{ status: number; body: ListBody; text: string }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  const suffixQuery = query.size > 0 ? `?${query}` : "";
  const res = await fetch(`${baseUrl}/api/grow/opportunities${suffixQuery}`, { headers: { cookie } });
  const text = await res.text();
  const body = JSON.parse(text) as ListBody;
  return { status: res.status, body, text };
}

async function createOpportunity(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return send("POST", "/grow/opportunities", cookie, body);
}

async function lifecycle(cookie: string, id: number | string, body: unknown): Promise<Response> {
  return send("PATCH", `/grow/opportunities/${id}/lifecycle`, cookie, body);
}

async function opportunityRow(id: number) {
  const [row] = await db.select().from(growOpportunities).where(eq(growOpportunities.id, id));
  return row;
}

async function createOpenOpportunity(reason: string, type = "PropertyManagement"): Promise<number> {
  const res = await createOpportunity(A.admin.cookie, {
    partyId: ids.ada,
    opportunityType: type,
    reason,
  });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { opportunity: { id: number } }).opportunity.id;
}

test("GET /grow/opportunities names the same-brokerage contact and hides a foreign party", async () => {
  const listed = await getOpportunities(A.admin.cookie);
  assert.equal(listed.status, 200);
  const byId = new Map((listed.body.opportunities ?? []).map((row) => [row.id, row]));
  assert.equal(byId.get(ids.adaNew)?.contactName, `Ada Lifecycle${suffix}`);
  assert.equal(byId.get(ids.harbour)?.contactName, `Harbour Management ${suffix}`);
  assert.equal(byId.get(ids.badParty)?.contactName, null);
  assert.equal(listed.text.includes("Zelda"), false);
  assert.equal(listed.text.includes(`Foreign${suffix}`), false);
  assert.equal(byId.has(ids.foreignOpp), false);

  const byName = await getOpportunities(A.admin.cookie, { search: `Ada Lifecycle${suffix}` });
  assert.equal(byName.body.total, 2);
  assert.deepEqual(
    (byName.body.opportunities ?? []).map((row) => row.id),
    [ids.adaNew, ids.adaOld],
  );
  assert.equal((byName.body.opportunities ?? []).every((row) => row.contactName === `Ada Lifecycle${suffix}`), true);

  const byOrg = await getOpportunities(A.admin.cookie, { search: `Harbour Management ${suffix}` });
  assert.equal(byOrg.body.total, 1);
  assert.equal(byOrg.body.opportunities?.[0]?.id, ids.harbour);
  assert.equal(byOrg.body.opportunities?.[0]?.contactName, `Harbour Management ${suffix}`);

  const foreignName = await getOpportunities(A.admin.cookie, { search: "Zelda" });
  assert.equal(foreignName.body.total, 0);
  assert.deepEqual(foreignName.body.opportunities, []);

  const byReason = await getOpportunities(A.admin.cookie, { search: `local reason ${suffix}` });
  assert.equal(byReason.body.total, 1);
  assert.equal(byReason.body.opportunities?.[0]?.id, ids.badParty);
  assert.equal(byReason.body.opportunities?.[0]?.contactName, null);
  assert.equal(byReason.text.includes("Zelda"), false);
});

test("type, contact search and the cursor stay in agreement", async () => {
  const found: number[] = [];
  let cursor: string | undefined;
  let total = -1;
  let pages = 0;
  do {
    const page = await getOpportunities(A.admin.cookie, {
      type: "seller_side",
      search: `Ada Lifecycle${suffix}`,
      limit: "1",
      cursor,
    });
    assert.equal(page.status, 200, page.text);
    if (total === -1) total = page.body.total;
    else assert.equal(page.body.total, total);
    const rows = page.body.opportunities ?? [];
    if (page.body.nextCursor) assert.equal(rows.length, 1);
    found.push(...rows.map((row) => row.id));
    for (const row of rows) {
      assert.equal(row.brokerageId, A.brokerageId);
      assert.ok(row.opportunityType === "Listing" || row.opportunityType === "Appraisal");
    }
    cursor = page.body.nextCursor ?? undefined;
    pages += 1;
    assert.ok(pages < 10);
  } while (cursor);
  assert.deepEqual(found, [ids.adaNew, ids.adaOld]);
  assert.equal(total, 2);

  const managed = await getOpportunities(A.admin.cookie, {
    type: "property_management",
    search: `Ada Lifecycle${suffix}`,
  });
  assert.equal(managed.body.total, 0);

  const reasonAndType = await getOpportunities(A.admin.cookie, {
    type: "property_management",
    search: `Ada mentioned ${suffix}`,
  });
  assert.equal(reasonAndType.body.total, 1);
  assert.equal(reasonAndType.body.opportunities?.[0]?.id, ids.beaPm);
});

test("a lost opportunity's reason is on the contact timeline and stays in this brokerage", async () => {
  const lostReason = `UAT check ${suffix}`;
  const ownReason = `own reason ${suffix}`;
  const id = await createOpenOpportunity(ownReason, "Other");
  await db
    .update(growOpportunities)
    .set({ createdAt: new Date(Date.now() - 60_000) })
    .where(eq(growOpportunities.id, id));

  const lost = await lifecycle(A.admin.cookie, id, { status: "Lost", lostReason: `  ${lostReason}  ` });
  assert.equal(lost.status, 200, await lost.clone().text());

  const listed = await getOpportunities(A.admin.cookie, { search: ownReason });
  assert.equal(listed.status, 200, listed.text);
  const row = (listed.body.opportunities ?? []).find((opportunity) => opportunity.id === id) as
    | (Opp & { status?: string; lostReason?: string | null })
    | undefined;
  assert.ok(row);
  assert.equal(row.status, "Lost");
  assert.equal(row.reason, ownReason);
  assert.equal(row.lostReason, lostReason);

  const foreignList = await getOpportunities(B.admin.cookie, { search: lostReason });
  assert.equal(foreignList.body.total, 0);
  assert.equal(foreignList.text.includes(lostReason), false);

  const detailRes = await send("GET", `/grow/contacts/${ids.ada}`, A.admin.cookie);
  assert.equal(detailRes.status, 200, await detailRes.clone().text());
  const detail = (await detailRes.json()) as {
    opportunities: Array<{ id: number; status: string; reason: string | null; lostReason: string | null }>;
    timeline: Array<{ type: string; opportunityId: number | null; summary: string }>;
  };
  const contactOpportunity = detail.opportunities.find((opportunity) => opportunity.id === id);
  assert.ok(contactOpportunity);
  assert.equal(contactOpportunity.status, "Lost");
  assert.equal(contactOpportunity.reason, ownReason);
  assert.equal(contactOpportunity.lostReason, lostReason);

  const updated = detail.timeline.find((event) => event.type === "OPPORTUNITY_UPDATED" && event.opportunityId === id);
  assert.ok(updated, JSON.stringify(detail.timeline.filter((event) => event.opportunityId === id)));
  assert.equal(updated.summary, `Opportunity updated: Other (Lost/Lost). Lost reason: ${lostReason}.`);
  const created = detail.timeline.find((event) => event.type === "OPPORTUNITY_CREATED" && event.opportunityId === id);
  assert.ok(created);
  assert.equal(created.summary.includes(lostReason), false);

  const foreignDetail = await send("GET", `/grow/contacts/${ids.ada}`, B.admin.cookie);
  assert.equal(foreignDetail.status, 404);
  assert.equal((await foreignDetail.text()).includes(lostReason), false);
});

test("POST /grow/opportunities rejects an opportunityType outside the domain list", async () => {
  for (const opportunityType of ["General", "general", "Nope", "listing"]) {
    const rejected = await createOpportunity(A.admin.cookie, {
      partyId: ids.ada,
      opportunityType,
      reason: "should not be stored",
    });
    assert.equal(rejected.status, 400, opportunityType);
    const body = (await rejected.json()) as { error?: string };
    assert.equal(body.error, "opportunityType must be one of Listing, Appraisal, PropertyManagement, Other");
  }
  const missing = await createOpportunity(A.admin.cookie, { partyId: ids.ada, reason: "no type" });
  assert.equal(missing.status, 400);
  assert.equal(((await missing.json()) as { error?: string }).error, "partyId, opportunityType, and reason are required");

  const accepted = await createOpportunity(A.admin.cookie, {
    partyId: ids.ada,
    opportunityType: "Other",
    reason: `accepted other ${suffix}`,
  });
  assert.equal(accepted.status, 201, await accepted.clone().text());
  const created = (await accepted.json()) as { opportunity: { opportunityType: string; stage: string; status: string } };
  assert.equal(created.opportunity.opportunityType, "Other");
  assert.equal(created.opportunity.stage, "New");
  assert.equal(created.opportunity.status, "Open");
});

test("an open opportunity can move between manual stages, be marked lost, and be closed", async () => {
  const id = await createOpenOpportunity(`lifecycle moves ${suffix}`, "Other");
  const contacted = await lifecycle(A.admin.cookie, id, { stage: "Contacted" });
  assert.equal(contacted.status, 200, await contacted.clone().text());
  assert.equal(((await contacted.json()) as { opportunity: { stage: string; status: string } }).opportunity.stage, "Contacted");

  const qualified = await lifecycle(A.admin.cookie, id, { stage: "Qualified" });
  assert.equal(qualified.status, 200, await qualified.clone().text());
  const back = await lifecycle(A.admin.cookie, id, { stage: "New" });
  assert.equal(back.status, 200, await back.clone().text());
  const afterBack = await opportunityRow(id);
  assert.equal(afterBack.stage, "New");
  assert.equal(afterBack.status, "Open");
  assert.equal(afterBack.closedAt, null);

  const same = await lifecycle(A.admin.cookie, id, { stage: "New" });
  assert.equal(same.status, 200, await same.clone().text());

  const booked = await lifecycle(A.admin.cookie, id, { stage: "AppraisalBooked" });
  assert.equal(booked.status, 409);
  assert.equal(((await booked.json()) as { error: string }).error, OPPORTUNITY_APPRAISAL_BOOKED_MANUAL);
  const converted = await lifecycle(A.admin.cookie, id, { status: "Converted" });
  assert.equal(converted.status, 409);
  assert.equal(((await converted.json()) as { error: string }).error, OPPORTUNITY_CONVERTED_MANUAL);
  const stageConverted = await lifecycle(A.admin.cookie, id, { stage: "Converted" });
  assert.equal(stageConverted.status, 409);
  assert.equal(((await stageConverted.json()) as { error: string }).error, OPPORTUNITY_CONVERTED_MANUAL);

  for (const body of [{ status: "Lost" }, { status: "Lost", lostReason: "  " }, { stage: "Lost" }]) {
    const missingReason = await lifecycle(A.admin.cookie, id, body);
    assert.equal(missingReason.status, 400, JSON.stringify(body));
  }
  const blank = await lifecycle(A.admin.cookie, id, { status: "Lost", lostReason: "   " });
  assert.equal(((await blank.json()) as { error: string }).error, OPPORTUNITY_LOST_REASON_REQUIRED);

  const lost = await lifecycle(A.admin.cookie, id, { status: "Lost", lostReason: "  Seller said no  " });
  assert.equal(lost.status, 200, await lost.clone().text());
  const lostRow = await opportunityRow(id);
  assert.equal(lostRow.status, "Lost");
  assert.equal(lostRow.stage, "Lost");
  assert.equal(lostRow.lostReason, "Seller said no");
  assert.ok(lostRow.closedAt);

  const reopen = await lifecycle(A.admin.cookie, id, { stage: "Qualified" });
  assert.equal(reopen.status, 409);
  assert.equal(((await reopen.json()) as { error: string }).error, OPPORTUNITY_REOPEN_UNSUPPORTED);
  const reopenOpen = await lifecycle(A.admin.cookie, id, { status: "Open" });
  assert.equal(reopenOpen.status, 409);
  assert.equal(((await reopenOpen.json()) as { error: string }).error, OPPORTUNITY_REOPEN_UNSUPPORTED);
  const stillLost = await opportunityRow(id);
  assert.equal(stillLost.status, "Lost");
  assert.equal(stillLost.stage, "Lost");

  const closeId = await createOpenOpportunity(`lifecycle close ${suffix}`, "PropertyManagement");
  await lifecycle(A.admin.cookie, closeId, { stage: "Qualified" });
  const eventsBefore = await stageEvents(closeId);
  const closed = await lifecycle(A.admin.cookie, closeId, { status: "Closed" });
  assert.equal(closed.status, 200, await closed.clone().text());
  const closedRow = await opportunityRow(closeId);
  assert.equal(closedRow.status, "Closed");
  assert.equal(closedRow.stage, "Qualified");
  assert.ok(closedRow.closedAt);
  const eventsAfter = await stageEvents(closeId);
  assert.equal(eventsAfter.length, eventsBefore.length, "closing does not change stage, so it does not emit OPPORTUNITY_STAGE_CHANGED");
  const reopenClosed = await lifecycle(A.admin.cookie, closeId, { stage: "New" });
  assert.equal(reopenClosed.status, 409);
  assert.equal((await opportunityRow(closeId)).status, "Closed");
});

test("a lifecycle change writes an audit row and emits OPPORTUNITY_STAGE_CHANGED", async () => {
  const id = await createOpenOpportunity(`lifecycle audit ${suffix}`, "Other");
  const moved = await lifecycle(A.admin.cookie, id, { stage: "Contacted" });
  assert.equal(moved.status, 200, await moved.clone().text());

  const audits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordType, "grow_opportunity"), eq(auditLogs.recordId, String(id)), eq(auditLogs.action, "grow_opportunity_lifecycle_updated")));
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.brokerageId, A.brokerageId);
  const previous = JSON.parse(audits[0]!.previousValue ?? "{}") as { stage: string; status: string };
  const updated = JSON.parse(audits[0]!.updatedValue ?? "{}") as { stage: string; status: string };
  assert.equal(previous.stage, "New");
  assert.equal(previous.status, "Open");
  assert.equal(updated.stage, "Contacted");
  assert.equal(updated.status, "Open");

  const events = await stageEvents(id);
  assert.equal(events.length, 1);
  const payload = events[0]!.payload as { opportunityId: number; previousStage: string; stage: string; previousStatus: string; status: string };
  assert.equal(payload.opportunityId, id);
  assert.equal(payload.previousStage, "New");
  assert.equal(payload.stage, "Contacted");
  assert.equal(payload.previousStatus, "Open");
  assert.equal(payload.status, "Open");
  assert.equal(events[0]?.brokerageId, A.brokerageId);
});

test("an active appraisal blocks manual changes, and a terminal appraisal does not", async () => {
  const propertyRes = await send("POST", "/properties", A.admin.cookie, {
    formattedAddress: `1 Appraisal Gate ${suffix}`,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(propertyRes.status, 201, await propertyRes.clone().text());
  const propertyId = ((await propertyRes.json()) as { property: { id: number } }).property.id;
  const created = await createOpportunity(A.admin.cookie, {
    partyId: ids.ada,
    propertyId,
    opportunityType: "Appraisal",
    reason: `appraisal linked ${suffix}`,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const id = ((await created.json()) as { opportunity: { id: number } }).opportunity.id;

  const [appraisal] = await db
    .insert(appraisals)
    .values({ propertyId, partyId: ids.ada, opportunityId: id, status: "DRAFT" })
    .returning({ id: appraisals.id });
  await db.update(growOpportunities).set({ convertedAppraisalId: appraisal!.id, stage: "AppraisalBooked" }).where(eq(growOpportunities.id, id));

  for (const body of [{ stage: "Qualified" }, { status: "Lost", lostReason: "Seller said no" }, { status: "Closed" }]) {
    const refused = await lifecycle(A.admin.cookie, id, body);
    assert.equal(refused.status, 409, JSON.stringify(body));
    assert.equal(((await refused.json()) as { error: string }).error, OPPORTUNITY_ACTIVE_APPRAISAL);
  }
  const blocked = await opportunityRow(id);
  assert.equal(blocked.stage, "AppraisalBooked");
  assert.equal(blocked.status, "Open");

  await db.update(appraisals).set({ status: "LOST" }).where(eq(appraisals.id, appraisal!.id));
  const allowed = await lifecycle(A.admin.cookie, id, { stage: "Qualified" });
  assert.equal(allowed.status, 200, await allowed.clone().text());
  const moved = await opportunityRow(id);
  assert.equal(moved.stage, "Qualified");
  assert.equal(moved.status, "Open");
});

test("lifecycle enforces tenant scope, a crafted id, and FU-1 owner visibility", async () => {
  const own = await createOpenOpportunity(`visibility ${suffix}`, "Other");

  const forbidden = await lifecycle(readOnly.admin.cookie, own, { stage: "Contacted" });
  assert.equal(forbidden.status, 403);

  const foreign = await lifecycle(B.admin.cookie, own, { stage: "Contacted" });
  assert.equal(foreign.status, 404);
  assert.equal(((await foreign.json()) as { error: string }).error, "Opportunity not found");
  assert.equal((await opportunityRow(own)).stage, "New");

  const crafted = await lifecycle(A.admin.cookie, "1 OR 1=1", { stage: "Contacted" });
  assert.equal(crafted.status, 400);
  const outOfRange = await lifecycle(A.admin.cookie, "2147483648", { stage: "Contacted" });
  assert.equal(outOfRange.status, 400);
  const missing = await lifecycle(A.admin.cookie, "2147483647", { stage: "Contacted", brokerageId: B.brokerageId });
  assert.equal(missing.status, 404);

  const smuggled = await lifecycle(A.admin.cookie, own, { stage: "Contacted", brokerageId: B.brokerageId });
  assert.equal(smuggled.status, 200, await smuggled.clone().text());
  const ownRow = await opportunityRow(own);
  assert.equal(ownRow.brokerageId, A.brokerageId);
  assert.equal(ownRow.stage, "Contacted");
  const foreignRow = await opportunityRow(ids.foreignOpp);
  assert.equal(foreignRow.stage, "Qualified");
  assert.equal(foreignRow.brokerageId, B.brokerageId);

  const otherTenant = await lifecycle(A.admin.cookie, ids.foreignOpp, { stage: "New" });
  assert.equal(otherTenant.status, 404);
  assert.equal((await opportunityRow(ids.foreignOpp)).stage, "Qualified");

  const unlinked = await createOpportunity(A.agent.cookie, {
    partyId: ids.ada,
    opportunityType: "Other",
    reason: `unlinked owner ${suffix}`,
  });
  assert.equal(unlinked.status, 201, await unlinked.clone().text());
  const unlinkedId = ((await unlinked.json()) as { opportunity: { id: number } }).opportunity.id;

  const stranger = await lifecycle(agentB.cookie, unlinkedId, { stage: "Contacted" });
  assert.equal(stranger.status, 404);
  assert.equal(((await stranger.json()) as { error: string }).error, "Opportunity not found");
  assert.equal((await opportunityRow(unlinkedId)).stage, "New");
  assert.equal((await opportunityRow(unlinkedId)).ownerUserId, A.agent.user.id);

  const owner = await lifecycle(A.agent.cookie, unlinkedId, { stage: "Contacted" });
  assert.equal(owner.status, 200, await owner.clone().text());
  assert.equal((await opportunityRow(unlinkedId)).stage, "Contacted");

  const listedStranger = await getOpportunities(agentB.cookie, { search: `unlinked owner ${suffix}` });
  assert.equal(listedStranger.body.total, 0);
  const listedOwner = await getOpportunities(A.agent.cookie, { search: `unlinked owner ${suffix}` });
  assert.equal(listedOwner.body.total, 1);
  assert.equal(listedOwner.body.opportunities?.[0]?.contactName, `Ada Lifecycle${suffix}`);
});

test("lost and closed opportunities drop out of Grow Today open counts", async () => {
  const before = await send("GET", "/grow/today", A.admin.cookie);
  assert.equal(before.status, 200, await before.clone().text());
  const beforeBody = (await before.json()) as { counts: { openOpportunities: number }; priorityActions: Array<{ id: string }> };
  const beforeCount = beforeBody.counts.openOpportunities;

  const lostId = await createOpenOpportunity(`today lost ${suffix}`, "PropertyManagement");
  const openLost = await send("GET", "/grow/today", A.admin.cookie);
  const openLostBody = (await openLost.json()) as { counts: { openOpportunities: number }; priorityActions: Array<{ id: string }> };
  assert.equal(openLostBody.counts.openOpportunities, beforeCount + 1);
  assert.equal(openLostBody.priorityActions.some((card) => card.id === `opportunity:${lostId}`), true);

  const lost = await lifecycle(A.admin.cookie, lostId, { status: "Lost", lostReason: "No longer selling" });
  assert.equal(lost.status, 200, await lost.clone().text());
  const afterLost = await send("GET", "/grow/today", A.admin.cookie);
  const afterLostBody = (await afterLost.json()) as { counts: { openOpportunities: number }; priorityActions: Array<{ id: string }> };
  assert.equal(afterLostBody.counts.openOpportunities, beforeCount);
  assert.equal(afterLostBody.priorityActions.some((card) => card.id === `opportunity:${lostId}`), false);

  const closeId = await createOpenOpportunity(`today close ${suffix}`, "Other");
  const closed = await lifecycle(A.admin.cookie, closeId, { status: "Closed" });
  assert.equal(closed.status, 200, await closed.clone().text());
  const afterClose = await send("GET", "/grow/today", A.admin.cookie);
  const afterCloseBody = (await afterClose.json()) as { counts: { openOpportunities: number }; priorityActions: Array<{ id: string }> };
  assert.equal(afterCloseBody.counts.openOpportunities, beforeCount);
  assert.equal(afterCloseBody.priorityActions.some((card) => card.id === `opportunity:${closeId}`), false);

  const overview = await send("GET", "/grow/overview", A.admin.cookie);
  const overviewBody = (await overview.json()) as { openOpportunityCount: number };
  assert.equal(overviewBody.openOpportunityCount, beforeCount);
});

async function stageEvents(opportunityId: number) {
  return db
    .select()
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.brokerageId, A.brokerageId),
        eq(domainEvents.eventType, "OPPORTUNITY_STAGE_CHANGED"),
        sql`${domainEvents.payload}->>'opportunityId' = ${String(opportunityId)}`,
      ),
    );
}
