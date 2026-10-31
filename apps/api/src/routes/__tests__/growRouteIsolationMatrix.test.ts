// GR-ISO — Grow route isolation matrix (contacts, properties-link,
// opportunities, activities, commitments). For every Grow write/read route
// that takes a record id (path or body):
//   1. a foreign-brokerage id answers 404 with exactly the body a missing id
//      gets, so the response never hints that the record exists;
//   2. the rejected call changes nothing: the victim brokerage's Grow rows
//      and the caller brokerage's Grow rows are byte-identical before/after;
//   3. a brokerage with no Grow entitlement is refused 403 before any lookup.
// Plus GR-1: POST /grow/contacts/:id/commitments must refuse an in-brokerage
// opportunity hidden from the calling Agent (same rule as POST /activities).
// Synthetic data only. Pattern follows tenantIsolationGrowRun.test.ts (#246).
import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { asc, eq } from "drizzle-orm";
import {
  db,
  entitlementGrants,
  growActivities,
  growCommitments,
  growContactRelationships,
  growContactRoles,
  growOpportunities,
  growRelationships,
  parties,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const GROW_KEYS = [
  "grow.access",
  "grow.contacts.read",
  "grow.contacts.manage",
  "grow.relationships.manage",
  "grow.properties.link",
  "grow.activities.manage",
  "grow.opportunities.manage",
  "run.access",
] as const;
const MISSING = 2147480000;
const suffix = Date.now();

let server: Server;
let baseUrl: string;
type Org = { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let victim: Org;
let attacker: Org;
let unentitled: Org;
let v: {
  contact: number;
  contact2: number;
  property: number;
  relationship: number;
  contactRelationship: number;
  opportunity: number;
  commitment: number;
};
let a: { contact: number; contact2: number; property: number };

async function send(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: body === undefined ? { cookie } : { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function ok<T>(res: Response, status = 201): Promise<T> {
  assert.equal(res.status, status, await res.clone().text());
  return (await res.json()) as T;
}
async function grantAll(id: number) {
  for (const key of GROW_KEYS) {
    await db.insert(entitlementGrants).values({
      brokerageId: id,
      entitlementKey: key,
      granteeType: "brokerage",
      granteeId: id,
      sourceType: "manual",
      status: "Active",
    });
  }
  invalidateEntitlementCache(id);
}
async function snapshot(brokerageId: number): Promise<string> {
  const rows = {
    parties: await db.select().from(parties).where(eq(parties.brokerageId, brokerageId)).orderBy(asc(parties.id)),
    rel: await db.select().from(growRelationships).where(eq(growRelationships.brokerageId, brokerageId)).orderBy(asc(growRelationships.id)),
    act: await db.select().from(growActivities).where(eq(growActivities.brokerageId, brokerageId)).orderBy(asc(growActivities.id)),
    opp: await db.select().from(growOpportunities).where(eq(growOpportunities.brokerageId, brokerageId)).orderBy(asc(growOpportunities.id)),
    com: await db.select().from(growCommitments).where(eq(growCommitments.brokerageId, brokerageId)).orderBy(asc(growCommitments.id)),
    roles: await db.select().from(growContactRoles).where(eq(growContactRoles.brokerageId, brokerageId)).orderBy(asc(growContactRoles.id)),
    crel: await db
      .select()
      .from(growContactRelationships)
      .where(eq(growContactRelationships.brokerageId, brokerageId))
      .orderBy(asc(growContactRelationships.id)),
  };
  return JSON.stringify(rows);
}

type Case = { name: string; method: string; path: (id: number) => string; body?: (id: number) => unknown; foreign: () => number };
function cases(): Case[] {
  return [
    { name: "GET contact", method: "GET", path: (id) => `/grow/contacts/${id}`, foreign: () => v.contact },
    { name: "PATCH contact", method: "PATCH", path: (id) => `/grow/contacts/${id}`, body: () => ({ firstName: "Hijack" }), foreign: () => v.contact },
    { name: "POST contact role", method: "POST", path: (id) => `/grow/contacts/${id}/roles`, body: () => ({ role: GROW_ROLE }), foreign: () => v.contact },
    { name: "DELETE contact role", method: "DELETE", path: (id) => `/grow/contacts/${id}/roles/${GROW_ROLE}`, foreign: () => v.contact },
    {
      name: "POST contact relationship (path party)",
      method: "POST",
      path: (id) => `/grow/contacts/${id}/relationships`,
      body: () => ({ relatedPartyId: a.contact2, relationshipType: GROW_CREL_TYPE }),
      foreign: () => v.contact,
    },
    {
      name: "POST contact relationship (related party)",
      method: "POST",
      path: () => `/grow/contacts/${a.contact}/relationships`,
      body: (id) => ({ relatedPartyId: id, relationshipType: GROW_CREL_TYPE }),
      foreign: () => v.contact2,
    },
    { name: "DELETE contact relationship", method: "DELETE", path: (id) => `/grow/contacts/relationships/${id}`, foreign: () => v.contactRelationship },
    {
      name: "POST commitment (path party)",
      method: "POST",
      path: (id) => `/grow/contacts/${id}/commitments`,
      body: () => ({ description: "x", dueAt: new Date().toISOString() }),
      foreign: () => v.contact,
    },
    {
      name: "POST commitment (property)",
      method: "POST",
      path: () => `/grow/contacts/${a.contact}/commitments`,
      body: (id) => ({ description: "x", dueAt: new Date().toISOString(), propertyId: id }),
      foreign: () => v.property,
    },
    {
      name: "POST commitment (opportunity)",
      method: "POST",
      path: () => `/grow/contacts/${a.contact}/commitments`,
      body: (id) => ({ description: "x", dueAt: new Date().toISOString(), opportunityId: id }),
      foreign: () => v.opportunity,
    },
    { name: "PATCH commitment", method: "PATCH", path: (id) => `/grow/contacts/commitments/${id}`, body: () => ({ status: "Completed" }), foreign: () => v.commitment },
    {
      name: "POST relationship (party)",
      method: "POST",
      path: () => `/grow/relationships`,
      body: (id) => ({ partyId: id, relationshipType: "prospect" }),
      foreign: () => v.contact,
    },
    {
      name: "POST relationship (property link)",
      method: "POST",
      path: () => `/grow/relationships`,
      body: (id) => ({ partyId: a.contact, propertyId: id, relationshipType: "owner" }),
      foreign: () => v.property,
    },
    { name: "PATCH relationship", method: "PATCH", path: (id) => `/grow/relationships/${id}`, body: () => ({ status: "Historical" }), foreign: () => v.relationship },
    {
      name: "POST activity (party)",
      method: "POST",
      path: () => `/grow/activities`,
      body: (id) => ({ activityType: "note", summary: "x", partyId: id }),
      foreign: () => v.contact,
    },
    {
      name: "POST activity (property)",
      method: "POST",
      path: () => `/grow/activities`,
      body: (id) => ({ activityType: "note", summary: "x", propertyId: id }),
      foreign: () => v.property,
    },
    {
      name: "POST activity (opportunity)",
      method: "POST",
      path: () => `/grow/activities`,
      body: (id) => ({ activityType: "note", summary: "x", opportunityId: id }),
      foreign: () => v.opportunity,
    },
    {
      name: "POST opportunity (party)",
      method: "POST",
      path: () => `/grow/opportunities`,
      body: (id) => ({ partyId: id, opportunityType: "Other", reason: "x" }),
      foreign: () => v.contact,
    },
    {
      name: "POST opportunity (property)",
      method: "POST",
      path: () => `/grow/opportunities`,
      body: (id) => ({ partyId: a.contact, propertyId: id, opportunityType: "Appraisal", reason: "x" }),
      foreign: () => v.property,
    },
    {
      name: "PATCH opportunity",
      method: "PATCH",
      path: (id) => `/grow/opportunities/${id}`,
      body: () => ({ recommendedNextAction: "hijack" }),
      foreign: () => v.opportunity,
    },
    {
      name: "PATCH opportunity lifecycle",
      method: "PATCH",
      path: (id) => `/grow/opportunities/${id}/lifecycle`,
      body: () => ({ stage: "Qualified" }),
      foreign: () => v.opportunity,
    },
  ];
}
let GROW_ROLE = "Vendor";
let GROW_CREL_TYPE = "spouse";

async function call(c: Case, cookie: string, id: number) {
  const res = await send(c.method, c.path(id), cookie, c.body ? c.body(id) : undefined);
  const text = await res.text();
  return { status: res.status, text };
}

describe("GR-ISO Grow route isolation matrix", { concurrency: 1 }, () => {
  before(async () => {
    const { configureEvents } = await import("../../lib/events.js");
    configureEvents();
    const { GROW_CONTACT_ROLES, GROW_CONTACT_RELATIONSHIP_TYPES } = await import("@aee/db");
    GROW_ROLE = (GROW_CONTACT_ROLES as readonly string[])[0];
    GROW_CREL_TYPE = (GROW_CONTACT_RELATIONSHIP_TYPES as readonly string[])[0];
    const { createApp } = await import("../../app.js");
    server = createApp().listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bad address");
    baseUrl = `http://127.0.0.1:${addr.port}`;

    victim = await createBrokerageWithUsers(baseUrl, `GR-ISO Victim ${suffix}`);
    attacker = await createBrokerageWithUsers(baseUrl, `GR-ISO Attacker ${suffix}`);
    unentitled = await createBrokerageWithUsers(baseUrl, `GR-ISO None ${suffix}`);
    await grantAll(victim.brokerageId);
    await grantAll(attacker.brokerageId);

    const seed = async (org: Org, tag: string) => {
      const ck = org.admin.cookie;
      const prop = await ok<{ property: { id: number } }>(
        await send("POST", "/properties", ck, { formattedAddress: `${tag} 1 Synthetic St`, state: "NSW", suburb: "Testville", postcode: "2000" }),
      );
      const c1 = await ok<{ contact: { id: number } }>(
        await send("POST", "/grow/contacts", ck, { firstName: tag, lastName: `One${suffix}`, email: `${tag.toLowerCase()}1-${suffix}@example.com` }),
      );
      const c2 = await ok<{ contact: { id: number } }>(
        await send("POST", "/grow/contacts", ck, { firstName: tag, lastName: `Two${suffix}`, email: `${tag.toLowerCase()}2-${suffix}@example.com` }),
      );
      return { property: prop.property.id, contact: c1.contact.id, contact2: c2.contact.id };
    };
    const vs = await seed(victim, "Victim");
    a = await seed(attacker, "Attacker");
    const vck = victim.admin.cookie;
    const rel = await ok<{ relationship: { id: number } }>(
      await send("POST", "/grow/relationships", vck, { partyId: vs.contact, propertyId: vs.property, relationshipType: "owner" }),
    );
    const crel = await ok<{ relationship: { id: number } }>(
      await send("POST", `/grow/contacts/${vs.contact}/relationships`, vck, { relatedPartyId: vs.contact2, relationshipType: GROW_CREL_TYPE }),
    );
    await ok(await send("POST", `/grow/contacts/${vs.contact}/roles`, vck, { role: GROW_ROLE }));
    const opp = await ok<{ opportunity: { id: number } }>(
      await send("POST", "/grow/opportunities", vck, { partyId: vs.contact, propertyId: vs.property, opportunityType: "Appraisal", reason: "victim" }),
    );
    const com = await ok<{ commitment: { id: number } }>(
      await send("POST", `/grow/contacts/${vs.contact}/commitments`, vck, { description: "victim promise", dueAt: new Date().toISOString() }),
    );
    v = { ...vs, relationship: rel.relationship.id, contactRelationship: crel.relationship.id, opportunity: opp.opportunity.id, commitment: com.commitment.id };
  });

  after(async () => {
    await cleanupBrokerages([victim?.brokerageId, attacker?.brokerageId, unentitled?.brokerageId]);
    await new Promise<void>((r) => server.close(() => r()));
  });

  for (const role of ["admin", "agent"] as const) {
    test(`foreign id == missing id (404, same body), no side effects — attacker ${role}`, async () => {
      let ran = 0;
      for (const c of cases()) {
        const cookie = attacker[role].cookie;
        const vBefore = await snapshot(victim.brokerageId);
        const aBefore = await snapshot(attacker.brokerageId);
        const foreign = await call(c, cookie, c.foreign());
        const missing = await call(c, cookie, MISSING);
        assert.equal(foreign.status, 404, `${c.name}: ${foreign.text}`);
        assert.equal(foreign.status, missing.status, `${c.name}: status differs`);
        assert.equal(foreign.text, missing.text, `${c.name}: body differs (existence hint)`);
        assert.ok(!foreign.text.includes("Victim"), `${c.name}: leaked victim marker`);
        assert.equal(await snapshot(victim.brokerageId), vBefore, `${c.name}: victim rows changed`);
        assert.equal(await snapshot(attacker.brokerageId), aBefore, `${c.name}: attacker rows changed`);
        ran++;
      }
      assert.equal(ran, cases().length);
    });
  }

  test("unentitled brokerage is refused 403 on every gated route, with no side effects", async () => {
    let ran = 0;
    for (const c of [...cases(), { name: "GET contacts", method: "GET", path: () => "/grow/contacts", foreign: () => 0 },
      { name: "GET opportunities", method: "GET", path: () => "/grow/opportunities", foreign: () => 0 },
      { name: "GET activities", method: "GET", path: () => "/grow/activities", foreign: () => 0 },
      { name: "POST contact", method: "POST", path: () => "/grow/contacts", body: () => ({ firstName: "N", lastName: "N" }), foreign: () => 0 }] as Case[]) {
      for (const role of ["admin", "agent"] as const) {
        const before = await snapshot(unentitled.brokerageId);
        const vBefore = await snapshot(victim.brokerageId);
        const res = await call(c, unentitled[role].cookie, c.foreign());
        assert.equal(res.status, 403, `${c.name} (${role}): ${res.text}`);
        const body = JSON.parse(res.text) as { error: string; entitlementKey?: string };
        assert.equal(body.error, "Not entitled", c.name);
        assert.ok(!res.text.includes("Victim"), c.name);
        assert.equal(await snapshot(unentitled.brokerageId), before, `${c.name}: rows changed`);
        assert.equal(await snapshot(victim.brokerageId), vBefore, `${c.name}: victim rows changed`);
        ran++;
      }
    }
    assert.equal(ran, (cases().length + 4) * 2);
  });

  test("GR-1: commitment cannot reference an opportunity hidden from the calling Agent", async () => {
    // Victim admin owns an opportunity on a property the victim agent cannot see.
    const vck = victim.admin.cookie;
    const hiddenProp = await ok<{ property: { id: number } }>(
      await send("POST", "/properties", vck, { formattedAddress: "Hidden 9 Synthetic St", state: "NSW", suburb: "Testville", postcode: "2000" }),
    );
    const opp = await ok<{ opportunity: { id: number } }>(
      await send("POST", "/grow/opportunities", vck, { partyId: v.contact, propertyId: hiddenProp.property.id, opportunityType: "Appraisal", reason: "admin only" }),
    );
    const { restrictedPropertyIdsFor } = await import("../../lib/propertyVisibility.js");
    const restrict = await restrictedPropertyIdsFor(victim.agent.user as never);
    assert.ok(restrict !== null && !restrict.includes(hiddenProp.property.id), "fixture: agent must not see the admin property");
    const before = await snapshot(victim.brokerageId);
    const hidden = await call(
      { name: "c", method: "POST", path: () => `/grow/contacts/${v.contact}/commitments`, body: (id) => ({ description: "x", dueAt: new Date().toISOString(), opportunityId: id }), foreign: () => 0 },
      victim.agent.cookie,
      opp.opportunity.id,
    );
    const missing = await call(
      { name: "c", method: "POST", path: () => `/grow/contacts/${v.contact}/commitments`, body: (id) => ({ description: "x", dueAt: new Date().toISOString(), opportunityId: id }), foreign: () => 0 },
      victim.agent.cookie,
      MISSING,
    );
    assert.equal(hidden.status, 404, hidden.text);
    assert.equal(hidden.text, missing.text);
    assert.equal(await snapshot(victim.brokerageId), before);
    // Admin is brokerage-wide and may still attach it.
    await ok(await send("POST", `/grow/contacts/${v.contact}/commitments`, vck, { description: "admin ok", dueAt: new Date().toISOString(), opportunityId: opp.opportunity.id }));
  });

  test("dev-login sanity: victim sees its own contact", async () => {
    const res = await send("GET", `/grow/contacts/${v.contact}`, victim.admin.cookie);
    assert.equal(res.status, 200);
    void devLogin;
  });
});
