// AE GROW Completion Program W1-C — permanent regression coverage for the four read-scoping
// fixes on the Contact 360 / Grow Contacts path. Each of these was a query that asked Postgres
// for far more rows than the caller could ever use and then discarded the surplus in JS; the
// fixes push the discard into the SQL predicate. Nothing here changes what any endpoint
// returns, so the pre-existing suites (routes/__tests__/contacts.test.ts,
// lib/__tests__/relationshipTimeline.test.ts) are deliberately left untouched and are the
// behaviour contract these fixes must not move.
//
// What each test locks down:
//
//  I-1  lib/relationshipTimeline.ts — the property-label lookup was an unfiltered
//       `SELECT id, formatted_address FROM properties`, i.e. an instance-wide read of every
//       property row of EVERY tenant, on every Contact 360 open, to label a handful of
//       timeline entries. Now bounded by the referenced ids and the caller's brokerage.
//
//  I-3  lib/contactIntelligence.ts + lib/relationshipTimeline.ts — reads that filtered on
//       `party_id` alone and applied brokerageId in JS afterwards. Every index on these
//       tables is brokerage_id-leading, so a bare `party_id =` predicate had no usable index
//       and Postgres sequentially scanned each table in full.
//
//  I-6  routes/contacts.ts — the list endpoint computed `partyIds` for the 200 contacts it was
//       about to render and then never used it, reading every role row and every relationship
//       row in the brokerage to decorate them.
//
//  I-7  routes/contacts.ts — `.limit(200)` ran BEFORE the role filter, so `?role=` searched
//       only the 200 most recently created contacts. Correctness, not performance: past 200
//       parties, a contact holding the role silently vanished from the picker.
//
// Two independent kinds of evidence are used, because neither alone is sufficient. The
// statement observer (setDbQueryObserver, packages/db/src/index.ts — the same test-only seam
// lib/propertyIntelligence/__tests__/sweepScale.test.ts uses) proves the PREDICATES the code
// actually emits, which is size-independent. EXPLAIN proves those predicates are the ones
// Postgres can serve from an index, which a fixture-sized table could never demonstrate on
// its own — a five-row table is seq-scanned whatever the predicate says, so the plan checks
// run under `SET LOCAL enable_seqscan = off`. Under that setting Postgres still falls back to
// a sequential scan when NO index is usable, which is exactly the distinction being asserted.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, entitlementGrants, growContactRoles, parties, setDbQueryObserver } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { getRelationshipTimeline } from "../../lib/relationshipTimeline.js";
import { getContactIntelligenceSummary } from "../../lib/contactIntelligence.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
// setDbQueryObserver refuses to install outside NODE_ENV === "test" (it is an assertion seam
// that sees every statement's bind parameters). node --test already sets this; stated here so
// the file does not depend on that.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

// Brokerage A's fixture contact, its property, and the label that must survive the I-1 fix.
let aPropertyId: number;
let aPartyId: number;
const A_PROPERTY_ADDRESS = `12 Scoping Street, Testville ${suffix}`;

