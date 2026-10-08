// I-9 / I-10 — keyset pagination for the four Grow list endpoints.
//
// GET /grow/contacts, /grow/relationships, /grow/activities and /grow/opportunities
// used to return the 200 newest rows and stop. These tests lock the replacement:
// default page 50, clamp at 100, an opaque (sort_at, id) cursor with no gaps or
// duplicates across ties, an exact filtered count, server-side search, and a
// bad-row proof that another brokerage's rows never appear in a page or a count,
// including when the cursor is crafted from that foreign row.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { db, entitlementGrants, growActivities, growOpportunities, growRelationships, parties } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { encodeGrowListCursor } from "../../lib/growListPage.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const keysetName = `Keyset${suffix}`;
const capName = `Cap${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

type Stamped = { id: number; at: number };

let keysetContacts: Stamped[] = [];
let capContacts: Stamped[] = [];
let relationships: Stamped[] = [];
let activities: Stamped[] = [];
let opportunities: Stamped[] = [];
let foreignContactId = 0;
let foreignOpportunityId = 0;
let foreignActivityId = 0;
let uniqueActivityId = 0;
let uniqueOpportunityId = 0;
let zebraContactId = 0;

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

  A = await createBrokerageWithUsers(baseUrl, `I9 List Page A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `I9 List Page B ${suffix}`);
  for (const brokerageId of [A.brokerageId, B.brokerageId]) {
    for (const key of ["grow.access", "grow.contacts.read"]) {
      await db.insert(entitlementGrants).values({
        brokerageId,
        entitlementKey: key,
        granteeType: "brokerage",
        granteeId: brokerageId,
        sourceType: "manual",
        status: "Active",
      });
    }
    invalidateEntitlementCache(brokerageId);
  }

  const at = (iso: string) => new Date(iso).getTime();
  const keysetSpec = [
    { firstName: "Oldest", at: at("2020-01-01T00:00:00.000Z") },
    { firstName: "Middle", at: at("2021-06-01T00:00:00.000Z") },
    { firstName: "TieLow", at: at("2022-06-15T12:30:00.000Z") },
    { firstName: "TieHigh", at: at("2022-06-15T12:30:00.000Z") },
    { firstName: "Newest", at: at("2023-03-01T00:00:00.000Z") },
  ];
  const keysetRows = await db
    .insert(parties)
    .values(
      keysetSpec.map((row) => ({
        brokerageId: A.brokerageId,
        partyType: "Person" as const,
        firstName: row.firstName,
        lastName: keysetName,
        createdAt: new Date(row.at),
        updatedAt: new Date(row.at),
      })),
    )
    .returning({ id: parties.id, createdAt: parties.createdAt });
  keysetContacts = keysetRows.map((row) => ({ id: row.id, at: row.createdAt.getTime() }));

  // Outside the keyset search, and the oldest of the cap set, so a server-side
  // search has to find it past the first page of the unfiltered cap.
  const capStart = at("2024-01-01T00:00:00.000Z");
  const capRows = await db
    .insert(parties)
    .values(
      Array.from({ length: 120 }, (_, index) => {
        const createdAt = new Date(capStart + index * 1000);
        return {
          brokerageId: A.brokerageId,
          partyType: "Person" as const,
          firstName: index === 0 ? "ZebraOnly" : "Cap",
          lastName: capName,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    )
    .returning({ id: parties.id, createdAt: parties.createdAt, firstName: parties.firstName });
  capContacts = capRows.map((row) => ({ id: row.id, at: row.createdAt.getTime() }));
  zebraContactId = capRows.find((row) => row.firstName === "ZebraOnly")!.id;

  await db.insert(parties).values({
    brokerageId: A.brokerageId,
    partyType: "Person",
    firstName: "Decoy",
    lastName: `Other${suffix}`,
    createdAt: new Date(at("2019-01-01T00:00:00.000Z")),
    updatedAt: new Date(at("2019-01-01T00:00:00.000Z")),
  });

  const [foreignParty] = await db
    .insert(parties)
    .values({
      brokerageId: B.brokerageId,
      partyType: "Person",
      firstName: "Foreign",
      lastName: capName,
      createdAt: new Date(at("2099-01-01T00:00:00.000Z")),
      updatedAt: new Date(at("2099-01-01T00:00:00.000Z")),
    })
    .returning({ id: parties.id });
  foreignContactId = foreignParty!.id;
  await db.insert(parties).values({
    brokerageId: B.brokerageId,
    partyType: "Person",
    firstName: "ForeignKeyset",
    lastName: keysetName,
    createdAt: new Date(at("2099-06-01T00:00:00.000Z")),
    updatedAt: new Date(at("2099-06-01T00:00:00.000Z")),
  });

  const anchor = keysetContacts[0]!;
  const relationSpec = keysetContacts.map((contact, index) => ({
    partyId: contact.id,
    at: at("2024-02-01T00:00:00.000Z") + (index === 3 || index === 4 ? 5_000 : index * 1_000),
  }));
  // index 3 and 4 share a timestamp so the id tiebreaker is the only order.
  relationSpec[3]!.at = at("2024-02-02T00:00:00.000Z");
  relationSpec[4]!.at = at("2024-02-02T00:00:00.000Z");
  const relationRows = await db
    .insert(growRelationships)
    .values(
      relationSpec.map((row) => ({
        brokerageId: A.brokerageId,
        partyId: row.partyId,
        relationshipType: "owner",
        status: "Active",
        createdAt: new Date(row.at),
        updatedAt: new Date(row.at),
      })),
    )
    .returning({ id: growRelationships.id, createdAt: growRelationships.createdAt });
  relationships = relationRows.map((row) => ({ id: row.id, at: row.createdAt.getTime() }));

  // Bad row: this brokerage's relationship pointing at the other brokerage's party.
  await db.insert(growRelationships).values({
    brokerageId: A.brokerageId,
    partyId: foreignContactId,
    relationshipType: "owner",
    status: "Active",
  });
  await db.insert(growRelationships).values({
    brokerageId: B.brokerageId,
    partyId: foreignContactId,
    relationshipType: "owner",
    status: "Active",
  });

  const activitySpec = [0, 1, 2, 2, 4].map((slot, index) => ({
    summary: index === 0 ? `Unique activity ${suffix}` : `Activity ${keysetName} ${index}`,
    at: at("2024-03-01T00:00:00.000Z") + slot * 60_000,
  }));
  const activityRows = await db
    .insert(growActivities)
    .values(
      activitySpec.map((row) => ({
        brokerageId: A.brokerageId,
        partyId: anchor.id,
        activityType: "note",
        occurredAt: new Date(row.at),
        summary: row.summary,
      })),
    )
    .returning({ id: growActivities.id, occurredAt: growActivities.occurredAt, summary: growActivities.summary });
  activities = activityRows.map((row) => ({ id: row.id, at: row.occurredAt.getTime() }));
  uniqueActivityId = activityRows.find((row) => row.summary.startsWith("Unique activity"))!.id;
  const [foreignActivity] = await db
    .insert(growActivities)
    .values({
      brokerageId: B.brokerageId,
      activityType: "note",
      occurredAt: new Date(at("2099-03-01T00:00:00.000Z")),
      summary: `Activity ${keysetName} foreign`,
    })
    .returning({ id: growActivities.id });
  foreignActivityId = foreignActivity!.id;

  const opportunitySpec = [0, 1, 1, 3].map((slot, index) => ({
    reason: index === 0 ? `Unique opportunity ${suffix}` : `Opportunity ${keysetName} ${index}`,
    at: at("2024-04-01T00:00:00.000Z") + slot * 60_000,
  }));
  const opportunityRows = await db
    .insert(growOpportunities)
    .values(
      opportunitySpec.map((row) => ({
        brokerageId: A.brokerageId,
        partyId: anchor.id,
        opportunityType: "Listing",
        status: "Open",
        reason: row.reason,
        ownerUserId: A.admin.user.id,
        createdAt: new Date(row.at),
        updatedAt: new Date(row.at),
      })),
    )
    .returning({ id: growOpportunities.id, createdAt: growOpportunities.createdAt, reason: growOpportunities.reason });
  opportunities = opportunityRows.map((row) => ({ id: row.id, at: row.createdAt.getTime() }));
  uniqueOpportunityId = opportunityRows.find((row) => (row.reason ?? "").startsWith("Unique opportunity"))!.id;
  const [foreignOpportunity] = await db
    .insert(growOpportunities)
    .values({
      brokerageId: B.brokerageId,
      partyId: foreignContactId,
      opportunityType: "Listing",
      status: "Open",
      reason: `Opportunity ${keysetName} foreign`,
      ownerUserId: B.admin.user.id,
      createdAt: new Date(at("2099-04-01T00:00:00.000Z")),
      updatedAt: new Date(at("2099-04-01T00:00:00.000Z")),
    })
    .returning({ id: growOpportunities.id });
  foreignOpportunityId = foreignOpportunity!.id;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

function byRecency(rows: Stamped[]): number[] {
  return [...rows].sort((a, b) => b.at - a.at || b.id - a.id).map((row) => row.id);
}

type ListBody<T> = {
  nextCursor: string | null;
  total: number;
  limit: number;
  error?: string;
  contacts?: T[];
  relationships?: T[];
  activities?: T[];
  opportunities?: T[];
};

async function getList<T extends { id: number }>(
  path: string,
  cookie: string,
  params: Record<string, string | undefined> = {},
): Promise<{ status: number; body: ListBody<T> }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  const suffixQuery = query.size > 0 ? `?${query}` : "";
  const res = await fetch(`${baseUrl}/api${path}${suffixQuery}`, { headers: { cookie } });
  const body = (await res.json()) as ListBody<T>;
  return { status: res.status, body };
}

function collection<T>(body: ListBody<T>, key: "contacts" | "relationships" | "activities" | "opportunities"): T[] {
  return body[key] ?? [];
}

async function walk<T extends { id: number }>(
  path: string,
  key: "contacts" | "relationships" | "activities" | "opportunities",
  cookie: string,
  limit: number,
  params: Record<string, string> = {},
) {
  const ids: number[] = [];
  let cursor: string | undefined;
  let total = -1;
  let pages = 0;
  const applied = Math.min(limit, 100);
  do {
    const { status, body } = await getList<T>(path, cookie, { ...params, limit: String(limit), cursor });
    assert.equal(status, 200, JSON.stringify(body));
    if (total === -1) total = body.total;
    else assert.equal(body.total, total, "the exact count does not change as the cursor moves");
    assert.equal(body.limit, applied);
    const rows = collection(body, key);
    if (body.nextCursor) assert.equal(rows.length, applied);
    else assert.ok(rows.length <= applied);
    ids.push(...rows.map((row) => row.id));
    cursor = body.nextCursor ?? undefined;
    pages += 1;
    assert.ok(pages < 30, "pagination did not terminate");
  } while (cursor);
  assert.equal(new Set(ids).size, ids.length, "a later page repeated an earlier row");
  return { ids, total };
}

test("contacts default to 50, clamp at 100, and count the whole filter", async () => {
  const first = await getList<{ id: number }>("/grow/contacts", A.admin.cookie, { search: capName });
  assert.equal(first.status, 200);
  assert.equal(first.body.limit, 50);
  assert.equal(first.body.total, 120);
  assert.equal(collection(first.body, "contacts").length, 50);
  assert.equal(collection(first.body, "contacts")[0]?.id, byRecency(capContacts)[0]);
  assert.equal(collection(first.body, "contacts").some((row) => row.id === zebraContactId), false);
  assert.ok(first.body.nextCursor);

  const clamped = await getList<{ id: number }>("/grow/contacts", A.admin.cookie, { search: capName, limit: "1000" });
  assert.equal(clamped.status, 200);
  assert.equal(clamped.body.limit, 100);
  assert.equal(collection(clamped.body, "contacts").length, 100);
  assert.equal(clamped.body.total, 120);

  const exact = await getList<{ id: number }>("/grow/contacts", A.admin.cookie, { search: capName, limit: "100" });
  assert.equal(exact.body.limit, 100);
  assert.equal(collection(exact.body, "contacts").length, 100);

  for (const limit of ["0", "-1", "1.5", "abc"]) {
    const rejected = await getList("/grow/contacts", A.admin.cookie, { limit });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, "limit must be a positive integer");
  }
  const badCursor = await getList("/grow/contacts", A.admin.cookie, { cursor: "not-a-cursor" });
  assert.equal(badCursor.status, 400);
  assert.equal(badCursor.body.error, "cursor is invalid");
});

test("contact pages are continuous across timestamp ties, and search is the whole brokerage", async () => {
  const walked = await walk<{ id: number }>("/grow/contacts", "contacts", A.admin.cookie, 2, { search: keysetName });
  assert.deepEqual(walked.ids, byRecency(keysetContacts));
  assert.equal(walked.total, keysetContacts.length);

  const cap = await walk<{ id: number }>("/grow/contacts", "contacts", A.admin.cookie, 50, { search: capName });
  assert.deepEqual(cap.ids, byRecency(capContacts));
  assert.equal(cap.total, 120);

  const zebra = await getList<{ id: number; displayName?: string }>("/grow/contacts", A.admin.cookie, { search: "ZebraOnly" });
  assert.equal(zebra.body.total, 1);
  assert.deepEqual(collection(zebra.body, "contacts").map((row) => row.id), [zebraContactId]);

  const excluded = keysetContacts[keysetContacts.length - 1]!.id;
  const without = await getList<{ id: number }>("/grow/contacts", A.admin.cookie, {
    search: keysetName,
    excludePartyId: String(excluded),
  });
  assert.equal(without.body.total, keysetContacts.length - 1);
  assert.equal(collection(without.body, "contacts").some((row) => row.id === excluded), false);
  assert.equal(collection(without.body, "contacts").some((row) => row.id === foreignContactId), false);
});

test("a crafted cursor cannot pull another brokerage's contacts into the page or the count", async () => {
  const [foreign] = await db
    .select({
      id: parties.id,
      sortAt: sql<string>`to_char(${parties.createdAt}, 'YYYY-MM-DD HH24:MI:SS.US')`,
    })
    .from(parties)
    .where(eq(parties.id, foreignContactId));
  const crafted = Buffer.from(
    JSON.stringify({ at: foreign!.sortAt, id: foreign!.id, brokerageId: B.brokerageId }),
    "utf8",
  ).toString("base64url");
  const decoded = JSON.parse(Buffer.from(crafted, "base64url").toString("utf8")) as { brokerageId?: number };
  assert.equal(decoded.brokerageId, B.brokerageId, "the crafted cursor really does name the other brokerage");

  const page = await getList<{ id: number }>("/grow/contacts", A.admin.cookie, { search: capName, cursor: crafted, limit: "50" });
  assert.equal(page.status, 200);
  assert.equal(page.body.total, 120);
  const ids = collection(page.body, "contacts").map((row) => row.id);
  assert.equal(ids.includes(foreignContactId), false);
  assert.deepEqual(ids, byRecency(capContacts).slice(0, 50));

  const encoded = encodeGrowListCursor({ at: foreign!.sortAt, id: foreign!.id });
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ["at", "id"]);

  const other = await getList<{ id: number }>("/grow/contacts", B.admin.cookie, { search: capName });
  assert.equal(other.body.total, 1);
  assert.deepEqual(collection(other.body, "contacts").map((row) => row.id), [foreignContactId]);
});

