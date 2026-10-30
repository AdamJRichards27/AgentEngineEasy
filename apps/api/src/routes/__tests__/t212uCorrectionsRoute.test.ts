// Owner t212u item 2: Brokerage Administrator audited correction of locked financial records.
// Reason AND supporting evidence (an evidence reference or upload metadata) are required; the
// 0044 correction path is used and an audit row is written. Non-BA 403, cross-tenant 404.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, desc, eq } from "drizzle-orm";
import { auditLogs, db, financialLedgerEvents } from "@aee/db";
import { cleanupBrokerages } from "./testSupport.js";
import { call, type World } from "./serviceFeeStatementFixtures.js";
import { dueDd, EVIDENCE, REASON, startWorld } from "./t212uCommon.js";

let server: Server;
let w: World;
let ledgerId: number;
const correct = (cookie: string, body: Record<string, unknown>) => call(w.baseUrl, "POST", "/financial/corrections", cookie, body);
const base = () => ({ table: "financial_ledger_events", id: ledgerId, patch: { reason: "Corrected description (synthetic)" }, reason: REASON, ...EVIDENCE });

before(async () => {
  ({ server, w } = await startWorld("T212uCorr"));
  const c = await dueDd(w, "Corr");
  const [ev] = await db.select().from(financialLedgerEvents).where(eq(financialLedgerEvents.brokerageId, w.X.brokerageId)).orderBy(desc(financialLedgerEvents.id)).limit(1);
  assert.ok(ev, "a ledger event exists");
  ledgerId = ev!.id;
  void c;
});
after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t212u item 2: audited correction route", { concurrency: false }, () => {
  test("the locked record is still refused by the database outside the correction path", async () => {
    await assert.rejects(db.update(financialLedgerEvents).set({ reason: "tamper" }).where(eq(financialLedgerEvents.id, ledgerId)), (e: unknown) => /finalised financial record|immutable/.test(String((e as { cause?: unknown }).cause ?? e)));
  });

  test("reason and evidence are both required", async () => {
    const noReason = await correct(w.X.admin.cookie, { ...base(), reason: " " });
    assert.equal(noReason.status, 400, noReason.raw);
    assert.equal(noReason.json.code, "CORRECTION_JUSTIFICATION_REQUIRED");
    const { evidenceRef: _e, ...noEvidence } = base();
    const ne = await correct(w.X.admin.cookie, noEvidence);
    assert.equal(ne.status, 400, ne.raw);
    assert.equal(ne.json.code, "CORRECTION_EVIDENCE_REQUIRED");
    const badUpload = await correct(w.X.admin.cookie, { ...noEvidence, evidenceUpload: { fileName: "x.pdf", sha256: "nothex", sizeBytes: 10 } });
    assert.equal(badUpload.status, 400, badUpload.raw);
    assert.equal(badUpload.json.code, "CORRECTION_EVIDENCE_REQUIRED");
  });

  test("Pit Crew and Agent get 403; another brokerage's BA gets 404; nothing changes", async () => {
    for (const who of [w.crew, w.X.agent]) assert.equal((await correct(who.cookie, base())).status, 403);
    const y = await correct(w.Y.admin.cookie, base());
    assert.equal(y.status, 404, y.raw);
    const [ev] = await db.select().from(financialLedgerEvents).where(eq(financialLedgerEvents.id, ledgerId));
    assert.notEqual(ev!.reason, "Corrected description (synthetic)");
    for (const who of [w.crew, w.X.agent]) assert.equal((await call(w.baseUrl, "GET", "/financial/corrections", who.cookie)).status, 403);
  });

  test("a BA corrects with reason + evidence reference: the record changes and one audit row records before/after, reason and evidence", async () => {
    const r = await correct(w.X.admin.cookie, base());
    assert.equal(r.status, 200, r.raw);
    const [ev] = await db.select().from(financialLedgerEvents).where(eq(financialLedgerEvents.id, ledgerId));
    assert.equal(ev!.reason, "Corrected description (synthetic)");
    const [a] = await db.select().from(auditLogs).where(and(eq(auditLogs.id, r.json.auditId)));
    assert.equal(a!.action, "financial_record_correction");
    assert.equal(a!.userId, w.X.admin.user.id);
    const v = JSON.parse(a!.updatedValue!);
    assert.equal(v.justification, REASON);
    assert.deepEqual(v.evidence, { kind: "reference", ref: EVIDENCE.evidenceRef });
    const list = await call(w.baseUrl, "GET", "/financial/corrections", w.X.admin.cookie);
    assert.equal(list.status, 200, list.raw);
    assert.ok(list.json.corrections.some((x: { auditId: number }) => x.auditId === r.json.auditId));
    const ylist = await call(w.baseUrl, "GET", "/financial/corrections", w.Y.admin.cookie);
    assert.ok(!ylist.json.corrections.some((x: { auditId: number }) => x.auditId === r.json.auditId), "tenant-scoped list");
  });

  test("upload metadata is accepted as evidence (name, sha256, size); disallowed columns are refused", async () => {
    const { evidenceRef: _e, ...noRef } = base();
    const sha = "a".repeat(64);
    const r = await correct(w.X.admin.cookie, { ...noRef, patch: { reason: "Second correction (synthetic)" }, evidenceUpload: { fileName: "bank-letter.pdf", sha256: sha, sizeBytes: 2048 } });
    assert.equal(r.status, 200, r.raw);
    const [a] = await db.select().from(auditLogs).where(eq(auditLogs.id, r.json.auditId));
    assert.deepEqual(JSON.parse(a!.updatedValue!).evidence, { kind: "upload", fileName: "bank-letter.pdf", sha256: sha, sizeBytes: 2048 });
    const bad = await correct(w.X.admin.cookie, { ...base(), patch: { brokerage_id: w.Y.brokerageId } });
    assert.equal(bad.status, 400, bad.raw);
    assert.equal(bad.json.code, "CORRECTION_COLUMN_NOT_ALLOWED");
  });
});
