// Owner t170u + t171u — confidential transaction financials (review P2).
// Field groups (lib/pitCrewDuties.ts): purchasePrice, deposit, commission
// (gross + GST), funds (funds received + the derived funds reconciliation).
// Listing agent and Brokerage Administrator: every group. Pit Crew: only the
// groups their duty allows, and only through an ACTIVE assignment on THIS
// transaction (duty map PENDING OWNER CONFIRMATION). Unassigned Pit Crew:
// none. Other Agent and other brokerage: 404. Every Pit Crew reveal is
// access-logged with field categories only, never a value. Synthetic data.
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
import {
  DUTY_FINANCIAL_GROUPS,
  EXCEPTION_CATEGORY_DUTY,
  PIT_CREW_DUTIES,
  dutyForAssignment,
  financialVisibilityForDuties,
  type FinancialVisibility,
  type TransactionFinancialGroup,
} from "../../lib/pitCrewDuties.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const nameA = `Txn Fin A ${suffix}`;
const nameB = `Txn Fin B ${suffix}`;

// Distinctive synthetic values, so "absent from the body" is a real check.
const V = { purchasePrice: 87_654_300, deposit: 4_383_217, commission: 1_753_089, gst: 175_311, funds: 1_111_973 };
const OTHER_PRICE = 76_543_200;
const HOME_OFFER_PRICE = 65_432_100;

type Who = DevLoginResult;
let A: { admin: Who; agent: Who; brokerageId: number };
let B: { admin: Who; agent: Who; brokerageId: number };
let otherAgent: Who;
const crew: Record<string, Who> = {};
let crewB: Who;
let txn: { propertyId: number; transactionId: number };
let otherTxn: { propertyId: number; transactionId: number };
const assignmentIds: Record<string, number> = {};

const ALL: FinancialVisibility = { purchasePrice: true, deposit: true, commission: true, funds: true };
const NONE: FinancialVisibility = { purchasePrice: false, deposit: false, commission: false, funds: false };
const SETTLE: FinancialVisibility = { purchasePrice: true, deposit: true, commission: false, funds: false };
const CONTRACT: FinancialVisibility = { purchasePrice: false, deposit: true, commission: false, funds: false };