test("relationships, activities and opportunities page on (sort key, id) and count the filter", async () => {
  const relationWalk = await walk<{ id: number }>("/grow/relationships", "relationships", A.admin.cookie, 2);
  assert.equal(relationWalk.total, relationships.length);
  assert.deepEqual(relationWalk.ids, byRecency(relationships));
  const tieSearch = await getList<{ id: number; partyFirstName: string | null }>("/grow/relationships", A.admin.cookie, {
    search: "Tie",
  });
  assert.equal(tieSearch.body.total, 2);
  assert.deepEqual(
    collection(tieSearch.body, "relationships")
      .map((row) => row.partyFirstName)
      .sort(),
    ["TieHigh", "TieLow"],
  );

  const allRelationships = await getList<{ id: number }>("/grow/relationships", A.admin.cookie);
  assert.equal(allRelationships.body.limit, 50);
  assert.equal(allRelationships.body.total, relationships.length);
  assert.equal(allRelationships.body.nextCursor, null);

  const clamped = await getList<{ id: number }>("/grow/relationships", A.admin.cookie, { limit: "500" });
  assert.equal(clamped.body.limit, 100);
  assert.equal(collection(clamped.body, "relationships").length, relationships.length);

  const activityWalk = await walk<{ id: number }>("/grow/activities", "activities", A.admin.cookie, 2, { search: keysetName });
  const namedActivities = activities.filter((row) => row.id !== uniqueActivityId);
  assert.equal(activityWalk.total, namedActivities.length);
  assert.deepEqual(activityWalk.ids, byRecency(namedActivities));
  const uniqueActivity = await getList<{ id: number }>("/grow/activities", A.admin.cookie, { search: `Unique activity ${suffix}` });
  assert.equal(uniqueActivity.body.total, 1);
  assert.deepEqual(collection(uniqueActivity.body, "activities").map((row) => row.id), [uniqueActivityId]);

  const opportunityWalk = await walk<{ id: number }>("/grow/opportunities", "opportunities", A.admin.cookie, 2, { search: keysetName });
  const namedOpportunities = opportunities.filter((row) => row.id !== uniqueOpportunityId);
  assert.equal(opportunityWalk.total, namedOpportunities.length);
  assert.deepEqual(opportunityWalk.ids, byRecency(namedOpportunities));
  const uniqueOpportunity = await getList<{ id: number }>("/grow/opportunities", A.admin.cookie, {
    search: `Unique opportunity ${suffix}`,
  });
  assert.equal(uniqueOpportunity.body.total, 1);
  assert.deepEqual(collection(uniqueOpportunity.body, "opportunities").map((row) => row.id), [uniqueOpportunityId]);

  const badCursor = await getList("/grow/opportunities", A.admin.cookie, { cursor: "%%%" });
  assert.equal(badCursor.status, 400);
  const badId = await getList("/grow/opportunities", A.admin.cookie, { id: "0" });
  assert.equal(badId.status, 400);
  assert.equal(badId.body.error, "id must be a positive integer");
});

