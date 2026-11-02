// t228u Priority 3: Owner/Landlord/Tenant roles; the PROPOSED (unapplied)
// 0047 unique index and 0048 role CHECK, exercised only inside a rolled-back
// transaction on this throwaway test DB; the read-only audit and
// grow_relationships reconciliation dry-run. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db, pool, entitlementGrants, growRelationships, propertyParties, ENTITLEMENT_KEYS } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages } from "./testSupport.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const statements = (sql: string, sep: RegExp) =>
  sql.split(sep).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
const AUDIT = statements(read("packages/db/scripts/audit/property-parties-audit.sql"), /;\s*$/m);
const RECON = statements(read("packages/db/scripts/audit/grow-relationships-reconciliation.sql"), /;\s*$/m);
const M0047 = statements(read("docs/migrations/proposed/0047_property_parties_unique_role.sql"), /--> statement-breakpoint/);
const M0048 = statements(read("docs/migrations/proposed/0048_property_parties_role_check.sql"), /--> statement-breakpoint/);
const M0049 = statements(read("docs/migrations/proposed/0049_property_parties_one_primary_per_role.sql"), /--> statement-breakpoint/);
const ENV_COUNTS = read("packages/db/scripts/audit/property-parties-env-counts.sql").replace(/^\s*--.*$/gm, "").trim().replace(/;\s*$/, "");

const tag = `ppint-${Date.now()}`;
let server: Server;
let base = "";
const ids: number[] = [];
before(async () => {
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  try {
    await cleanupBrokerages(ids);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
async function call(cookie: string, method: string, p: string, body?: unknown) {
  const r = await fetch(`${base}/api${p}`, { method, headers: { cookie, connection: "close", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch { /* */ }
  return { status: r.status, json: j };
}
async function brokerage(label: string) {
  const b = await createBrokerageWithUsers(base, `${tag} ${label}`);
  ids.push(b.brokerageId);
  await db.delete(entitlementGrants).where(eq(entitlementGrants.brokerageId, b.brokerageId));
  for (const k of ENTITLEMENT_KEYS) await db.insert(entitlementGrants).values({ brokerageId: b.brokerageId, entitlementKey: k, granteeType: "brokerage", granteeId: b.brokerageId, sourceType: "admin_override", status: "Active" });
  invalidateEntitlementCache(b.brokerageId);
  const prop = async (n: string) => (await call(b.admin.cookie, "POST", "/properties", { formattedAddress: `${n} ${tag} ${label} St, Testville`, state: "NSW", suburb: "Testville", postcode: "2000" })).json.property.id as number;
  const party = async (n: string) => (await call(b.admin.cookie, "POST", "/grow/contacts", { name: `${n} Synthetic`, email: `${n.toLowerCase()}-${label.toLowerCase()}-${tag}@example.com` })).json.contact.id as number;
  return { ...b, prop, party };
}

test("Owner, Landlord and Tenant link through the API; unknown roles stay 400", async () => {
  const b = await brokerage("Roles");
  const p = await b.prop("1");
  const c = await b.party("Rory");
  for (const role of ["Owner", "Landlord", "Tenant"]) {
    const r = await call(b.admin.cookie, "POST", "/parties", { propertyId: p, partyId: c, role });
    assert.equal(r.status, 201, role);
    assert.equal(r.json.link.role, role);
  }
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: p, partyId: c, role: "Owner" })).status, 409);
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: p, partyId: c, role: "Occupier" })).status, 400);
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: p, role: "Tenant", firstName: "Tess" })).status, 201, "create-and-link accepts new roles");
  const roles = (await call(b.admin.cookie, "GET", `/parties/by-property/${p}`)).json.parties.map((x: any) => x.role).sort();
  assert.deepEqual(roles, ["Landlord", "Owner", "Tenant", "Tenant"]);
});

async function promotedConstraintsApplied(): Promise<boolean> {
  const r = await pool.query("select count(*)::int as n from pg_indexes where schemaname = 'public' and tablename = 'property_parties' and indexdef ilike 'create unique index%'");
  return Number(r.rows[0].n) >= 2;
}