async function call(method: "GET" | "POST", path: string, cookie: string, body?: unknown) {
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

async function exceptionOn(propertyId: number, transactionId: number, category: string, tag: string): Promise<string> {
  const [row] = await db
    .insert(riskExceptions)
    .values({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      ruleId: "txn-fin-access-test-rule",
      category,
      severity: "MEDIUM",
      status: "OPEN",
      title: `Synthetic transaction work ${tag}`,
      problemDescription: "Synthetic fixture.",
      businessImpact: "Synthetic fixture.",
      detectedCause: "Synthetic fixture.",
      recommendedAction: "Synthetic fixture.",
      resolutionRequirements: "Synthetic fixture.",
      sourceRecordType: "TEST_FIXTURE",
      sourceRecordId: `txn-fin-${tag}-${suffix}`,
      correlationId: randomUUID(),
      dedupKey: `txn-fin-${tag}-${suffix}`,
      openDedupKey: `txn-fin-${tag}-${suffix}`,
    })
    .returning({ id: riskExceptions.id });
  return row!.id;
}

async function crewOn(key: string, t: { propertyId: number; transactionId: number }, category: string, status = "IN_PROGRESS") {
  crew[key] ??= await inBrokerage(`crew-${key}`, nameA, "Pit Crew");
  const exId = await exceptionOn(t.propertyId, t.transactionId, category, key);
  const [row] = await db
    .insert(pitCrewAssignments)
    .values({ brokerageId: A.brokerageId, sourceType: "EXCEPTION", sourceRecordId: exId, propertyId: t.propertyId, status, assignedToUserId: crew[key]!.user.id, version: 1 })
    .returning({ id: pitCrewAssignments.id });
  assignmentIds[key] = row!.id;
}

async function revealRows(userId: number) {
  return db.select().from(auditLogs).where(and(eq(auditLogs.userId, userId), eq(auditLogs.action, PURCHASE_PRICE_VIEWED_AUDIT_ACTION)));
}

const GROUP_CHECKS: Record<TransactionFinancialGroup, Array<[string, number]>> = {
  purchasePrice: [["purchasePriceCents", V.purchasePrice]],
  deposit: [["depositCents", V.deposit]],
  commission: [["grossCommissionCents", V.commission], ["gstCents", V.gst]],
  funds: [["fundsReceivedCents", V.funds]],
};

/** Every group either fully present with the right value, or keys absent and digits absent. */
function assertGroups(raw: string, t: Record<string, any>, expected: FinancialVisibility, label: string) {
  assert.deepEqual(t.financialVisibility, expected, `${label}: financialVisibility`);
  assert.equal(t.purchasePriceVisible, expected.purchasePrice, `${label}: purchasePriceVisible alias`);
  assert.equal(typeof t.status, "string", `${label}: status still visible`);
  for (const [group, fields] of Object.entries(GROUP_CHECKS) as Array<[TransactionFinancialGroup, Array<[string, number]>]>) {
    for (const [key, value] of fields) {
      if (expected[group]) {
        assert.equal(t[key], value, `${label}: ${key} present`);
      } else {
        assert.equal(key in t, false, `${label}: ${key} omitted`);
        assert.equal(raw.includes(String(value)), false, `${label}: ${key} digits absent from body`);
      }
    }
  }
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
  crewB = await inBrokerage("crew-b", nameB, "Pit Crew");

  txn = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Contract Fin St, Testville`,
    sellerEmail: `seller-tf-${suffix}@example.com`,
    offerPriceCents: V.purchasePrice,
    depositCents: V.deposit,
  });
  otherTxn = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Other Fin St, Testville`,
    sellerEmail: `seller-tf2-${suffix}@example.com`,
    offerPriceCents: OTHER_PRICE,
  });
  // Synthetic commission and funds figures (no calculation path needed).
  await db
    .update(transactions)
    .set({ depositCents: V.deposit, grossCommissionCents: V.commission, gstCents: V.gst, commissionCalculatedAt: new Date(), fundsReceivedCents: V.funds })
    .where(eq(transactions.id, txn.transactionId));

  await crewOn("settle", txn, "SETTLEMENT_CLOSURE");
  await crewOn("contract", txn, "CONTRACT_CONDITIONS");
  await crewOn("wrongDuty", txn, "AML_CTF");
  await crewOn("unknownDuty", txn, "OTHER");
  await crewOn("financial", txn, "FINANCIAL");
  await crewOn("done", txn, "SETTLEMENT_CLOSURE", "DONE");
  await crewOn("unassigned", otherTxn, "SETTLEMENT_CLOSURE"); // assigned only to the OTHER transaction
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// ---- pure: the duty map (PENDING OWNER CONFIRMATION) ----

test("duty map: unknown category, FINANCIAL, null and non-EXCEPTION sources all yield no duty (fail closed)", () => {
  assert.equal(dutyForAssignment("EXCEPTION", "OTHER"), null);
  assert.equal(dutyForAssignment("EXCEPTION", "FINANCIAL"), null);
  assert.equal(dutyForAssignment("EXCEPTION", null), null);
  assert.equal(dutyForAssignment("EXCEPTION", "toString"), null, "prototype keys are not duties");
  assert.equal(dutyForAssignment("LAUNCH_ITEM", "SETTLEMENT_CLOSURE"), null);
  assert.equal(dutyForAssignment("SETTLEMENT_MILESTONE", "SETTLEMENT_CLOSURE"), null);
  assert.equal(dutyForAssignment("EXCEPTION", "SETTLEMENT_CLOSURE"), "SETTLEMENT_PREPARATION");
  assert.deepEqual(financialVisibilityForDuties([null, null]), NONE);
  assert.deepEqual(financialVisibilityForDuties(["SETTLEMENT_PREPARATION"]), SETTLE);
  assert.deepEqual(financialVisibilityForDuties(["CONTRACT_CONDITION_TRACKING", "AML_CHASING"]), CONTRACT);
});

