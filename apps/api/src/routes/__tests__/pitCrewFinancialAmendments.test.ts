// Owner t173u — Pit Crew financial permissions: amend only with documented
// authority (none verifiable in the current schema, so Pit Crew amendments
// fail closed), before/after amendment audit, and the t172u read rule for
// agency-agreement fees. Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { agencyAgreementTerms, auditLogs, campaignItems, db, pitCrewAssignments, riskExceptions, users } from "@aee/db";
import {
  cleanupBrokerages,
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  devLogin,
  type DevLoginResult,
} from "./testSupport.js";
import {
  AMENDMENT_AUTHORITY_REQUIRED,
  FINANCIAL_AMENDMENT_DENIED_AUDIT_ACTION,
  FINANCIAL_RECORD_AMENDED_AUDIT_ACTION,
  PROPERTY_FINANCIALS_VIEWED_AUDIT_ACTION,
} from "../../lib/financialAmendments.js";
import { upsertAgencyAgreementTerms } from "../../lib/documents.js";
import { recordVendorAndCost } from "../../lib/launch/model.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const nameA = `Fin Amend A ${suffix}`;
const nameB = `Fin Amend B ${suffix}`;

type Who = DevLoginResult;
let A: { admin: Who; agent: Who; brokerageId: number };
let B: { admin: Who; agent: Who; brokerageId: number };
let otherAgent: Who;
let crewB: Who;
const crew: Record<string, Who> = {};
let txn: { propertyId: number; transactionId: number };
let itemId: string;

// Distinctive synthetic figures.
const RATE = 247; // set by the listing agent in before()
const MARKETING = 3_917_300;
const COST = 612_345;

