// Owner t179u slice 3 (migration 0041): settlement confirmations + settlement
// statements (D1/D2, N4/N5/N8-N10). Synthetic data only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  commissionAgreements,
  commissionCalculations,
  db,
  documents,
  financialPaymentRequests,
  parties,
  pitCrewAssignments,
  riskExceptions,
  settlementStatementLines,
  settlementStatements,
  transactionFees,
  transactions,
  users,
} from "@aee/db";
import { cleanupBrokerages, createBrokerageWithUsers, createTransactionFromListedProperty, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const nameA = `Stmt A ${suffix}`;
type Who = DevLoginResult;
let A: { admin: Who; agent: Who; brokerageId: number };
let B: { admin: Who; agent: Who; brokerageId: number };
let admin2: Who;
let crew: Who;
let crewUnassigned: Who;
let otherAgent: Who;

async function call(method: "GET" | "POST", path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: body !== undefined ? { cookie, "content-type": "application/json" } : { cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  return { status: res.status, raw, json: raw ? (JSON.parse(raw) as Record<string, any>) : {} };
}
async function inA(name: string, role: string) {
  const r = await devLogin(baseUrl, { email: `${name}-${suffix}@example.com`, firstName: name, lastName: "Synthetic", brokerageName: nameA });
  await db.update(users).set({ role }).where(eq(users.id, r.user.id));
  return r;
}

interface Fixture {
  transactionId: number;
  propertyId: number;
  buyerRep: number;
  sellerRep: number;
  docId: number;
  calcId: number;
  paymentRequestId: number;
}
/** A settled transaction with recorded solicitors, a FINALISED commission calculation and a calculated PC fee charged to the listing agent. */
async function fixture(label: string, opts: { settled?: boolean } = {}): Promise<Fixture> {
  const t = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} ${label} St` });
  const [buyerRep, sellerRep] = await db
    .insert(parties)
    .values([
      { brokerageId: A.brokerageId, partyType: "Organisation", organisationName: `Buyer Solicitors ${label} (synthetic)` },
      { brokerageId: A.brokerageId, partyType: "Organisation", organisationName: `Seller Solicitors ${label} (synthetic)` },
    ])
    .returning({ id: parties.id });
  await db
    .update(transactions)
    .set({
      legalRepresentatives: { buyerSolicitorPartyId: buyerRep!.id, sellerSolicitorPartyId: sellerRep!.id },
      unconditionalAt: new Date(Date.now() - 20 * 86_400_000),
      ...(opts.settled === false ? {} : { status: "Settled", settlementCompletedAt: new Date(Date.now() - 86_400_000) }),
    })
    .where(eq(transactions.id, t.transactionId));
  const [doc] = await db.insert(documents).values({ propertyId: t.propertyId, documentType: "SettlementConfirmation", title: "Synthetic settlement confirmation letter" }).returning({ id: documents.id });
  const [agreement] = await db
    .insert(commissionAgreements)
    .values({ brokerageId: A.brokerageId, propertyId: t.propertyId, transactionId: t.transactionId, method: "PERCENTAGE", rateBps: 200, status: "APPROVED" } as never)
    .returning({ id: commissionAgreements.id });
  const [calc] = await db
    .insert(commissionCalculations)
    .values({
      brokerageId: A.brokerageId,
      propertyId: t.propertyId,
      transactionId: t.transactionId,
      commissionAgreementId: agreement!.id,
      state: "FINALISED",
      salePriceCentsInput: 100_000_000,
      methodUsed: "PERCENTAGE",
      rateBpsUsed: 200,
      grossCommissionCents: 2_000_000,
      commissionExGstCents: 2_000_000,
      gstCents: 200_000,
      finalisedAt: new Date(),
    })
    .returning({ id: commissionCalculations.id });
  const [pr] = await db
    .insert(financialPaymentRequests)
    .values({ brokerageId: A.brokerageId, propertyId: t.propertyId, transactionId: t.transactionId, kind: "PC_SUCCESS_FEE", status: "CALCULATED", amountCents: 110_000, payerUserId: A.agent.user.id })
    .returning({ id: financialPaymentRequests.id });
  const [ex] = await db
    .insert(riskExceptions)
    .values({
      brokerageId: A.brokerageId,
      propertyId: t.propertyId,
      transactionId: t.transactionId,
      ruleId: "stmt-test-rule",
      category: "FINANCIAL",
      severity: "MEDIUM",
      status: "OPEN",
      title: `Synthetic statement work ${label}`,
      problemDescription: "Synthetic fixture.",
      businessImpact: "Synthetic fixture.",
      detectedCause: "Synthetic fixture.",
      recommendedAction: "Synthetic fixture.",
      resolutionRequirements: "Synthetic fixture.",
      sourceRecordType: "TEST_FIXTURE",
      sourceRecordId: `stmt-${t.transactionId}-${suffix}`,
      correlationId: randomUUID(),
      dedupKey: `stmt-${t.transactionId}-${suffix}`,
      openDedupKey: `stmt-${t.transactionId}-${suffix}`,
    })
    .returning({ id: riskExceptions.id });
  await db.insert(pitCrewAssignments).values({ brokerageId: A.brokerageId, sourceType: "EXCEPTION", sourceRecordId: ex!.id, propertyId: t.propertyId, status: "IN_PROGRESS", assignedToUserId: crew.user.id, version: 1 });
  return { ...t, buyerRep: buyerRep!.id, sellerRep: sellerRep!.id, docId: doc!.id, calcId: calc!.id, paymentRequestId: pr!.id };
}
const confirm = (who: Who, f: Fixture, side: "BUYER" | "SELLER", extra: Record<string, unknown> = {}) =>
  call("POST", "/financial/settlement-confirmations", who.cookie, {
    transactionId: f.transactionId,
    side,
    representativePartyId: side === "BUYER" ? f.buyerRep : f.sellerRep,
    evidenceDocumentId: f.docId,
    confirmedAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...extra,
  });
const prepare = (who: Who, f: Fixture, extra: Record<string, unknown> = {}) =>
  call("POST", "/financial/settlement-statements/prepare", who.cookie, { transactionId: f.transactionId, payerType: "Agent", payerUserId: A.agent.user.id, ...extra });
const immutable = (err: unknown) => {
  const e = err as { message?: string; cause?: { message?: string } };
  assert.match(`${e.message} ${e.cause?.message ?? ""}`, /immutable/);
  return true;
};
const issue = (who: Who, id: number) => call("POST", `/financial/settlement-statements/${id}/issue`, who.cookie, {});

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
  B = await createBrokerageWithUsers(baseUrl, `Stmt B ${suffix}`);
  admin2 = await inA("admin2", "Brokerage Administrator");
  crew = await inA("crew", "Pit Crew");
  crewUnassigned = await inA("crew2", "Pit Crew");
  otherAgent = await inA("agent2", "Agent");
});

after(async () => {
  await cleanupBrokerages([A, B].map((t) => t?.brokerageId).filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("confirmations (N4/N5): recorded representative only, evidence required, one per side, explicit supersede; actors limited to D1", async () => {
  const f = await fixture("Confirm");
  assert.equal((await confirm(crew, f, "BUYER", { representativePartyId: f.sellerRep })).json.reason, "REPRESENTATIVE_MISMATCH");
  assert.equal((await confirm(crew, f, "BUYER", { evidenceDocumentId: undefined })).json.reason, "CONFIRMATION_EVIDENCE_REQUIRED");
  assert.equal((await confirm(crew, f, "BUYER", { evidenceDocumentId: undefined, evidenceNote: "   " })).json.reason, "CONFIRMATION_EVIDENCE_REQUIRED");
  assert.equal((await confirm(crew, f, "BUYER", { confirmedAt: new Date(Date.now() + 86_400_000).toISOString() })).json.reason, "CONFIRMED_AT_IN_FUTURE");
  assert.equal((await confirm(crewUnassigned, f, "BUYER")).status, 403);
  assert.equal((await confirm(otherAgent, f, "BUYER")).status, 404);
  assert.equal((await confirm(B.admin, f, "BUYER")).status, 404);
  const c1 = await confirm(crew, f, "BUYER");
  assert.equal(c1.status, 201, c1.raw);
  assert.equal((await confirm(A.agent, f, "BUYER")).json.reason, "CONFIRMATION_EXISTS");
  const c2 = await confirm(A.agent, f, "BUYER", { evidenceDocumentId: undefined, evidenceNote: "Buyer's solicitor emailed written confirmation of settlement (synthetic)", supersedesId: c1.json.confirmation.id });
  assert.equal(c2.status, 201, c2.raw);
  const list = await call("GET", `/financial/settlement-confirmations?transactionId=${f.transactionId}`, A.admin.cookie);
  assert.deepEqual(list.json.confirmations.map((c: { status: string }) => c.status), ["SUPERSEDED", "ACTIVE"]);
  const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "settlement_confirmation"), eq(auditLogs.recordId, String(c2.json.confirmation.id))));
  assert.equal(audits[0]?.action, "settlement_confirmation_superseded");
  // No representative recorded -> refuse.
  await db.update(transactions).set({ legalRepresentatives: null }).where(eq(transactions.id, f.transactionId));
  assert.equal((await confirm(crew, f, "SELLER")).json.reason, "REPRESENTATIVE_NOT_RECORDED");
});

test("D1/D2: assigned Pit Crew prepares and issues once settlement is complete and both written confirmations are on file; lines derived server-side; audit", async () => {
  const f = await fixture("Issue");
  const draft = await prepare(crew, f);
  assert.equal(draft.status, 201, draft.raw);
  const st = draft.json.statement;
  assert.equal(st.status, "DRAFT");
  assert.deepEqual(draft.json.issues, []);
  assert.deepEqual(draft.json.lines.map((l: { kind: string }) => l.kind), ["COMMISSION", "COMMISSION_GST", "PC_SERVICE_FEE"]);
  assert.equal(st.creditsCents, 2_200_000);
  assert.equal(st.debitsCents, 110_000);
  assert.equal(st.netCents, 2_090_000);
  assert.equal(st.pcServiceFeeCents, 110_000);
  // Confirmations outstanding.
  assert.equal((await issue(crew, st.id)).json.reason, "SETTLEMENT_CONFIRMATIONS_INCOMPLETE");
  await confirm(crew, f, "BUYER");
  const one = await issue(crew, st.id);
  assert.equal(one.json.reason, "SETTLEMENT_CONFIRMATIONS_INCOMPLETE");
  assert.match(one.json.error, /SELLER/);
  await confirm(crew, f, "SELLER");
  assert.equal((await issue(crewUnassigned, st.id)).status, 403);
  assert.equal((await issue(otherAgent, st.id)).status, 404);
  assert.equal((await issue(B.admin, st.id)).status, 404);
  const ok = await issue(crew, st.id);
  assert.equal(ok.status, 200, ok.raw);
  assert.equal(ok.json.statement.status, "ISSUED");
  assert.equal(ok.json.statement.issuedByUserId, crew.user.id);
  assert.ok(ok.json.statement.buyerConfirmationId && ok.json.statement.sellerConfirmationId);
  assert.equal((await issue(crew, st.id)).json.reason, "STATEMENT_NOT_DRAFT");
  const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "settlement_statement"), eq(auditLogs.recordId, String(st.id))));
  assert.deepEqual(audits.map((a) => a.action).sort(), ["settlement_statement_issued", "settlement_statement_prepared"]);
  const issuedAudit = JSON.parse(audits.find((a) => a.action === "settlement_statement_issued")!.updatedValue!);
  assert.equal(issuedAudit.policy, "t179u");
  assert.equal(issuedAudit.basis, "assigned_pit_crew");
  // Reads: listing agent + assigned Pit Crew + BA; others 404.
  for (const who of [A.admin, A.agent, crew]) assert.equal((await call("GET", `/financial/settlement-statements?transactionId=${f.transactionId}`, who.cookie)).status, 200);
  for (const who of [otherAgent, crewUnassigned, B.admin]) assert.equal((await call("GET", `/financial/settlement-statements?transactionId=${f.transactionId}`, who.cookie)).status, 404);
  const read = await call("GET", `/financial/settlement-statements?transactionId=${f.transactionId}`, A.agent.cookie);
  assert.equal(read.json.statements[0].lines.length, 3);
  // Only a BA can supersede (N9), with a reason.
  assert.equal((await prepare(crew, f)).json.reason, "STATEMENT_SUPERSEDE_FORBIDDEN");
  assert.equal((await prepare(A.agent, f)).json.reason, "STATEMENT_SUPERSEDE_FORBIDDEN");
  assert.equal((await prepare(A.admin, f)).json.reason, "SUPERSEDE_REASON_REQUIRED");
});

test("issue is refused before settlement, on validation issues, on stale lines and on a payer that does not match the PC fee request", async () => {
  const f = await fixture("Refuse", { settled: false });
  await confirm(A.agent, f, "BUYER");
  await confirm(A.agent, f, "SELLER");
  const d = await prepare(A.agent, f);
  assert.equal((await issue(A.agent, d.json.statement.id)).json.reason, "SETTLEMENT_NOT_COMPLETE");
  await db.update(transactions).set({ status: "Settled", settlementCompletedAt: new Date() }).where(eq(transactions.id, f.transactionId));

  // A DRAFT fee is a validation issue (fail closed).
  await db.insert(transactionFees).values({ brokerageId: A.brokerageId, propertyId: f.propertyId, transactionId: f.transactionId, kind: "DEDUCTION", description: "Courier (synthetic)", amountCents: 5_000, createdByUserId: A.admin.user.id });
  const d2 = await prepare(A.agent, f);
  assert.deepEqual(d2.json.issues, ["FEES_PENDING_APPROVAL"]);
  assert.equal(d2.json.statement.id, d.json.statement.id, "regenerating keeps the single draft");
  assert.equal((await issue(A.agent, d2.json.statement.id)).json.reason, "STATEMENT_VALIDATION_FAILED");
  await db.update(transactionFees).set({ status: "APPROVED", approvedByUserId: admin2.user.id, approvedAt: new Date() }).where(eq(transactionFees.transactionId, f.transactionId));
  // Source changed after preparing -> stale.
  assert.equal((await issue(A.agent, d2.json.statement.id)).json.reason, "STATEMENT_LINES_STALE");
  const d3 = await prepare(A.agent, f);
  assert.deepEqual(d3.json.issues, []);
  assert.ok(d3.json.lines.some((l: { kind: string }) => l.kind === "DEDUCTION"));
  // Payer must match the PC fee request's payer.
  const wrong = await prepare(A.agent, f, { payerType: "Brokerage", payerUserId: undefined });
  assert.equal((await issue(A.agent, wrong.json.statement.id)).json.reason, "STATEMENT_PAYER_MISMATCH");
  assert.equal((await prepare(A.agent, f, { payerUserId: crew.user.id })).json.reason, "PAYER_INVALID");
  const right = await prepare(A.agent, f);
  // Commission not finalised -> refused.
  await db.update(commissionCalculations).set({ state: "SUPERSEDED" }).where(eq(commissionCalculations.id, f.calcId));
  const d4 = await prepare(A.agent, f);
  assert.ok(d4.json.issues.includes("COMMISSION_NOT_FINALISED"));
  assert.equal((await issue(A.agent, d4.json.statement.id)).json.reason, "STATEMENT_VALIDATION_FAILED");
  await db.update(commissionCalculations).set({ state: "FINALISED" }).where(eq(commissionCalculations.id, f.calcId));
  // PC fee disputed -> refused.
  await db.update(financialPaymentRequests).set({ status: "DISPUTED" }).where(eq(financialPaymentRequests.id, f.paymentRequestId));
  const d5 = await prepare(A.agent, f);
  assert.ok(d5.json.issues.includes("PC_FEE_DISPUTED"));
  await db.update(financialPaymentRequests).set({ status: "CALCULATED" }).where(eq(financialPaymentRequests.id, f.paymentRequestId));
  const d6 = await prepare(A.agent, f);
  const ok = await issue(A.agent, d6.json.statement.id);
  assert.equal(ok.status, 200, ok.raw);
  assert.ok(right.json.statement.id);
});

test("issued statements are immutable (DB trigger); a BA correction is a new version that supersedes the issued one", async () => {
  const f = await fixture("Supersede");
  await confirm(crew, f, "BUYER");
  await confirm(crew, f, "SELLER");
  const d = await prepare(crew, f);
  const v1 = (await issue(crew, d.json.statement.id)).json.statement;
  assert.equal(v1.status, "ISSUED");
  await assert.rejects(db.update(settlementStatements).set({ netCents: 1, creditsCents: 1, debitsCents: 0 }).where(eq(settlementStatements.id, v1.id)), immutable);
  await assert.rejects(db.update(settlementStatements).set({ status: "DRAFT", issuedAt: null, issuedByUserId: null }).where(eq(settlementStatements.id, v1.id)), immutable);
  const [line] = await db.select().from(settlementStatementLines).where(eq(settlementStatementLines.statementId, v1.id)).limit(1);
  await assert.rejects(db.update(settlementStatementLines).set({ amountCents: 1 }).where(eq(settlementStatementLines.id, line!.id)), immutable);
  await assert.rejects(
    db.insert(settlementStatementLines).values({ statementId: v1.id, lineNo: 99, kind: "MARKETING", effect: "DEBIT", description: "sneaky", amountCents: 1, sourceType: "x", sourceId: "1" }),
    immutable,
  );
  // DB backstop: a second ISSUED for the same transaction cannot exist.
  await assert.rejects(db.execute(sql`insert into settlement_statements (brokerage_id, property_id, transaction_id, version, status, payer_type, payer_brokerage_id, lines_fingerprint, prepared_by_user_id, issued_by_user_id, issued_at, buyer_confirmation_id, seller_confirmation_id) values (${A.brokerageId}, ${f.propertyId}, ${f.transactionId}, 50, 'ISSUED', 'Brokerage', ${A.brokerageId}, 'x', ${A.admin.user.id}, ${A.admin.user.id}, now(), ${v1.buyerConfirmationId}, ${v1.sellerConfirmationId})`));

  await db.insert(transactionFees).values({ brokerageId: A.brokerageId, propertyId: f.propertyId, transactionId: f.transactionId, kind: "SETTLEMENT_FEE", description: "Settlement agent fee (synthetic)", amountCents: 20_000, gstCents: 2_000, status: "APPROVED", createdByUserId: A.admin.user.id, approvedByUserId: admin2.user.id, approvedAt: new Date() });
  const v2d = await prepare(A.admin, f, { supersedeReason: "Settlement agent fee omitted from v1" });
  assert.equal(v2d.status, 201, v2d.raw);
  assert.equal(v2d.json.statement.version, 2);
  assert.equal(v2d.json.statement.supersedesId, v1.id);
  assert.equal(v2d.json.statement.debitsCents, 132_000);
  assert.equal((await issue(crew, v2d.json.statement.id)).json.reason, "STATEMENT_SUPERSEDE_FORBIDDEN");
  const v2 = await issue(A.admin, v2d.json.statement.id);
  assert.equal(v2.status, 200, v2.raw);
  assert.equal(v2.json.superseded.id, v1.id);
  const rows = await db.select().from(settlementStatements).where(eq(settlementStatements.transactionId, f.transactionId)).orderBy(settlementStatements.version);
  assert.deepEqual(rows.map((r) => [r.version, r.status]), [[1, "SUPERSEDED"], [2, "ISSUED"]]);
  assert.equal(rows[0]!.netCents, v1.netCents, "superseded version keeps its figures");
  const sup = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "settlement_statement_superseded"), eq(auditLogs.recordId, String(v1.id))));
  assert.equal(JSON.parse(sup[0]!.updatedValue!).reason, "Settlement agent fee omitted from v1");
});