test("duty map invariants: no duty ever sees commission or funds; OFFER_SUPPORT sees nothing; every mapped duty has an entry", () => {
  for (const duty of PIT_CREW_DUTIES) {
    const groups = DUTY_FINANCIAL_GROUPS[duty];
    assert.ok(Array.isArray(groups), `${duty} has an entry`);
    assert.equal(groups.includes("commission"), false, `${duty}: no commission`);
    assert.equal(groups.includes("funds"), false, `${duty}: no funds`);
  }
  assert.deepEqual([...DUTY_FINANCIAL_GROUPS.OFFER_SUPPORT], []);
  for (const duty of Object.values(EXCEPTION_CATEGORY_DUTY)) assert.ok(PIT_CREW_DUTIES.includes(duty));
});

test("pure view: hidden groups are omitted (not null) and flagged", () => {
  const row = { id: 1, propertyId: 2, status: "ContractPreparation", purchasePriceCents: 1, depositCents: 2, grossCommissionCents: 3, gstCents: 4, fundsReceivedCents: 5 } as any;
  const v = toTransactionView(row, CONTRACT) as Record<string, unknown>;
  assert.equal(v.depositCents, 2);
  for (const k of ["purchasePriceCents", "grossCommissionCents", "gstCents", "fundsReceivedCents"]) assert.equal(k in v, false, k);
  assert.deepEqual(v.financialVisibility, CONTRACT);
  assert.equal(v.purchasePriceVisible, false);
});

// ---- read endpoints: every caller x every field group ----

const READ_CASES: Array<[string, () => Who, FinancialVisibility]> = [
  ["listing agent", () => A.agent, ALL],
  ["brokerage admin", () => A.admin, ALL],
  ["Pit Crew, settlement duty", () => crew.settle!, SETTLE],
  ["Pit Crew, contract-conditions duty", () => crew.contract!, CONTRACT],
  ["Pit Crew, wrong duty (AML)", () => crew.wrongDuty!, NONE],
  ["Pit Crew, unknown duty", () => crew.unknownDuty!, NONE],
  ["Pit Crew, FINANCIAL exception (no duty)", () => crew.financial!, NONE],
  ["Pit Crew, DONE assignment", () => crew.done!, NONE],
  ["Pit Crew, unassigned (assigned elsewhere)", () => crew.unassigned!, NONE],
];

test("GET /transactions/:id and /by-property: each caller sees exactly their field groups; funds reconciliation follows funds", async () => {
  for (const [label, who, expected] of READ_CASES) {
    for (const path of [`/transactions/${txn.transactionId}`, `/transactions/by-property/${txn.propertyId}`]) {
      const r = await call("GET", path, who().cookie);
      assert.equal(r.status, 200, `${label} ${path}: ${r.raw}`);
      assertGroups(r.raw, r.json.transaction, expected, `${label} ${path}`);
      if (expected.funds) {
        assert.equal(r.json.fundsReconciliation?.receivedCents, V.funds, `${label}: reconciliation present`);
      } else {
        assert.equal(r.json.fundsReconciliation, null, `${label}: reconciliation withheld`);
      }
    }
  }
});

test("mutation responses are shaped the same way (legal-representatives, no-op body)", async () => {
  for (const [label, who, expected] of READ_CASES) {
    const r = await call("POST", `/transactions/${txn.transactionId}/legal-representatives`, who().cookie, {});
    assert.equal(r.status, 200, `${label}: ${r.raw}`);
    assertGroups(r.raw, r.json.transaction, expected, `${label} mutation`);
  }
});