test("proposed 0047 fails closed on duplicates, then enforces uniqueness; 0048 CHECK; all rolled back", async () => {
  const b = await brokerage("Mig");
  const p = await b.prop("1");
  const c = await b.party("Dup");
  // testing/r1: 0048/0049 are promoted to real migrations here, so the proposal is already enforced on this DB.
  if (await promotedConstraintsApplied()) {
    await assert.rejects(db.insert(propertyParties).values([{ propertyId: p, partyId: c, role: "Buyer" }, { propertyId: p, partyId: c, role: "Buyer" }]), "promoted migration enforces it");
    return;
  }
  await db.insert(propertyParties).values([{ propertyId: p, partyId: c, role: "Buyer" }, { propertyId: p, partyId: c, role: "Buyer" }]);

  const client = await pool.connect();
  try {
    // Audit sees the synthetic duplicate group (ids only).
    await client.query("BEGIN READ ONLY");
    const d1 = await client.query(AUDIT[0]);
    const mine = d1.rows.filter((r) => r.property_id === p);
    assert.equal(mine.length, 1);
    assert.equal(Number(mine[0].links), 2);
    for (const s of AUDIT.slice(1)) await client.query(s);
    await client.query("ROLLBACK");

    // The proposed DDL runs against a session-temporary copy (pg_temp is first
    // on search_path for relations, so the unqualified "property_parties" in
    // the migration text resolves to it). public.property_parties is never
    // locked or altered, so concurrent test files are unaffected.
    const shadow = async () => {
      await client.query("CREATE TEMP TABLE property_parties (LIKE public.property_parties INCLUDING DEFAULTS) ON COMMIT DROP");
      await client.query("INSERT INTO property_parties SELECT * FROM public.property_parties WHERE property_id = $1", [p]);
    };
    // 0047 refuses while the duplicate exists and changes nothing.
    await client.query("BEGIN");
    await shadow();
    await assert.rejects(client.query(M0047[0]), /duplicate \(property_id, party_id, role\)/);
    await client.query("ROLLBACK");

    // Resolve only this synthetic duplicate inside the transaction, then apply.
    await client.query("BEGIN");
    await shadow();
    await client.query("DELETE FROM property_parties WHERE id = (SELECT max(id) FROM property_parties WHERE property_id = $1 AND party_id = $2 AND role = 'Buyer')", [p, c]);
    const dupGroups = await client.query("SELECT count(*)::int AS n FROM (SELECT 1 FROM property_parties GROUP BY property_id, party_id, role HAVING count(*) > 1) d");
    assert.equal(dupGroups.rows[0].n, 0);
    {
      for (const s of M0047) await client.query(s);
      await client.query("SAVEPOINT s1");
      await assert.rejects(client.query("INSERT INTO property_parties (property_id, party_id, role) VALUES ($1, $2, 'Buyer')", [p, c]), /property_parties_property_party_role_unique/);
      await client.query("ROLLBACK TO SAVEPOINT s1");
      await client.query("INSERT INTO property_parties (property_id, party_id, role) VALUES ($1, $2, 'Owner')", [p, c]);
    }
    const unknown = await client.query("SELECT count(*)::int AS n FROM property_parties WHERE role NOT IN ('Seller','Buyer','Solicitor','PowerOfAttorney','Owner','Landlord','Tenant','Other')");
    assert.equal(unknown.rows[0].n, 0);
    {
      for (const s of M0048) await client.query(s);
      await client.query("SAVEPOINT s2");
      await assert.rejects(client.query("INSERT INTO property_parties (property_id, party_id, role) VALUES ($1, $2, 'Occupier')", [p, c]), /property_parties_role_check/);
      await client.query("ROLLBACK TO SAVEPOINT s2");
    }
    await client.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
  // Rolled back: both duplicate rows are still here, and no index/constraint exists.
  const rows = await db.select().from(propertyParties).where(eq(propertyParties.propertyId, p));
  assert.equal(rows.length, 2);
  const idx = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'property_parties_property_party_role_unique'");
  assert.equal(idx.rowCount, 0);
  const chk = await pool.query("SELECT 1 FROM pg_constraint WHERE conname = 'property_parties_role_check'");
  assert.equal(chk.rowCount, 0);
});

test("grow_relationships reconciliation dry run classifies rows and writes nothing", async () => {
  const b = await brokerage("Recon");
  const other = await brokerage("ReconOther");
  const p1 = await b.prop("1");
  const p2 = await b.prop("2");
  const pOther = await other.prop("9");
  const owner = await b.party("Olive");
  const tenant = await b.party("Theo");
  const lead = await b.party("Lena");
  // Already linked as Seller via property_parties.
  assert.equal((await call(b.admin.cookie, "POST", "/parties", { propertyId: p1, partyId: owner, role: "Seller" })).status, 201);
  const bid = b.brokerageId;
  const rows = await db.insert(growRelationships).values([
    { brokerageId: bid, partyId: owner, propertyId: p1, relationshipType: "owner", status: "Active", isPrimary: true },
    { brokerageId: bid, partyId: owner, propertyId: p1, relationshipType: "co_owner", status: "Active" },
    { brokerageId: bid, partyId: owner, propertyId: p1, relationshipType: "seller", status: "Active" },
    { brokerageId: bid, partyId: tenant, propertyId: p2, relationshipType: "tenant", status: "Active" },
    { brokerageId: bid, partyId: tenant, propertyId: p1, relationshipType: "tenant", status: "Historical", validTo: new Date("2025-06-30T14:00:00Z") },
    { brokerageId: bid, partyId: lead, propertyId: p2, relationshipType: "prospective_buyer", status: "Active" },
    { brokerageId: bid, partyId: lead, propertyId: null, relationshipType: "buyer", status: "Active" },
    { brokerageId: bid, partyId: lead, propertyId: pOther, relationshipType: "buyer", status: "Active" },
    // t234u: an unlinked vendor is listed for manual review, never auto-inserted (no AML from history).
    { brokerageId: bid, partyId: tenant, propertyId: p2, relationshipType: "vendor", status: "Active" },
    // t234u: a second would-be primary Tenant on p2 means neither converted Tenant is primary.
    { brokerageId: bid, partyId: lead, propertyId: p2, relationshipType: "tenant", status: "Active", isPrimary: true },
    { brokerageId: bid, partyId: tenant, propertyId: p2, relationshipType: "occupier", status: "Active" },
    // t244u: referrer is person-level; a low-confidence owner is not a verified property; unknown types never become Other.
    { brokerageId: bid, partyId: lead, propertyId: p2, relationshipType: "referrer", status: "Active" },
    { brokerageId: bid, partyId: lead, propertyId: p2, relationshipType: "owner", status: "Active", confidenceScore: "0.5" },
    { brokerageId: bid, partyId: lead, propertyId: p2, relationshipType: "mystery_type", status: "Active" },
  ]).returning({ id: growRelationships.id });
  const grIds = rows.map((r) => r.id);
  const ppCount = async () => (await pool.query("SELECT count(*)::int AS n FROM property_parties WHERE property_id = ANY($1::int[])", [[p1, p2, pOther]])).rows[0].n;
  const beforePP = await ppCount();

  const client = await pool.connect();
  let g3: any[] = [];
  let g2: any[] = [];
  try {
    await client.query("BEGIN READ ONLY");
    const g1 = (await client.query(RECON[0])).rows;
    const cats = new Set(g1.map((r) => r.category));
    for (const c of ["genuine_property_link", "other:pre_property", "other:non_link_type", "other:historical_or_pending"]) assert.ok(cats.has(c), `G1 category ${c}`);
    assert.equal((await client.query(RECON[4])).rowCount, 0, "rollback rehearsal: no run has executed");
    g2 = (await client.query(RECON[1].replace("FROM grow_relationships gr\n)", `FROM grow_relationships gr WHERE gr.id = ANY('{${grIds.join(",")}}'::int[])\n)`))).rows;
    g3 = (await client.query(RECON[2])).rows.filter((r) => [p1, p2, pOther].includes(r.property_id));
    await client.query(RECON[3]);
    await client.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
  const byAction = Object.fromEntries(g2.map((r) => [`${r.action}:${r.target_role ?? "-"}`, Number(r.rows)]));
  assert.deepEqual(byAction, {
    "insert:Owner": 1,
    "insert:Tenant": 2,
    "review:co_owner:-": 1,
    "review:occupier:-": 1,
    "review:seller_vendor_no_aml:-": 2,
    "review:unverified_property:Owner": 1,
    "review:unrecognised_type:-": 1,
    "prospecting:-": 1,
    "person_level:-": 1,
    "opportunity_intelligence:no_property:Buyer": 1,
    "keep:not_active:Tenant": 1,
    "review:brokerage_mismatch:Buyer": 1,
  });
  assert.ok(!g2.some((r) => r.target_role === "Other" || r.target_role === "Seller"), "t244u: never Other, never Seller");
  // t244u: only the verified Active owner converts (co_owner goes to review); primary carried.
  assert.deepEqual(
    g3.map((r) => `${r.property_id}:${r.party_id}:${r.role}:${r.is_primary}:${r.source_grow_relationship_ids.length}`).sort(),
    [`${p1}:${owner}:Owner:true:1`, `${p2}:${tenant}:Tenant:false:1`, `${p2}:${lead}:Tenant:true:1`].sort(),
  );
  assert.equal(await ppCount(), beforePP, "dry run inserted nothing");
  assert.equal((await db.select().from(growRelationships).where(inArray(growRelationships.id, grIds))).length, grIds.length, "grow_relationships untouched");
});

test("t234u: proposed 0049 (one primary per property per role, Other exempt) fails closed, then enforces; env counts are ids-free; all rolled back", async () => {
  const b = await brokerage("Prim");
  const p = await b.prop("1");
  const c1 = await b.party("PrimA");
  const c2 = await b.party("PrimB");
  // testing/r1: 0048/0049 are promoted to real migrations here, so the proposal is already enforced on this DB.
  if (await promotedConstraintsApplied()) {
    await assert.rejects(db.insert(propertyParties).values([{ propertyId: p, partyId: c1, role: "Owner", isPrimary: true }, { propertyId: p, partyId: c2, role: "Owner", isPrimary: true }]), "promoted migration enforces it");
    return;
  }
  await db.insert(propertyParties).values([
    { propertyId: p, partyId: c1, role: "Owner", isPrimary: true },
    { propertyId: p, partyId: c2, role: "Owner", isPrimary: true },
  ]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const counts = Object.fromEntries((await client.query(ENV_COUNTS)).rows.map((r) => [r.check_name, Number(r.value)]));
    assert.ok(counts.P1_multi_primary_groups_blocks_0049 >= 1);
    assert.deepEqual(Object.keys((await client.query(ENV_COUNTS)).rows[0]).sort(), ["check_name", "value"]);
    await client.query("ROLLBACK");
    const shadow = async () => {
      await client.query("CREATE TEMP TABLE property_parties (LIKE public.property_parties INCLUDING DEFAULTS) ON COMMIT DROP");
      await client.query("INSERT INTO property_parties SELECT * FROM public.property_parties WHERE property_id = $1", [p]);
    };
    await client.query("BEGIN");
    await shadow();
    await assert.rejects(client.query(M0049[0]), /more than one primary/);
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await shadow();
    await client.query("UPDATE property_parties SET is_primary = false WHERE property_id = $1 AND party_id = $2", [p, c2]);
    for (const s of M0049) await client.query(s);
    await client.query("SAVEPOINT a");
    await assert.rejects(client.query("INSERT INTO property_parties (property_id, party_id, role, is_primary) VALUES ($1, $2, 'Owner', true)", [p, c2]), /property_parties_one_primary_per_role/);
    await client.query("ROLLBACK TO SAVEPOINT a");
    await client.query("INSERT INTO property_parties (property_id, party_id, role, is_primary) VALUES ($1, $2, 'Other', true), ($1, $3, 'Other', true)", [p, c1, c2]);
    await client.query("INSERT INTO property_parties (property_id, party_id, role, is_primary) VALUES ($1, $2, 'Tenant', false)", [p, c2]);
    await client.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
  const idx = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'property_parties_one_primary_per_role'");
  assert.equal(idx.rowCount, 0);
  await db.delete(propertyParties).where(eq(propertyParties.propertyId, p));
});