test("foreign brokerage rows stay out of relationship, activity and opportunity pages and counts", async () => {
  const listedRelationships = await walk<{ id: number; partyId: number }>("/grow/relationships", "relationships", A.admin.cookie, 50);
  assert.equal(listedRelationships.total, relationships.length);
  assert.deepEqual(listedRelationships.ids, byRecency(relationships));
  const relationPage = await getList<{ id: number; partyId: number }>("/grow/relationships", A.admin.cookie);
  assert.equal(
    collection(relationPage.body, "relationships").some((row) => row.partyId === foreignContactId),
    false,
  );

  const [foreignOpportunity] = await db
    .select({
      id: growOpportunities.id,
      sortAt: sql<string>`to_char(${growOpportunities.createdAt}, 'YYYY-MM-DD HH24:MI:SS.US')`,
    })
    .from(growOpportunities)
    .where(eq(growOpportunities.id, foreignOpportunityId));
  const crafted = Buffer.from(
    JSON.stringify({ at: foreignOpportunity!.sortAt, id: foreignOpportunity!.id, brokerageId: B.brokerageId }),
    "utf8",
  ).toString("base64url");
  const paged = await getList<{ id: number }>("/grow/opportunities", A.admin.cookie, { cursor: crafted, limit: "50" });
  assert.equal(paged.status, 200);
  assert.equal(paged.body.total, opportunities.length);
  assert.equal(collection(paged.body, "opportunities").some((row) => row.id === foreignOpportunityId), false);
  assert.deepEqual(
    collection(paged.body, "opportunities").map((row) => row.id),
    byRecency(opportunities),
  );

  const byForeignId = await getList<{ id: number }>("/grow/opportunities", A.admin.cookie, { id: String(foreignOpportunityId) });
  assert.equal(byForeignId.status, 200);
  assert.equal(byForeignId.body.total, 0);
  assert.deepEqual(collection(byForeignId.body, "opportunities"), []);

  const ownById = await getList<{ id: number }>("/grow/opportunities", A.admin.cookie, { id: String(uniqueOpportunityId) });
  assert.equal(ownById.body.total, 1);
  assert.deepEqual(collection(ownById.body, "opportunities").map((row) => row.id), [uniqueOpportunityId]);

  const [foreignActivity] = await db
    .select({
      id: growActivities.id,
      sortAt: sql<string>`to_char(${growActivities.occurredAt}, 'YYYY-MM-DD HH24:MI:SS.US')`,
    })
    .from(growActivities)
    .where(eq(growActivities.id, foreignActivityId));
  const activityCursor = Buffer.from(
    JSON.stringify({ at: foreignActivity!.sortAt, id: foreignActivity!.id, brokerageId: B.brokerageId }),
    "utf8",
  ).toString("base64url");
  const activityPage = await getList<{ id: number }>("/grow/activities", A.admin.cookie, { cursor: activityCursor });
  assert.equal(activityPage.body.total, activities.length);
  assert.equal(collection(activityPage.body, "activities").some((row) => row.id === foreignActivityId), false);

  const foreignList = await getList<{ id: number }>("/grow/opportunities", B.admin.cookie);
  assert.equal(foreignList.body.total, 1);
  assert.deepEqual(collection(foreignList.body, "opportunities").map((row) => row.id), [foreignOpportunityId]);
});