test("access log: one row per Pit Crew reveal with categories, duties and assignment ids, never a value; nothing for denied or owner reads", async () => {
  const settle = await revealRows(crew.settle!.user.id);
  assert.ok(settle.length >= 3, "reads + mutation were logged");
  for (const row of settle) {
    assert.equal(row.brokerageId, A.brokerageId);
    assert.equal(row.recordType, "transaction");
    assert.equal(row.recordId, String(txn.transactionId));
    const ctx = JSON.parse(row.updatedValue ?? "{}");
    assert.deepEqual(ctx.fieldCategories, ["purchasePrice", "deposit"]);
    assert.deepEqual(ctx.duties, ["SETTLEMENT_PREPARATION"]);
    assert.deepEqual(ctx.pitCrewAssignmentIds, [assignmentIds.settle]);
    assert.equal(ctx.actorRole, "Pit Crew");
    assert.equal(ctx.dutyMapStatus, "PENDING_OWNER_CONFIRMATION");
    assert.equal(typeof ctx.surface, "string");
    const text = JSON.stringify(row);
    for (const v of Object.values(V)) assert.equal(text.includes(String(v)), false, "no value logged");
  }
  const contract = await revealRows(crew.contract!.user.id);
  assert.ok(contract.length >= 1);
  for (const row of contract) assert.deepEqual(JSON.parse(row.updatedValue ?? "{}").fieldCategories, ["deposit"]);
  for (const key of ["wrongDuty", "unknownDuty", "financial", "done", "unassigned"]) {
    assert.equal((await revealRows(crew[key]!.user.id)).length, 0, `${key}: nothing revealed, nothing logged`);
  }
  for (const who of [A.agent, A.admin]) assert.equal((await revealRows(who.user.id)).length, 0, "owner reads are not logged");
});

test("assignment is per transaction: the 'unassigned' crew member sees price/deposit only on their own transaction", async () => {
  const own = await call("GET", `/transactions/${otherTxn.transactionId}`, crew.unassigned!.cookie);
  assert.equal(own.status, 200, own.raw);
  assert.equal(own.json.transaction.purchasePriceCents, OTHER_PRICE);
  assert.deepEqual(own.json.transaction.financialVisibility, SETTLE);
  const other = await call("GET", `/transactions/${otherTxn.transactionId}`, crew.settle!.cookie);
  assert.equal(other.json.transaction.purchasePriceVisible, false);
  assert.equal(other.raw.includes(String(OTHER_PRICE)), false);
});

test("cross-brokerage Pit Crew and Brokerage Administrator: 404 on every transaction route; nothing logged", async () => {
  for (const [label, who] of [["brokerage B crew", crewB], ["brokerage B admin", B.admin]] as const) {
    const checks = [
      await call("GET", `/transactions/${txn.transactionId}`, who.cookie),
      await call("GET", `/transactions/by-property/${txn.propertyId}`, who.cookie),
      await call("GET", `/transactions/${txn.transactionId}/conditions`, who.cookie),
      await call("POST", `/transactions/${txn.transactionId}/legal-representatives`, who.cookie, {}),
      await call("GET", `/properties/${txn.propertyId}/timeline`, who.cookie),
    ];
    for (const r of checks) {
      assert.equal(r.status, 404, `${label}: ${r.raw}`);
      for (const v of Object.values(V)) assert.equal(r.raw.includes(String(v)), false);
    }
    assert.equal((await revealRows(who.user.id)).length, 0);
  }
});

test("an Agent who is not the listing agent: 404 on transaction routes and the timeline, and cannot mutate", async () => {
  const checks = [
    await call("GET", `/transactions/${txn.transactionId}`, otherAgent.cookie),
    await call("GET", `/transactions/by-property/${txn.propertyId}`, otherAgent.cookie),
    await call("POST", `/transactions/${txn.transactionId}/contract-signed`, otherAgent.cookie),
  ];
  for (const r of checks) {
    assert.equal(r.status, 404, r.raw);
    assert.deepEqual(r.json, { error: "Not found" });
  }
  const tl = await call("GET", `/properties/${txn.propertyId}/timeline`, otherAgent.cookie);
  assert.equal(tl.status, 404, tl.raw);
  const [row] = await db.select({ contractDate: transactions.contractDate }).from(transactions).where(eq(transactions.id, txn.transactionId));
  assert.equal(row!.contractDate, null, "refused call did not mutate");
});

