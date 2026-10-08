// C-5a — opportunity type filter on GET /grow/opportunities.
//
// Seller-side is Listing and Appraisal. Property Management is its own group.
// Other is anything else, including the stored value Other and unknown strings
// such as General. The filter is applied in SQL with the keyset cursor, the
// exact count, and search, and it never widens brokerage scope.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { db, entitlementGrants, growOpportunities, parties } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

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

type Opp = { id: number; opportunityType: string; reason: string | null; brokerageId: number };
type SeedKey =
  | "listingOld"
  | "appraisalTieLow"
  | "listingTieHigh"
  | "appraisalNew"
  | "pm"
  | "other"
  | "general"
  | "listingNeedleNew"
  | "foreignListing"
  | "foreignPm"
  | "foreignGeneral";

const ids: Partial<Record<SeedKey, number>> = {};

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

  A = await createBrokerageWithUsers(baseUrl, `C5a Type A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `C5a Type B ${suffix}`);
  for (const brokerageId of [A.brokerageId, B.brokerageId]) {
    await db.insert(entitlementGrants).values({
      brokerageId,
      entitlementKey: "grow.access",
      granteeType: "brokerage",
      granteeId: brokerageId,
      sourceType: "manual",
      status: "Active",
    });
    invalidateEntitlementCache(brokerageId);
  }

  const [partyA] = await db
    .insert(parties)
    .values({ brokerageId: A.brokerageId, partyType: "Person", firstName: "Ada", lastName: `Type${suffix}` })
    .returning({ id: parties.id });
  const [partyB] = await db
    .insert(parties)
    .values({ brokerageId: B.brokerageId, partyType: "Person", firstName: "Bea", lastName: `Type${suffix}` })
    .returning({ id: parties.id });

  const at = (iso: string) => new Date(iso);
  const seeds: Array<{ key: SeedKey; type: string; reason: string; at: string; brokerage: "A" | "B" }> = [
    { key: "listingOld", type: "Listing", reason: "Alpha filter needle listing", at: "2024-04-01T00:00:00.000Z", brokerage: "A" },
    { key: "appraisalTieLow", type: "Appraisal", reason: "Beta appraisal only", at: "2024-04-02T00:00:00.000Z", brokerage: "A" },
    { key: "listingTieHigh", type: "Listing", reason: "Tie listing", at: "2024-04-02T00:00:00.000Z", brokerage: "A" },
    { key: "appraisalNew", type: "Appraisal", reason: "Newest appraisal", at: "2024-04-03T00:00:00.000Z", brokerage: "A" },
    { key: "pm", type: "PropertyManagement", reason: "Alpha filter needle pm", at: "2024-04-03T00:00:00.000Z", brokerage: "A" },
    { key: "other", type: "Other", reason: "Alpha filter needle other", at: "2024-04-04T00:00:00.000Z", brokerage: "A" },
    { key: "general", type: "General", reason: "Unclassified general", at: "2024-04-05T00:00:00.000Z", brokerage: "A" },
    { key: "listingNeedleNew", type: "Listing", reason: "Alpha filter needle second", at: "2024-04-06T00:00:00.000Z", brokerage: "A" },
    { key: "foreignListing", type: "Listing", reason: "Alpha filter needle listing", at: "2099-01-01T00:00:00.000Z", brokerage: "B" },
    { key: "foreignPm", type: "PropertyManagement", reason: "Alpha filter needle pm", at: "2099-02-01T00:00:00.000Z", brokerage: "B" },
    { key: "foreignGeneral", type: "General", reason: "Unclassified general", at: "2099-03-01T00:00:00.000Z", brokerage: "B" },
  ];
  for (const seed of seeds) {
    const brokerage = seed.brokerage === "A" ? A : B;
    const [row] = await db
      .insert(growOpportunities)
      .values({
        brokerageId: brokerage.brokerageId,
        partyId: seed.brokerage === "A" ? partyA!.id : partyB!.id,
        opportunityType: seed.type,
        status: "Open",
        reason: seed.reason,
        ownerUserId: brokerage.admin.user.id,
        createdAt: at(seed.at),
        updatedAt: at(seed.at),
      })
      .returning({ id: growOpportunities.id });
    ids[seed.key] = row!.id;
  }
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

function id(key: SeedKey): number {
  const value = ids[key];
  if (value === undefined) throw new Error(`missing seed ${key}`);
  return value;
}

type ListBody = {
  opportunities?: Opp[];
  nextCursor: string | null;
  total: number;
  limit: number;
  error?: string;
};

async function getOpportunities(
  cookie: string,
  params: Record<string, string | undefined> = {},
): Promise<{ status: number; body: ListBody }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  const suffixQuery = query.size > 0 ? `?${query}` : "";
  const res = await fetch(`${baseUrl}/api/grow/opportunities${suffixQuery}`, { headers: { cookie } });
  const body = (await res.json()) as ListBody;
  return { status: res.status, body };
}

function rows(body: ListBody): Opp[] {
  return body.opportunities ?? [];
}

async function walk(cookie: string, params: Record<string, string>, limit: number): Promise<{ ids: number[]; total: number }> {
  const found: number[] = [];
  let cursor: string | undefined;
  let total = -1;
  let pages = 0;
  do {
    const { status, body } = await getOpportunities(cookie, { ...params, limit: String(limit), cursor });
    assert.equal(status, 200, JSON.stringify(body));
    if (total === -1) total = body.total;
    else assert.equal(body.total, total, "the exact count does not change as the cursor moves");
    const page = rows(body);
    if (body.nextCursor) assert.equal(page.length, limit);
    else assert.ok(page.length <= limit);
    found.push(...page.map((row) => row.id));
    for (const row of page) assert.equal(row.brokerageId, A.brokerageId);
    cursor = body.nextCursor ?? undefined;
    pages += 1;
    assert.ok(pages < 20, "pagination did not terminate");
  } while (cursor);
  assert.equal(new Set(found).size, found.length, "a later page repeated an earlier row");
  return { ids: found, total };
}

const sellerOrder = () => [id("listingNeedleNew"), id("appraisalNew"), id("listingTieHigh"), id("appraisalTieLow"), id("listingOld")];
const otherOrder = () => [id("general"), id("other")];
const allOrder = () => [
  id("listingNeedleNew"),
  id("general"),
  id("other"),
  id("pm"),
  id("appraisalNew"),
  id("listingTieHigh"),
  id("appraisalTieLow"),
  id("listingOld"),
];
const foreignIds = () => [id("foreignListing"), id("foreignPm"), id("foreignGeneral")];

function assertNoForeign(page: Opp[]) {
  const foreign = new Set(foreignIds());
  assert.equal(page.some((row) => foreign.has(row.id) || row.brokerageId !== A.brokerageId), false);
}

test("omitting type and type=all return the same unfiltered page", async () => {
  const omitted = await getOpportunities(A.admin.cookie);
  const all = await getOpportunities(A.admin.cookie, { type: "all" });
  assert.equal(omitted.status, 200);
  assert.equal(all.status, 200);
  assert.equal(omitted.body.total, allOrder().length);
  assert.deepEqual(rows(omitted.body).map((row) => row.id), allOrder());
  assert.deepEqual(rows(all.body).map((row) => row.id), allOrder());
  assert.deepEqual(omitted.body.total, all.body.total);
  assertNoForeign(rows(omitted.body));
  assert.equal(rows(omitted.body).some((row) => row.opportunityType === "PropertyManagement"), true);
  assert.equal(rows(omitted.body).some((row) => row.opportunityType === "General"), true);
  assert.equal(rows(omitted.body).some((row) => row.opportunityType === "Other"), true);
});

test("each type filter returns only its group and an exact total", async () => {
  const seller = await getOpportunities(A.admin.cookie, { type: "seller_side" });
  assert.equal(seller.status, 200);
  assert.equal(seller.body.total, sellerOrder().length);
  assert.deepEqual(rows(seller.body).map((row) => row.id), sellerOrder());
  assert.deepEqual(
    [...new Set(rows(seller.body).map((row) => row.opportunityType))].sort(),
    ["Appraisal", "Listing"],
  );
  assertNoForeign(rows(seller.body));

  const managed = await getOpportunities(A.admin.cookie, { type: "property_management" });
  assert.equal(managed.body.total, 1);
  assert.deepEqual(rows(managed.body).map((row) => row.id), [id("pm")]);
  assert.equal(rows(managed.body)[0]?.opportunityType, "PropertyManagement");
  assertNoForeign(rows(managed.body));

  const other = await getOpportunities(A.admin.cookie, { type: "other" });
  assert.equal(other.body.total, otherOrder().length);
  assert.deepEqual(rows(other.body).map((row) => row.id), otherOrder());
  assert.deepEqual(
    rows(other.body).map((row) => row.opportunityType),
    ["General", "Other"],
  );
  assertNoForeign(rows(other.body));
});

test("cursor continuity holds under a type filter, including with search", async () => {
  const seller = await walk(A.admin.cookie, { type: "seller_side" }, 1);
  assert.deepEqual(seller.ids, sellerOrder());
  assert.equal(seller.total, sellerOrder().length);

  const searched = await walk(A.admin.cookie, { type: "seller_side", search: "Alpha filter needle" }, 1);
  assert.deepEqual(searched.ids, [id("listingNeedleNew"), id("listingOld")]);
  assert.equal(searched.total, 2);
});

test("search and type compose, and a foreign match stays out of the count", async () => {
  const seller = await getOpportunities(A.admin.cookie, { type: "seller_side", search: "Alpha filter needle" });
  assert.equal(seller.body.total, 2);
  assert.deepEqual(rows(seller.body).map((row) => row.id), [id("listingNeedleNew"), id("listingOld")]);

  const managed = await getOpportunities(A.admin.cookie, { type: "property_management", search: "Alpha filter needle" });
  assert.equal(managed.body.total, 1);
  assert.deepEqual(rows(managed.body).map((row) => row.id), [id("pm")]);

  const other = await getOpportunities(A.admin.cookie, { type: "other", search: "Alpha filter needle" });
  assert.equal(other.body.total, 1);
  assert.deepEqual(rows(other.body).map((row) => row.id), [id("other")]);

  const all = await getOpportunities(A.admin.cookie, { search: "Alpha filter needle" });
  assert.equal(all.body.total, 4);
  assert.deepEqual(rows(all.body).map((row) => row.id), [id("listingNeedleNew"), id("other"), id("pm"), id("listingOld")]);

  const betaSeller = await getOpportunities(A.admin.cookie, { type: "seller_side", search: "Beta" });
  assert.equal(betaSeller.body.total, 1);
  assert.deepEqual(rows(betaSeller.body).map((row) => row.id), [id("appraisalTieLow")]);
  const betaManaged = await getOpportunities(A.admin.cookie, { type: "property_management", search: "Beta" });
  assert.equal(betaManaged.body.total, 0);
  assert.deepEqual(rows(betaManaged.body), []);

  const unclassified = await getOpportunities(A.admin.cookie, { type: "other", search: "Unclassified" });
  assert.equal(unclassified.body.total, 1);
  assert.deepEqual(rows(unclassified.body).map((row) => row.id), [id("general")]);

  const byId = await getOpportunities(A.admin.cookie, { type: "seller_side", id: String(id("pm")) });
  assert.equal(byId.body.total, 0);
  assert.deepEqual(rows(byId.body), []);
  const pmById = await getOpportunities(A.admin.cookie, { type: "property_management", id: String(id("pm")) });
  assert.equal(pmById.body.total, 1);
  assert.deepEqual(rows(pmById.body).map((row) => row.id), [id("pm")]);
});

test("a crafted cursor cannot pull another brokerage into a filtered page or its count", async () => {
  // Newer than every fixture, including brokerage B's 2099 rows. The keyset
  // keeps rows older than the cursor, so a missing brokerage predicate would
  // put B's rows on this page. The count ignores the cursor entirely.
  const crafted = Buffer.from(
    JSON.stringify({ at: "2100-01-01 00:00:00.000000", id: 2_147_483_647, brokerageId: B.brokerageId }),
    "utf8",
  ).toString("base64url");
  const decoded = JSON.parse(Buffer.from(crafted, "base64url").toString("utf8")) as { brokerageId?: number };
  assert.equal(decoded.brokerageId, B.brokerageId);

  const seller = await getOpportunities(A.admin.cookie, { type: "seller_side", cursor: crafted, limit: "50" });
  assert.equal(seller.status, 200);
  assert.equal(seller.body.total, sellerOrder().length);
  assert.deepEqual(rows(seller.body).map((row) => row.id), sellerOrder());
  assertNoForeign(rows(seller.body));

  const managed = await getOpportunities(A.admin.cookie, { type: "property_management", cursor: crafted });
  assert.equal(managed.body.total, 1);
  assert.deepEqual(rows(managed.body).map((row) => row.id), [id("pm")]);
  assertNoForeign(rows(managed.body));

  const other = await getOpportunities(A.admin.cookie, { type: "other", cursor: crafted });
  assert.equal(other.body.total, otherOrder().length);
  assert.deepEqual(rows(other.body).map((row) => row.id), otherOrder());
  assertNoForeign(rows(other.body));

  const unfiltered = await getOpportunities(A.admin.cookie, { cursor: crafted, limit: "50" });
  assert.equal(unfiltered.body.total, allOrder().length);
  assert.deepEqual(rows(unfiltered.body).map((row) => row.id), allOrder());
  assertNoForeign(rows(unfiltered.body));

  const foreignById = await getOpportunities(A.admin.cookie, { type: "seller_side", id: String(id("foreignListing")) });
  assert.equal(foreignById.body.total, 0);
  assert.deepEqual(rows(foreignById.body), []);

  const fromB = await getOpportunities(B.admin.cookie, { type: "seller_side" });
  assert.equal(fromB.body.total, 1);
  assert.deepEqual(rows(fromB.body).map((row) => row.id), [id("foreignListing")]);
  const fromBOther = await getOpportunities(B.admin.cookie, { type: "other" });
  assert.equal(fromBOther.body.total, 1);
  assert.deepEqual(rows(fromBOther.body).map((row) => row.id), [id("foreignGeneral")]);
});

test("an invalid type is rejected and does not change the default", async () => {
  for (const type of ["Listing", "Appraisal", "PropertyManagement", "Other", "seller", "SELLER_SIDE", ""]) {
    const rejected = await getOpportunities(A.admin.cookie, { type });
    assert.equal(rejected.status, 400, type);
    assert.equal(rejected.body.error, "type must be one of all, seller_side, property_management, other");
  }
  const repeated = await fetch(`${baseUrl}/api/grow/opportunities?type=seller_side&type=all`, {
    headers: { cookie: A.admin.cookie },
  });
  const repeatedBody = (await repeated.json()) as ListBody;
  assert.equal(repeated.status, 400);
  assert.equal(repeatedBody.error, "type must be one of all, seller_side, property_management, other");

  const stillAll = await getOpportunities(A.admin.cookie);
  assert.equal(stillAll.status, 200);
  assert.equal(stillAll.body.total, allOrder().length);
});
