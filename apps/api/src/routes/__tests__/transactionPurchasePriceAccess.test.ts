// Owner t170u — Pit Crew transaction purchase-price access (review P2).
//   2. Pit Crew sees the agreed contract purchase price only when assigned to
//      the transaction (per-duty scoping awaits the D1–D4 decision; assignment
//      is the gate today).
//   3. Brokerage isolation, transaction-level permissions, access logging.
//   4. No purchase price in unrestricted transaction API responses.
//   5. Regression tests: assigned, unassigned and cross-brokerage Pit Crew,
//      plus listing agent, Brokerage Administrator and another Agent.
// "Assigned" = an active pit_crew_assignments EXCEPTION row for this user
// whose risk_exceptions row names this transaction (lib/transactionPriceAccess).
// Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, pitCrewAssignments, riskExceptions, transactions, users } from "@aee/db";
import {
  cleanupBrokerages,
  createBrokerageWithUsers,
  createListedProperty,
  createTransactionFromListedProperty,
  devLogin,
  type DevLoginResult,
} from "./testSupport.js";
import { PURCHASE_PRICE_VIEWED_AUDIT_ACTION, toTransactionView } from "../../lib/transactionPriceAccess.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const nameA = `Txn Price A ${suffix}`;
const nameB = `Txn Price B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let otherAgent: DevLoginResult;
let crewAssigned: DevLoginResult;
let crewUnassigned: DevLoginResult; // assigned only to a DIFFERENT transaction
let crewDone: DevLoginResult; // assignment on this transaction is DONE
let crewB: DevLoginResult; // Pit Crew in brokerage B
let txn: { propertyId: number; transactionId: number };
let otherTxn: { propertyId: number; transactionId: number };
let assignedAssignmentId: number;
const PRICE = 87_654_300;
const OTHER_PRICE = 76_543_200;
const HOME_OFFER_PRICE = 65_432_100;

async function call(method: "GET" | "POST", path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: body !== undefined ? { cookie, "content-type": "application/json" } : { cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  return { status: res.status, raw, json: raw ? (JSON.parse(raw) as Record<string, any>) : {} };
}

async function inBrokerage(name: string, brokerageName: string, role: "Agent" | "Pit Crew"): Promise<DevLoginResult> {
  const r = await devLogin(baseUrl, { email: `${name}-${suffix}@example.com`, firstName: name, lastName: "Synthetic", brokerageName });
  await db.update(users).set({ role }).where(eq(users.id, r.user.id));
  return r;
}

async function exceptionOn(brokerageId: number, propertyId: number, transactionId: number, tag: string): Promise<string> {
  const [row] = await db
    .insert(riskExceptions)
    .values({
      brokerageId,
      propertyId,
      transactionId,
      ruleId: "txn-price-access-test-rule",
      category: "OTHER",
      severity: "MEDIUM",
      status: "OPEN",
      title: `Synthetic transaction work ${tag}`,
      problemDescription: "Synthetic fixture.",
      businessImpact: "Synthetic fixture.",
      detectedCause: "Synthetic fixture.",
      recommendedAction: "Synthetic fixture.",
      resolutionRequirements: "Synthetic fixture.",
      sourceRecordType: "TEST_FIXTURE",
      sourceRecordId: `txn-price-${tag}-${suffix}`,
      correlationId: randomUUID(),
      dedupKey: `txn-price-${tag}-${suffix}`,
      openDedupKey: `txn-price-${tag}-${suffix}`,
    })
    .returning({ id: riskExceptions.id });
  return row!.id;
}

async function assign(brokerageId: number, propertyId: number, exceptionId: string, userId: number, status: string): Promise<number> {
  const [row] = await db
    .insert(pitCrewAssignments)
    .values({ brokerageId, sourceType: "EXCEPTION", sourceRecordId: exceptionId, propertyId, status, assignedToUserId: userId, version: 1 })
    .returning({ id: pitCrewAssignments.id });
  return row!.id;
}

async function priceAuditRows(userId: number) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.userId, userId), eq(auditLogs.action, PURCHASE_PRICE_VIEWED_AUDIT_ACTION)));
}

function assertFull(t: Record<string, any>, price: number, label: string) {
  assert.equal(t.purchasePriceCents, price, `${label}: price present`);
  assert.equal(t.purchasePriceVisible, true, `${label}: purchasePriceVisible true`);
}

function assertRedacted(raw: string, t: Record<string, any>, price: number, label: string) {
  assert.equal("purchasePriceCents" in t, false, `${label}: no purchasePriceCents key`);
  assert.equal(t.purchasePriceVisible, false, `${label}: purchasePriceVisible false`);
  assert.equal(typeof t.status, "string", `${label}: status still visible`);
  assert.equal(raw.includes(String(price)), false, `${label}: price digits absent from body`);
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
  otherAgent = await inBrokerage("other-agent", nameA, "Agent");
  crewAssigned = await inBrokerage("crew-assigned", nameA, "Pit Crew");
  crewUnassigned = await inBrokerage("crew-unassigned", nameA, "Pit Crew");
  crewDone = await inBrokerage("crew-done", nameA, "Pit Crew");
  crewB = await inBrokerage("crew-b", nameB, "Pit Crew");

  txn = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Contract Price St, Testville`,
    sellerEmail: `seller-tp-${suffix}@example.com`,
    offerPriceCents: PRICE,
  });
  otherTxn = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Other Contract St, Testville`,
    sellerEmail: `seller-tp2-${suffix}@example.com`,
    offerPriceCents: OTHER_PRICE,
  });

  const exAssigned = await exceptionOn(A.brokerageId, txn.propertyId, txn.transactionId, "assigned");
  assignedAssignmentId = await assign(A.brokerageId, txn.propertyId, exAssigned, crewAssigned.user.id, "IN_PROGRESS");
  const exDone = await exceptionOn(A.brokerageId, txn.propertyId, txn.transactionId, "done");
  await assign(A.brokerageId, txn.propertyId, exDone, crewDone.user.id, "DONE");
  const exElsewhere = await exceptionOn(A.brokerageId, otherTxn.propertyId, otherTxn.transactionId, "elsewhere");
  await assign(A.brokerageId, otherTxn.propertyId, exElsewhere, crewUnassigned.user.id, "IN_PROGRESS");
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("pure view: redaction omits the key (not null) and flags it", () => {
  const row = { id: 1, propertyId: 2, purchasePriceCents: 123, status: "ContractPreparation" } as any;
  const red = toTransactionView(row, false) as Record<string, unknown>;
  assert.equal("purchasePriceCents" in red, false);
  assert.equal(red.purchasePriceVisible, false);
  const full = toTransactionView(row, true) as Record<string, unknown>;
  assert.equal(full.purchasePriceCents, 123);
  assert.equal(full.purchasePriceVisible, true);
});

test("listing agent and Brokerage Administrator see the purchase price; no access-log row for them", async () => {
  for (const [label, who] of [["listing agent", A.agent], ["brokerage admin", A.admin]] as const) {
    const byId = await call("GET", `/transactions/${txn.transactionId}`, who.cookie);
    assert.equal(byId.status, 200, byId.raw);
    assertFull(byId.json.transaction, PRICE, `${label} GET /:id`);
    const byProp = await call("GET", `/transactions/by-property/${txn.propertyId}`, who.cookie);
    assert.equal(byProp.status, 200, byProp.raw);
    assertFull(byProp.json.transaction, PRICE, `${label} by-property`);
    assert.equal((await priceAuditRows(who.user.id)).length, 0, `${label}: no reveal log`);
  }
});

test("assigned Pit Crew sees the contract price, and every reveal is access-logged without the price", async () => {
  const byId = await call("GET", `/transactions/${txn.transactionId}`, crewAssigned.cookie);
  assert.equal(byId.status, 200, byId.raw);
  assertFull(byId.json.transaction, PRICE, "assigned crew GET /:id");
  const byProp = await call("GET", `/transactions/by-property/${txn.propertyId}`, crewAssigned.cookie);
  assert.equal(byProp.status, 200, byProp.raw);
  assertFull(byProp.json.transaction, PRICE, "assigned crew by-property");

  const rows = await priceAuditRows(crewAssigned.user.id);
  assert.equal(rows.length, 2, "one log row per reveal");
  for (const r of rows) {
    assert.equal(r.brokerageId, A.brokerageId);
    assert.equal(r.recordType, "transaction");
    assert.equal(r.recordId, String(txn.transactionId));
    assert.equal(r.propertyId, txn.propertyId);
    const ctx = JSON.parse(r.updatedValue ?? "{}");
    assert.equal(ctx.basis, "pit_crew_assignment");
    assert.equal(ctx.pitCrewAssignmentId, assignedAssignmentId);
    assert.equal(ctx.actorRole, "Pit Crew");
    assert.equal(typeof ctx.surface, "string");
    assert.equal(JSON.stringify(r).includes(String(PRICE)), false, "price never logged");
  }
  const surfaces = rows.map((r) => JSON.parse(r.updatedValue ?? "{}").surface).sort();
  assert.deepEqual(surfaces, ["GET /transactions/:id", "GET /transactions/by-property/:propertyId"]);
});

test("assigned Pit Crew is scoped to that transaction only: another transaction in the brokerage is redacted", async () => {
  const r = await call("GET", `/transactions/${otherTxn.transactionId}`, crewAssigned.cookie);
  assert.equal(r.status, 200, r.raw);
  assertRedacted(r.raw, r.json.transaction, OTHER_PRICE, "assigned crew, other txn");
});

test("unassigned Pit Crew (assigned elsewhere) and a DONE assignment get the transaction without the price; no log", async () => {
  for (const [label, who] of [["unassigned crew", crewUnassigned], ["done crew", crewDone]] as const) {
    const byId = await call("GET", `/transactions/${txn.transactionId}`, who.cookie);
    assert.equal(byId.status, 200, byId.raw);
    assertRedacted(byId.raw, byId.json.transaction, PRICE, `${label} GET /:id`);
    const byProp = await call("GET", `/transactions/by-property/${txn.propertyId}`, who.cookie);
    assert.equal(byProp.status, 200, byProp.raw);
    assertRedacted(byProp.raw, byProp.json.transaction, PRICE, `${label} by-property`);
    assert.equal((await priceAuditRows(who.user.id)).length, 0, `${label}: nothing revealed, nothing logged`);
  }
  // The crew member IS assigned on the other transaction and sees that price.
  const own = await call("GET", `/transactions/${otherTxn.transactionId}`, crewUnassigned.cookie);
  assertFull(own.json.transaction, OTHER_PRICE, "crew on their own assigned txn");
});

test("mutation responses are shaped too: unassigned Pit Crew gets no price back, assigned Pit Crew does", async () => {
  // otherTxn: crewUnassigned is the assigned one there, crewAssigned is not.
  const red = await call("POST", `/transactions/${otherTxn.transactionId}/contract-signed`, crewAssigned.cookie);
  assert.equal(red.status, 200, red.raw);
  assertRedacted(red.raw, red.json.transaction, OTHER_PRICE, "unassigned crew contract-signed");
  const full = await call("POST", `/transactions/${otherTxn.transactionId}/finance-approved`, crewUnassigned.cookie);
  assert.equal(full.status, 200, full.raw);
  assertFull(full.json.transaction, OTHER_PRICE, "assigned crew finance-approved");
});

test("cross-brokerage Pit Crew and Brokerage Administrator get 404 on every transaction route; nothing logged", async () => {
  for (const [label, who] of [["brokerage B crew", crewB], ["brokerage B admin", B.admin]] as const) {
    const checks = [
      await call("GET", `/transactions/${txn.transactionId}`, who.cookie),
      await call("GET", `/transactions/by-property/${txn.propertyId}`, who.cookie),
      await call("GET", `/transactions/${txn.transactionId}/conditions`, who.cookie),
      await call("POST", `/transactions/${txn.transactionId}/settlement-schedule`, who.cookie, { settlementDate: "2027-03-01" }),
    ];
    for (const r of checks) {
      assert.equal(r.status, 404, `${label}: ${r.raw}`);
      assert.equal(r.raw.includes(String(PRICE)), false);
    }
    assert.equal((await priceAuditRows(who.user.id)).length, 0);
  }
});

test("an Agent who is not the listing agent gets 404 on transaction routes and cannot mutate", async () => {
  const checks = [
    await call("GET", `/transactions/${txn.transactionId}`, otherAgent.cookie),
    await call("GET", `/transactions/by-property/${txn.propertyId}`, otherAgent.cookie),
    await call("POST", `/transactions/${txn.transactionId}/contract-signed`, otherAgent.cookie),
  ];
  for (const r of checks) {
    assert.equal(r.status, 404, r.raw);
    assert.deepEqual(r.json, { error: "Not found" });
  }
  const [row] = await db.select({ contractDate: transactions.contractDate }).from(transactions).where(eq(transactions.id, txn.transactionId));
  assert.equal(row!.contractDate, null, "refused call did not mutate");
});

test("offer accept: the returned transaction carries the price for the listing agent, not for (unassigned) Pit Crew", async () => {
  const mk = async (price: number, tag: string) => {
    const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, {
      address: `${suffix} Accept ${tag} St, Testville`,
      sellerEmail: `seller-acc-${tag}-${suffix}@example.com`,
    });
    const o = await call("POST", `/offers/by-property/${propertyId}`, A.agent.cookie, {
      offerPriceCents: price,
      buyer: { firstName: "Synthetic", lastName: `Acc${tag}`, email: `acc-${tag}-${suffix}@example.com` },
    });
    assert.equal(o.status, 201, o.raw);
    return o.json.offer.id as number;
  };
  const agentOffer = await mk(PRICE + 11, "agent");
  const agentAcc = await call("POST", `/offers/${agentOffer}/accept`, A.agent.cookie);
  assert.equal(agentAcc.status, 201, agentAcc.raw);
  assertFull(agentAcc.json.transaction, PRICE + 11, "listing agent accept");

  const crewOffer = await mk(PRICE + 12, "crew");
  const crewAcc = await call("POST", `/offers/${crewOffer}/accept`, crewUnassigned.cookie);
  assert.equal(crewAcc.status, 201, crewAcc.raw);
  assertRedacted(crewAcc.raw, crewAcc.json.transaction, PRICE + 12, "crew accept transaction");
  assert.equal(crewAcc.json.offer.offerTermsVisible, false, "offer object stays redacted (t165u)");
});

test("Home: Pit Crew sees 'Offer received' without the competing offer price; admin and listing agent keep it", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Home Offer St, Testville`,
    sellerEmail: `seller-home-${suffix}@example.com`,
  });
  const o = await call("POST", `/offers/by-property/${propertyId}`, A.agent.cookie, {
    offerPriceCents: HOME_OFFER_PRICE,
    buyer: { firstName: "Synthetic", lastName: "HomeBuyer", email: `home-${suffix}@example.com` },
  });
  assert.equal(o.status, 201, o.raw);
  const shown = `$${(HOME_OFFER_PRICE / 100).toLocaleString()}`;
  const crew = await call("GET", "/home/summary", crewAssigned.cookie);
  assert.equal(crew.status, 200, crew.raw);
  const crewItem = (crew.json.nextActions as Array<{ propertyId: number; label: string }>).find((i) => i.propertyId === propertyId);
  assert.ok(crewItem, "crew still sees the offer item");
  assert.equal(crewItem!.label, "Offer received");
  assert.equal(crew.raw.includes(shown), false, "price absent from crew Home body");
  for (const who of [A.admin, A.agent]) {
    const r = await call("GET", "/home/summary", who.cookie);
    const item = (r.json.nextActions as Array<{ propertyId: number; label: string }>).find((i) => i.propertyId === propertyId);
    assert.equal(item?.label, `Offer received — ${shown}`);
  }
});