async function call(method: "GET" | "POST" | "PUT", path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: body !== undefined ? { cookie, "content-type": "application/json" } : { cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  return { status: res.status, raw, json: raw ? (JSON.parse(raw) as Record<string, any>) : {} };
}

async function inBrokerage(name: string, brokerageName: string, role: "Agent" | "Pit Crew"): Promise<Who> {
  const r = await devLogin(baseUrl, { email: `${name}-${suffix}@example.com`, firstName: name, lastName: "Synthetic", brokerageName });
  await db.update(users).set({ role }).where(eq(users.id, r.user.id));
  return r;
}

async function crewOn(key: string, status: string) {
  crew[key] = await inBrokerage(`fa-crew-${key}`, nameA, "Pit Crew");
  const [ex] = await db
    .insert(riskExceptions)
    .values({
      brokerageId: A.brokerageId,
      propertyId: txn.propertyId,
      transactionId: txn.transactionId,
      ruleId: "fin-amend-test-rule",
      category: "SETTLEMENT_CLOSURE",
      severity: "MEDIUM",
      status: "OPEN",
      title: `Synthetic settlement work ${key}`,
      problemDescription: "Synthetic fixture.",
      businessImpact: "Synthetic fixture.",
      detectedCause: "Synthetic fixture.",
      recommendedAction: "Synthetic fixture.",
      resolutionRequirements: "Synthetic fixture.",
      sourceRecordType: "TEST_FIXTURE",
      sourceRecordId: `fin-amend-${key}-${suffix}`,
      correlationId: randomUUID(),
      dedupKey: `fin-amend-${key}-${suffix}`,
      openDedupKey: `fin-amend-${key}-${suffix}`,
    })
    .returning({ id: riskExceptions.id });
  await db.insert(pitCrewAssignments).values({
    brokerageId: A.brokerageId,
    sourceType: "EXCEPTION",
    sourceRecordId: ex!.id,
    propertyId: txn.propertyId,
    status,
    assignedToUserId: crew[key]!.user.id,
    version: 1,
  });
}

const terms = { commissionType: "Percentage", commissionRateBps: RATE, marketingFeeCents: MARKETING, agreementTermDays: 90 };

async function auditRows(userId: number, action: string) {
  return db.select().from(auditLogs).where(and(eq(auditLogs.userId, userId), eq(auditLogs.action, action)));
}
async function termsRow() {
  const [row] = await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.propertyId, txn.propertyId));
  return row!;
}
async function itemRow() {
  const [row] = await db.select().from(campaignItems).where(eq(campaignItems.id, itemId));
  return row!;
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, nameA);
  B = await createBrokerageWithUsers(baseUrl, nameB);
  otherAgent = await inBrokerage("fa-other-agent", nameA, "Agent");
  crewB = await inBrokerage("fa-crew-b", nameB, "Pit Crew");
  txn = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Amend St, Testville`,
    sellerEmail: `seller-fa-${suffix}@example.com`,
    offerPriceCents: 91_234_500,
  });
  const put = await call("PUT", `/documents/agency-agreement-terms/${txn.propertyId}`, A.agent.cookie, terms);
  assert.equal(put.status, 200, put.raw);
  let launch = await call("GET", `/properties/${txn.propertyId}/launch`, A.agent.cookie);
  for (let i = 0; i < 10 && !launch.json.launch; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    launch = await call("GET", `/properties/${txn.propertyId}/launch`, A.agent.cookie);
  }
  if (!launch.json.launch) {
    const created = await call("POST", `/properties/${txn.propertyId}/launch`, A.agent.cookie, {});
    assert.ok(created.status < 300, created.raw);
    launch = await call("GET", `/properties/${txn.propertyId}/launch`, A.agent.cookie);
  }
  assert.ok(launch.json.launch?.plan?.id, launch.raw);
  const item = await call("POST", `/launch/${launch.json.launch.plan.id}/campaign-items`, A.agent.cookie, { itemType: "PHOTOGRAPHY", title: "Photography" });
  assert.equal(item.status, 201, item.raw);
  itemId = item.json.item.id;
  const cost = await call("POST", `/launch/campaign-items/${itemId}/vendor-cost`, A.agent.cookie, { vendorName: "Synthetic Photo Co", costCents: COST });
  assert.equal(cost.status, 200, cost.raw);
  await crewOn("assigned", "IN_PROGRESS");
  await crewOn("done", "DONE");
  await crewOn("handedBack", "HANDED_BACK");
  crew.unassigned = await inBrokerage("fa-crew-unassigned", nameA, "Pit Crew");
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// ---- reads: agency-agreement fees follow the t172u view rule ----

test("agency terms read: listing agent, admin and assigned Pit Crew see the fees; other Pit Crew see the row without them; other agent and other brokerage 404", async () => {
  const visible: Array<[string, () => Who]> = [["listing agent", () => A.agent], ["admin", () => A.admin], ["assigned crew", () => crew.assigned!]];
  const restricted: Array<[string, () => Who]> = [["unassigned crew", () => crew.unassigned!], ["DONE crew", () => crew.done!], ["HANDED_BACK crew", () => crew.handedBack!]];
  for (const [label, who] of visible) {
    const r = await call("GET", `/documents/agency-agreement-terms/${txn.propertyId}`, who().cookie);
    assert.equal(r.status, 200, `${label}: ${r.raw}`);
    assert.equal(r.json.terms.termsVisible, true, label);
    assert.equal(r.json.terms.commissionRateBps, RATE, label);
    assert.equal(r.json.terms.marketingFeeCents, MARKETING, label);
    const d = await call("GET", `/properties/${txn.propertyId}/workspace`, who().cookie);
    assert.equal(d.status, 200, `${label} detail: ${d.raw}`);
    assert.equal(d.json.agencyAgreementTerms.commissionRateBps, RATE, `${label} detail`);
  }
  for (const [label, who] of restricted) {
    for (const path of [`/documents/agency-agreement-terms/${txn.propertyId}`, `/properties/${txn.propertyId}/workspace`]) {
      const r = await call("GET", path, who().cookie);
      assert.equal(r.status, 200, `${label} ${path}: ${r.raw}`);
      const t = path.startsWith("/documents") ? r.json.terms : r.json.agencyAgreementTerms;
      assert.equal(t.termsVisible, false, `${label} ${path}`);
      assert.equal(typeof t.id, "number", `${label}: terms still shown as captured`);
      for (const k of ["commissionRateBps", "flatFeeCents", "marketingFeeCents"]) assert.equal(k in t, false, `${label} ${path}: ${k} omitted`);
      assert.equal(r.raw.includes(String(MARKETING)), false, `${label}: marketing fee digits absent`);
    }
  }
  for (const [label, who] of [["other agent", otherAgent], ["brokerage B admin", B.admin], ["brokerage B crew", crewB]] as const) {
    const r = await call("GET", `/documents/agency-agreement-terms/${txn.propertyId}`, who.cookie);
    assert.equal(r.status, 404, `${label}: ${r.raw}`);
  }
});

test("agency terms read log: a Pit Crew reveal is logged with categories only; restricted and owner reads log nothing", async () => {
  const rows = await auditRows(crew.assigned!.user.id, PROPERTY_FINANCIALS_VIEWED_AUDIT_ACTION);
  assert.ok(rows.length >= 2, "API read and property detail were logged");
  for (const row of rows) {
    const ctx = JSON.parse(row.updatedValue ?? "{}");
    assert.deepEqual(ctx.fieldCategories, ["agencyAgreementFees"]);
    assert.equal(ctx.basis, "pit_crew_assignment");
    assert.equal(row.previousValue, null);
    const text = JSON.stringify(row);
    for (const v of [RATE, MARKETING]) assert.equal(text.includes(String(v)), false, "no value in a view log");
  }
  for (const who of [crew.unassigned!, crew.done!, A.agent, A.admin]) {
    assert.equal((await auditRows(who.user.id, PROPERTY_FINANCIALS_VIEWED_AUDIT_ACTION)).length, 0);
  }
});

// ---- amendments: Pit Crew fail closed; a self-asserted authority is ignored ----

test("agency terms amend: every Pit Crew member gets 403 (even assigned, even claiming authority); other agent and other brokerage 404; nothing changes", async () => {
  const beforeRow = await termsRow();
  const forged = { ...terms, commissionRateBps: 999, authorisedByUserId: A.agent.user.id, documentedAuthority: true, authority: { grantedBy: A.admin.user.id } };
  for (const key of ["assigned", "unassigned", "done", "handedBack"]) {
    for (const body of [{ ...terms, commissionRateBps: 998 }, forged]) {
      const r = await call("PUT", `/documents/agency-agreement-terms/${txn.propertyId}`, crew[key]!.cookie, body);
      assert.equal(r.status, 403, `${key}: ${r.raw}`);
      assert.equal(r.json.reason, AMENDMENT_AUTHORITY_REQUIRED);
    }
  }
  for (const who of [otherAgent, B.admin, crewB]) {
    const r = await call("PUT", `/documents/agency-agreement-terms/${txn.propertyId}`, who.cookie, forged);
    assert.equal(r.status, 404, r.raw);
  }
  assert.deepEqual(await termsRow(), beforeRow, "terms unchanged");
  const denied = await auditRows(crew.assigned!.user.id, FINANCIAL_AMENDMENT_DENIED_AUDIT_ACTION);
  assert.ok(denied.length >= 2);
  for (const row of denied) {
    assert.equal(JSON.parse(row.updatedValue ?? "{}").reason, AMENDMENT_AUTHORITY_REQUIRED);
    assert.equal(row.updatedValue!.includes("999"), false, "denial log carries no submitted value");
  }
  assert.equal((await auditRows(crew.assigned!.user.id, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION)).length, 0);
});

test("vendor cost amend: Pit Crew 403 (assigned or not, forged authority ignored); other agent and other brokerage 404; cost unchanged", async () => {
  const beforeRow = await itemRow();
  for (const key of ["assigned", "unassigned", "done"]) {
    const r = await call("POST", `/launch/campaign-items/${itemId}/vendor-cost`, crew[key]!.cookie, {
      vendorName: "Forged",
      costCents: 1,
      authorisedByUserId: A.agent.user.id,
    });
    assert.equal(r.status, 403, `${key}: ${r.raw}`);
    assert.equal(r.json.reason, AMENDMENT_AUTHORITY_REQUIRED);
  }
  for (const who of [otherAgent, B.admin, crewB]) {
    const r = await call("POST", `/launch/campaign-items/${itemId}/vendor-cost`, who.cookie, { vendorName: "Forged", costCents: 1 });
    assert.equal(r.status, 404, r.raw);
  }
  const bogus = await call("POST", `/launch/campaign-items/not-a-uuid/vendor-cost`, A.admin.cookie, { vendorName: "x", costCents: 1 });
  assert.equal(bogus.status, 404);
  const afterRow = await itemRow();
  assert.equal(afterRow.costCents, beforeRow.costCents);
  assert.equal(afterRow.vendorName, beforeRow.vendorName);
});

// ---- amendments by the listing agent and admin: before/after audit ----

test("listing agent and admin amendments are audited with authoriser, performer, time and before/after values", async () => {
  const t0 = Date.now();
  const r1 = await call("PUT", `/documents/agency-agreement-terms/${txn.propertyId}`, A.agent.cookie, { ...terms, commissionRateBps: 251 });
  assert.equal(r1.status, 200, r1.raw);
  const r2 = await call("PUT", `/documents/agency-agreement-terms/${txn.propertyId}`, A.admin.cookie, { ...terms, commissionRateBps: 263 });
  assert.equal(r2.status, 200, r2.raw);
  const [agentRow] = (await auditRows(A.agent.user.id, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION)).filter((r) => r.recordType === "agency_agreement_terms" && JSON.parse(r.updatedValue!).after.commissionRateBps === 251);
  assert.ok(agentRow, "listing agent amendment row");
  assert.equal(JSON.parse(agentRow!.previousValue!).commissionRateBps, RATE, "before value");
  const a = JSON.parse(agentRow!.updatedValue!);
  assert.equal(a.authorisedByUserId, A.agent.user.id);
  assert.equal(a.authorityBasis, "listing_agent");
  assert.equal(a.performedByUserId, A.agent.user.id);
  assert.equal(a.performedByRole, "Agent");
  assert.ok(Date.parse(a.performedAt) >= t0 - 1000, "timestamp recorded");
  assert.equal(agentRow!.brokerageId, A.brokerageId);
  assert.equal(agentRow!.propertyId, txn.propertyId);
  const [adminRow] = (await auditRows(A.admin.user.id, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION)).filter((r) => r.recordType === "agency_agreement_terms");
  assert.equal(JSON.parse(adminRow!.previousValue!).commissionRateBps, 251);
  const b = JSON.parse(adminRow!.updatedValue!);
  assert.equal(b.after.commissionRateBps, 263);
  assert.equal(b.authorityBasis, "brokerage_admin");
  assert.equal(b.authorisedByUserId, A.admin.user.id);

  const v = await call("POST", `/launch/campaign-items/${itemId}/vendor-cost`, A.admin.cookie, { vendorName: "Synthetic Photo Co", costCents: COST + 5 });
  assert.equal(v.status, 200, v.raw);
  const costRows = (await auditRows(A.admin.user.id, FINANCIAL_RECORD_AMENDED_AUDIT_ACTION)).filter((r) => r.recordType === "campaign_item");
  assert.equal(costRows.length, 1);
  assert.equal(JSON.parse(costRows[0]!.previousValue!).costCents, COST);
  assert.equal(JSON.parse(costRows[0]!.updatedValue!).after.costCents, COST + 5);

  // The amendment rows (which carry values) never surface on the Property Timeline.
  for (const who of [crew.unassigned!, crew.assigned!, A.agent]) {
    const tl = await call("GET", `/properties/${txn.propertyId}/timeline`, who.cookie);
    assert.equal(tl.status, 200, tl.raw);
    assert.equal((tl.json.timeline as Array<{ entryType: string }>).some((i) => i.entryType === FINANCIAL_RECORD_AMENDED_AUDIT_ACTION), false);
    assert.equal(tl.raw.includes(String(COST + 5)), false);
  }
});

test("amendment audit is fail closed: if the audit write fails, the amendment rolls back", async () => {
  const beforeTerms = await termsRow();
  await assert.rejects(
    upsertAgencyAgreementTerms(
      { propertyId: txn.propertyId, brokerageId: A.brokerageId, userId: A.admin.user.id, commissionType: "Percentage", commissionRateBps: 777, agreementTermDays: 90 },
      async () => {
        throw new Error("synthetic audit failure");
      },
    ),
  );
  assert.deepEqual(await termsRow(), beforeTerms, "terms rolled back");
  const beforeItem = await itemRow();
  await assert.rejects(
    recordVendorAndCost(itemId, A.brokerageId, { id: A.admin.user.id, role: "Brokerage Administrator" } as any, "Rollback Co", 7, async () => {
      throw new Error("synthetic audit failure");
    }),
  );
  const afterItem = await itemRow();
  assert.equal(afterItem.costCents, beforeItem.costCents, "cost rolled back");
  assert.equal(afterItem.vendorName, beforeItem.vendorName);
  const stray = await db
    .select({ updatedValue: auditLogs.updatedValue })
    .from(auditLogs)
    .where(and(eq(auditLogs.propertyId, txn.propertyId), inArray(auditLogs.action, [FINANCIAL_RECORD_AMENDED_AUDIT_ACTION])));
  assert.equal(stray.some((r) => /"commissionRateBps":777|"vendorName":"Rollback Co"/.test(r.updatedValue ?? "")), false, "no amendment row for a rolled-back write");
});