test("Property Timeline: offer/contract prices only for listing agent and admin; never Pit Crew (any duty)", async () => {
  const priceText = `$${(V.purchasePrice / 100).toFixed(2)}`;
  const offerEvents = (r: { json: Record<string, any> }) =>
    (r.json.timeline as Array<Record<string, any>>).filter((i) => i.entryType === "OFFER_RECEIVED" || i.entryType === "OFFER_ACCEPTED");
  for (const who of [A.agent, A.admin]) {
    const r = await call("GET", `/properties/${txn.propertyId}/timeline`, who.cookie);
    assert.equal(r.status, 200, r.raw);
    const items = offerEvents(r);
    assert.ok(items.length >= 2, "offer received + accepted present");
    assert.ok(items.some((i) => String(i.label).includes(priceText)), "price in label");
  }
  for (const key of ["settle", "contract", "unassigned"]) {
    const r = await call("GET", `/properties/${txn.propertyId}/timeline`, crew[key]!.cookie);
    assert.equal(r.status, 200, r.raw);
    const items = offerEvents(r);
    assert.ok(items.length >= 2, `${key}: events still listed`);
    for (const i of items) {
      assert.equal(String(i.label).includes("$"), false, `${key}: no price in label`);
      if (i.detail) for (const k of ["offerPriceCents", "purchasePriceCents"]) assert.equal(k in i.detail, false, `${key}: ${k} not in detail`);
    }
    assert.equal(r.raw.includes(String(V.purchasePrice)), false, `${key}: price digits absent`);
  }
});

test("offer accept: the returned transaction is shaped (listing agent full; unassigned Pit Crew none)", async () => {
  const mk = async (price: number, tag: string) => {
    const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, {
      address: `${suffix} Accept ${tag} St, Testville`,
      sellerEmail: `seller-acc-${tag}-${suffix}@example.com`,
    });
    const o = await call("POST", `/offers/by-property/${propertyId}`, A.agent.cookie, {
      offerPriceCents: price,
      conditions: { depositCents: 3_219_871 },
      buyer: { firstName: "Synthetic", lastName: `Acc${tag}`, email: `acc-${tag}-${suffix}@example.com` },
    });
    assert.equal(o.status, 201, o.raw);
    return o.json.offer.id as number;
  };
  const agentAcc = await call("POST", `/offers/${await mk(V.purchasePrice + 11, "agent")}/accept`, A.agent.cookie);
  assert.equal(agentAcc.status, 201, agentAcc.raw);
  assert.equal(agentAcc.json.transaction.purchasePriceCents, V.purchasePrice + 11);
  assert.deepEqual(agentAcc.json.transaction.financialVisibility, ALL);

  const crewAcc = await call("POST", `/offers/${await mk(V.purchasePrice + 12, "crew")}/accept`, crew.unassigned!.cookie);
  assert.equal(crewAcc.status, 201, crewAcc.raw);
  assert.deepEqual(crewAcc.json.transaction.financialVisibility, NONE);
  for (const k of ["purchasePriceCents", "depositCents", "grossCommissionCents", "gstCents", "fundsReceivedCents"]) {
    assert.equal(k in crewAcc.json.transaction, false, `crew accept: ${k} omitted`);
  }
  assert.equal(crewAcc.raw.includes(String(V.purchasePrice + 12)), false);
  assert.equal(crewAcc.raw.includes("3219871"), false, "deposit digits absent");
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
  const r = await call("GET", "/home/summary", crew.settle!.cookie);
  assert.equal(r.status, 200, r.raw);
  const item = (r.json.nextActions as Array<{ propertyId: number; label: string }>).find((i) => i.propertyId === propertyId);
  assert.equal(item?.label, "Offer received");
  assert.equal(r.raw.includes(shown), false);
  for (const who of [A.admin, A.agent]) {
    const rr = await call("GET", "/home/summary", who.cookie);
    const it = (rr.json.nextActions as Array<{ propertyId: number; label: string }>).find((i) => i.propertyId === propertyId);
    assert.equal(it?.label, `Offer received — ${shown}`);
  }
});