// Brokerage B's decoy: same shape of data, different tenant. Nothing A reads may include it,
// and — the point of I-1 — A must not even ASK Postgres for it.
let bPropertyId: number;
let bPartyId: number;

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

  A = await createBrokerageWithUsers(baseUrl, `W1C Read Scoping A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `W1C Read Scoping B ${suffix}`);
  for (const brokerageId of [A.brokerageId, B.brokerageId]) {
    for (const key of [
      "grow.access",
      "grow.contacts.read",
      "grow.contacts.manage",
      "grow.activities.manage",
      "grow.relationships.manage",
      "grow.properties.link",
      "grow.opportunities.manage",
    ]) {
      await grant(brokerageId, key);
    }
  }

  aPropertyId = await createProperty(A.agent.cookie, A_PROPERTY_ADDRESS);
  aPartyId = await createParty(A.agent.cookie, aPropertyId, {
    firstName: "Ada",
    lastName: "Scoped",
    email: uniqueEmail("ada"),
  });
  bPropertyId = await createProperty(B.agent.cookie, `99 Other Tenant Road, Testville ${suffix}`);
  bPartyId = await createParty(B.agent.cookie, bPropertyId, {
    firstName: "Bob",
    lastName: "OtherTenant",
    email: uniqueEmail("bob"),
  });

  // Give both contacts the same shape of Grow history, so every source table the Contact 360
  // path reads has rows in BOTH tenants. Without that, a query missing its brokerage predicate
  // would still return the right answer by luck and these tests would prove nothing.
  for (const [cookie, partyId, propertyId] of [
    [A.agent.cookie, aPartyId, aPropertyId],
    [B.agent.cookie, bPartyId, bPropertyId],
  ] as const) {
    await post(cookie, "/api/grow/relationships", { partyId, propertyId, relationshipType: "prospective_buyer" });
    await post(cookie, "/api/grow/activities", {
      partyId,
      propertyId,
      activityType: "call",
      summary: "Discussed the property.",
    });
    await post(cookie, "/api/grow/opportunities", {
      partyId,
      propertyId,
      opportunityType: "Appraisal",
      reason: "Asked about a market appraisal",
    });
    await post(cookie, `/api/grow/contacts/${partyId}/commitments`, {
      description: "Send the comparable sales pack.",
      dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      propertyId,
    });
    await post(cookie, `/api/grow/contacts/${partyId}/roles`, { role: "Prospect" });
  }
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

async function post(cookie: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function createProperty(cookie: string, address: string): Promise<number> {
  const { property } = (await post(cookie, "/api/properties", {
    formattedAddress: address,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  })) as { property: { id: number } };
  return property.id;
}

async function createParty(cookie: string, propertyId: number, overrides: Record<string, unknown>): Promise<number> {
  const { party } = (await post(cookie, "/api/parties", {
    propertyId,
    role: "Buyer",
    firstName: "Test",
    lastName: "Party",
    ...overrides,
  })) as { party: { id: number } };
  return party.id;
}

function uniqueEmail(label: string): string {
  return `${label}-${suffix}@example.com`;
}

/** Captures every statement drizzle issues while `run` executes. */
async function captureStatements<T>(run: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
  const statements: string[] = [];
  const uninstall = setDbQueryObserver((query) => statements.push(query));
  try {
    const result = await run();
    return { result, statements };
  } finally {
    uninstall();
  }
}

/** Every captured SELECT that reads `table`, normalised to lower case for matching. */
function selectsFrom(statements: string[], table: string): string[] {
  return statements
    .map((s) => s.toLowerCase())
    .filter((s) => s.startsWith("select") && s.includes(`from "${table}"`));
}

// ---------------------------------------------------------------------------------------------
// I-1 + I-3 — the Contact 360 aggregation path.
// ---------------------------------------------------------------------------------------------

test("I-1/I-3: the Contact 360 read path never issues an unbounded `properties` read and never filters a brokerage-scoped Grow table on party_id alone", async () => {
  const { result, statements } = await captureStatements(async () => ({
    timeline: await getRelationshipTimeline(A.brokerageId, aPartyId, 100),
    intelligence: await getContactIntelligenceSummary(A.brokerageId, aPartyId),
  }));

  // I-1. The label lookup must name the ids it wants. An unfiltered read of this table is an
  // instance-wide, cross-tenant scan: `properties` holds every tenant's rows on the instance.
  const propertyReads = selectsFrom(statements, "properties");
  assert.ok(propertyReads.length > 0, "the timeline must still look property labels up");
  for (const stmt of propertyReads) {
    assert.ok(
      stmt.includes(`"properties"."id" in (`),
      `every read of "properties" must be bounded by the ids it actually needs, got: ${stmt}`,
    );
    assert.ok(
      stmt.includes(`"properties"."brokerage_id" =`),
      `every read of "properties" must be tenant-scoped, got: ${stmt}`,
    );
  }

  // I-3. Each of these tables is indexed brokerage_id-first, so the brokerage column has to be
  // in the predicate for the lookup to be an index scan rather than a full table scan.
  for (const table of ["grow_relationships", "grow_activities", "grow_opportunities", "grow_commitments", "grow_contact_roles"]) {
    const reads = selectsFrom(statements, table);
    assert.ok(reads.length > 0, `the Contact 360 path must still read ${table}`);
    for (const stmt of reads) {
      assert.ok(
        stmt.includes(`"${table}"."brokerage_id" =`),
        `every read of ${table} on the Contact 360 path must carry a brokerage_id predicate, got: ${stmt}`,
      );
    }
  }

  // `appraisals` is the deliberate exception and is NOT asserted above: it carries no
  // brokerage_id column at all (packages/db/src/schema/appraisal.ts) and is tenant-scoped
  // transitively through propertyId -> properties.brokerageId, so there is no brokerage column
  // to push into its predicate. Its lookup stays keyed on partyId and still needs an
  // appraisals(party_id) index, which belongs to Wave 1's single batched migration.

  // Behaviour contract: the label the unbounded scan used to produce is still produced.
  const labelled = result.timeline.filter((e) => e.propertyId === aPropertyId);
  assert.ok(labelled.length > 0, "the fixture contact must have property-anchored timeline events");
  for (const event of labelled) {
    assert.equal(event.propertyLabel, A_PROPERTY_ADDRESS, "property labels must still resolve after the id filter");
  }
  assert.equal(result.intelligence.relatedPropertyCount, 1);
  assert.deepEqual(result.intelligence.roles, ["Prospect"]);
  assert.equal(result.intelligence.outstandingCommitmentCount, 1);
  assert.equal(result.intelligence.activeOpportunityCount, 1);
});

test("I-1/I-3: the other tenant's identically-shaped data changes nothing about brokerage A's Contact 360 result", async () => {
  // The JS filters these fixes replace were already correct, so this is the no-behaviour-change
  // check: A's aggregation is computed with B's rows present in every source table and must be
  // byte-identical to B's own, modulo ids and the address label.
  const aTimeline = await getRelationshipTimeline(A.brokerageId, aPartyId, 100);
  const bTimeline = await getRelationshipTimeline(B.brokerageId, bPartyId, 100);
  assert.deepEqual(
    aTimeline.map((e) => e.type).sort(),
    bTimeline.map((e) => e.type).sort(),
    "both tenants' contacts have the same fixture history, so they must produce the same event types",
  );
  for (const event of aTimeline) {
    assert.notEqual(event.propertyId, bPropertyId, "brokerage A's timeline must never reference brokerage B's property");
  }

  // And the cross-tenant guard still refuses outright.
  assert.deepEqual(await getRelationshipTimeline(A.brokerageId, bPartyId, 100), []);
  const crossTenant = await getContactIntelligenceSummary(A.brokerageId, bPartyId);
  assert.deepEqual(crossTenant.roles, []);
  assert.equal(crossTenant.relatedPropertyCount, 0);
  assert.equal(crossTenant.activeOpportunityCount, 0);
  assert.equal(crossTenant.outstandingCommitmentCount, 0);
});

test("I-1/I-3: EXPLAIN confirms the new predicates constrain the leading index column and the ones they replaced did not", async () => {
  // What is asserted here is PLAN SHAPE, not timing, because plan shape is the part that holds
  // at any table size — a fixture-sized table is cheap to read however you read it.
  //
  // The property that matters is whether the predicate constrains the LEADING column of the
  // index. Every index on these tables leads with brokerage_id, so:
  //
  //   `WHERE party_id = X`                        -> brokerage_id unconstrained. Postgres must
  //                                                  examine every entry in the index (or every
  //                                                  row in the heap); party_id appears as a
  //                                                  non-leading Index Cond or as a Filter.
  //                                                  Work grows with the INSTANCE's row count.
  //   `WHERE brokerage_id = B AND party_id = X`   -> a bounded seek into one tenant's slice.
  //                                                  Work grows with the TENANT's row count.
  //
  // Measured on this schema with 250,000 grow_activities rows across 40 brokerages: the bare
  // predicate plans at cost 3568.85 / 379 shared buffers, the scoped one at cost 11.86 / 80
  // shared buffers — a ~300x planner cost reduction for an identical result set. Building that
  // fixture inside this test would cost minutes for no extra signal, so the shape check below
  // is what runs and the scale figure is recorded here.
  await db.transaction(async (tx) => {
    const plan = async (query: string): Promise<string> => {
      const res = await tx.execute(sql.raw(`EXPLAIN ${query}`));
      return (res.rows as Array<Record<string, unknown>>).map((r) => String(r["QUERY PLAN"])).join("\n");
    };
    /** The columns Postgres reports as Index Cond, i.e. the ones it can actually seek on. */
    const indexCond = (plan: string): string => (plan.match(/Index Cond: (.*)/) ?? ["", ""])[1];

    // I-1. The label lookup this fix removed had no WHERE clause at all. No index can serve
    // "every row", so it is a full scan of `properties` — which holds every tenant's rows on
    // the instance — by definition, at 50 rows or 50,000.
    const unboundedProperties = await plan(`SELECT id, formatted_address FROM properties`);
    assert.match(
      unboundedProperties,
      /Seq Scan on properties/,
      `a predicate-free read of properties is unavoidably an instance-wide scan:\n${unboundedProperties}`,
    );
    await tx.execute(sql.raw("SET LOCAL enable_seqscan = off"));
    const boundedProperties = await plan(
      `SELECT id, formatted_address FROM properties WHERE id IN (${aPropertyId}) AND brokerage_id = ${A.brokerageId}`,
    );
    assert.match(
      boundedProperties,
      /Index Scan|Bitmap Index Scan|Index Only Scan/,
      `the bounded lookup must be servable from properties_pkey:\n${boundedProperties}`,
    );

    // I-3, part 1 — the structural claim, read straight from pg_indexes. This is the part that
    // is genuinely invariant: it is a fact about the schema, independent of table size, row
    // distribution and planner cost estimates. WHICH index Postgres picks among several equally
    // tenant-bounding ones is a cost decision that shifts as a table grows (grow_activities
    // alone has three), so no index NAME is asserted anywhere in this test.
    const leadingColumnsByTable = new Map<string, Set<string>>();
    const indexRows = await tx.execute(
      sql.raw(
        `SELECT tablename, indexdef FROM pg_indexes
         WHERE tablename IN ('grow_relationships','grow_activities','grow_opportunities','grow_commitments','grow_contact_roles')`,
      ),
    );
    for (const row of indexRows.rows as Array<Record<string, unknown>>) {
      const table = String(row.tablename);
      // The first column inside the index definition's parenthesised column list.
      const leading = String(row.indexdef).match(/\(([^,)]+)/)?.[1]?.trim();
      if (!leading) continue;
      if (!leadingColumnsByTable.has(table)) leadingColumnsByTable.set(table, new Set());
      leadingColumnsByTable.get(table)!.add(leading);
    }

    for (const table of ["grow_relationships", "grow_activities", "grow_opportunities", "grow_commitments"]) {
      const leading = leadingColumnsByTable.get(table) ?? new Set<string>();
      assert.ok(
        !leading.has("party_id"),
        `precondition: no index on ${table} leads with party_id, which is why the predicate this fix replaced could not seek. Leading columns present: ${[...leading].join(", ")}`,
      );
      assert.ok(
        leading.has("brokerage_id"),
        `${table} must have a brokerage_id-leading index for the new predicate to seek on. Leading columns present: ${[...leading].join(", ")}`,
      );
    }

    // grow_contact_roles is deliberately excluded from the loop above and asserted separately:
    // it DOES carry a party_id-leading index (the (party_id, role) unique), so its party_id-only
    // lookup was never one of the unbounded scans. Adding brokerage_id to it is a consistency
    // and defence-in-depth change, not a plan fix — asserted here so that distinction survives.
    assert.ok(
      (leadingColumnsByTable.get("grow_contact_roles") ?? new Set()).has("party_id"),
      "grow_contact_roles is expected to have a party_id-leading index; if that changed, its query is now an unbounded scan too and belongs in the loop above",
    );

    // I-3, part 2 — the same claim observed in real plans. Asserted on Index Cond only: whether
    // brokerage_id, the leading column, made it into the seek condition at all.
    for (const table of ["grow_relationships", "grow_activities", "grow_opportunities", "grow_commitments"]) {
      const bare = await plan(`SELECT * FROM ${table} WHERE party_id = ${aPartyId}`);
      assert.ok(
        !indexCond(bare).includes("brokerage_id"),
        `${table}: the predicate this fix replaced cannot bound the scan to a tenant:\n${bare}`,
      );

      const scoped = await plan(`SELECT * FROM ${table} WHERE brokerage_id = ${A.brokerageId} AND party_id = ${aPartyId}`);
      assert.ok(
        indexCond(scoped).includes("brokerage_id"),
        `${table}'s scan must be bounded to the caller's tenant by the index, not merely filtered after reading every row:\n${scoped}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// I-6 + I-7 — GET /grow/contacts.
// ---------------------------------------------------------------------------------------------

test("I-6: the contacts list enriches only the contacts it renders, instead of reading every role and relationship row in the brokerage", async () => {
  const { statements } = await captureStatements(async () => {
    const res = await fetch(`${baseUrl}/api/grow/contacts`, { headers: { cookie: A.agent.cookie } });
    assert.equal(res.status, 200);
    return res.json();
  });

  for (const table of ["grow_contact_roles", "grow_relationships"]) {
    const reads = selectsFrom(statements, table);
    assert.ok(reads.length > 0, `the list endpoint must still enrich from ${table}`);
    for (const stmt of reads) {
      assert.ok(
        stmt.includes(`"${table}"."party_id" in (`),
        `${table} enrichment must be bounded by the rendered party ids, got: ${stmt}`,
      );
      assert.ok(
        stmt.includes(`"${table}"."brokerage_id" =`),
        `${table} enrichment must stay tenant-scoped, got: ${stmt}`,
      );
    }
  }
});

test("I-6: enrichment values are unchanged — roles and related-property counts still land on the right contacts", async () => {
  const res = await fetch(`${baseUrl}/api/grow/contacts`, { headers: { cookie: A.agent.cookie } });
  assert.equal(res.status, 200);
  const { contacts } = (await res.json()) as {
    contacts: Array<{ id: number; roles: string[]; relatedPropertyCount: number }>;
  };
  const ada = contacts.find((c) => c.id === aPartyId);
  assert.ok(ada, "the fixture contact must appear in its own brokerage's list");
  assert.deepEqual(ada.roles, ["Prospect"]);
  assert.equal(ada.relatedPropertyCount, 1);
  assert.ok(
    !contacts.some((c) => c.id === bPartyId),
    "the other tenant's contact must not appear",
  );
});

test("I-7: a role filter finds a matching contact that is not among the 200 most recently created parties", async () => {
  // The bug: `.limit(200)` ran before the role filter, so `?role=` only ever searched the
  // newest 200 contacts. Once a brokerage held more than 200 parties, a contact holding the
  // role just stopped being returned — no error, no indication anything had been cut.
  //
  // `parties` rows are inserted directly rather than through POST /api/parties: 210 HTTP
  // round-trips (each with its own property linkage and ownership side effects) would take
  // minutes and prove nothing extra. createdAt is set explicitly so the ordering this test
  // depends on cannot come down to insert timing.
  const now = Date.now();
  const [buried] = await db
    .insert(parties)
    .values({
      brokerageId: A.brokerageId,
      partyType: "Person",
      firstName: "Buried",
      lastName: "Landlord",
      email: uniqueEmail("buried"),
      // A year old: guaranteed to sort last under `order by created_at desc`.
      createdAt: new Date(now - 365 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(now - 365 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: parties.id });

  await db.insert(growContactRoles).values({
    brokerageId: A.brokerageId,
    partyId: buried.id,
    role: "Landlord",
  });

  // 210 newer parties, none of them a Landlord: more than the 200-row window, so the buried
  // contact is pushed out of it entirely.
  const fillerIds = await db
    .insert(parties)
    .values(
      Array.from({ length: 210 }, (_, i) => ({
        brokerageId: A.brokerageId,
        partyType: "Person" as const,
        firstName: "Filler",
        lastName: `Contact${i}`,
        email: `filler-${i}-${suffix}@example.com`,
        createdAt: new Date(now - (210 - i) * 1000),
        updatedAt: new Date(now - (210 - i) * 1000),
      })),
    )
    .returning({ id: parties.id });

  try {
    // Precondition: the buried contact really is outside the unfiltered 200-row window, so the
    // test would have failed before the fix rather than passing for an unrelated reason.
    const unfiltered = await fetch(`${baseUrl}/api/grow/contacts`, { headers: { cookie: A.agent.cookie } });
    assert.equal(unfiltered.status, 200);
    const { contacts: page } = (await unfiltered.json()) as { contacts: Array<{ id: number }> };
    assert.equal(page.length, 200, "the unfiltered list is capped at 200");
    assert.ok(
      !page.some((c) => c.id === buried.id),
      "precondition: the buried contact must fall outside the newest 200, otherwise this test proves nothing",
    );

    const res = await fetch(`${baseUrl}/api/grow/contacts?role=Landlord`, { headers: { cookie: A.agent.cookie } });
    assert.equal(res.status, 200);
    const { contacts } = (await res.json()) as { contacts: Array<{ id: number; roles: string[] }> };
    assert.deepEqual(
      contacts.map((c) => c.id),
      [buried.id],
      "the role filter must search the whole brokerage, not just the newest 200 parties",
    );
    assert.deepEqual(contacts[0].roles, ["Landlord"]);

    // The role filter still composes with search, and still excludes non-matching roles.
    const searched = await fetch(`${baseUrl}/api/grow/contacts?role=Landlord&search=Buried`, {
      headers: { cookie: A.agent.cookie },
    });
    assert.equal(searched.status, 200);
    const { contacts: searchedContacts } = (await searched.json()) as { contacts: Array<{ id: number }> };
    assert.deepEqual(searchedContacts.map((c) => c.id), [buried.id]);

    const mismatched = await fetch(`${baseUrl}/api/grow/contacts?role=Landlord&search=Filler`, {
      headers: { cookie: A.agent.cookie },
    });
    assert.equal(mismatched.status, 200);
    const { contacts: mismatchedContacts } = (await mismatched.json()) as { contacts: Array<{ id: number }> };
    assert.deepEqual(mismatchedContacts, [], "a role filter must not return contacts that do not hold the role");

    // Tenant isolation is unaffected by moving the filter into SQL.
    const otherTenant = await fetch(`${baseUrl}/api/grow/contacts?role=Landlord`, { headers: { cookie: B.agent.cookie } });
    assert.equal(otherTenant.status, 200);
    const { contacts: bContacts } = (await otherTenant.json()) as { contacts: Array<{ id: number }> };
    assert.deepEqual(bContacts, [], "brokerage B holds no Landlord and must not see brokerage A's");
  } finally {
    await db.delete(growContactRoles).where(and(eq(growContactRoles.partyId, buried.id), eq(growContactRoles.role, "Landlord")));
    await db.delete(parties).where(inArray(parties.id, [buried.id, ...fillerIds.map((r) => r.id)]));
  }
});
