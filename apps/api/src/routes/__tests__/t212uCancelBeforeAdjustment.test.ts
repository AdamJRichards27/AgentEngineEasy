// Owner t212u item 4: waiving or writing off a debit with pending provider retries requires a
// CONFIRMED provider cancellation (sandbox cancel API with a confirmed status). Unconfirmed or
// error -> the hold stays and is escalated (audit row + an OPEN exception visible to BAs).
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, financialReconciliationExceptions } from "@aee/db";
import { mandatePaymentProvider } from "../../lib/financial/provider.js";
import { cleanupBrokerages } from "./testSupport.js";
import { call, request, type World } from "./serviceFeeStatementFixtures.js";
import { outboxOf, REASON, retryingDd, sandbox, startWorld } from "./t212uCommon.js";

let server: Server;
let w: World;
const body = { reason: REASON, evidenceNote: "Synthetic evidence note" };
const act = (action: string, requestId: number) => call(w.baseUrl, "POST", `/financial/payment-requests/${requestId}/${action}`, w.X.admin.cookie, body);
const exceptionsFor = (requestId: number) => db.select().from(financialReconciliationExceptions).where(eq(financialReconciliationExceptions.paymentRequestId, requestId));

before(async () => ({ server, w } = await startWorld("T212uCancel")));
after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t212u item 4: confirmed provider cancellation before waiver / write-off", { concurrency: false }, () => {
  test("the provider interface exposes a cancel-retries call with a confirmed status (sandbox)", () => {
    assert.equal(typeof mandatePaymentProvider.cancelPendingRetries, "function");
  });

  for (const action of ["waive", "write-off"] as const) {
    test(`${action}: confirmed cancellation (with an idempotency key) -> the adjustment proceeds`, async () => {
      const s = await retryingDd(w, `Conf${action}`);
      const spy = mock.method(mandatePaymentProvider, "cancelPendingRetries");
      try {
        const r = await act(action, s.c.requestId);
        assert.equal(r.status, 200, r.raw);
        assert.equal(spy.mock.callCount(), 1);
        const [ref, opts] = spy.mock.calls[0]!.arguments as [string, { idempotencyKey: string }];
        assert.equal(ref, s.ref);
        assert.match(opts.idempotencyKey, /^cancel-retries:/);
      } finally {
        spy.mock.restore();
      }
      assert.equal((await request(s.c.requestId)).status, action === "waive" ? "WAIVED" : "WRITTEN_OFF");
      const [o] = await outboxOf(s.c.requestId);
      assert.equal(o!.status, "CANCELLED", "the provider-confirmed cancellation closes the dispatched debit");
      const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "provider_retry_cancellation_confirmed"), eq(auditLogs.recordId, String(s.c.requestId))));
      assert.equal(audits.length, 1);
    });
  }

  for (const outcome of ["unconfirmed", "error"] as const) {
    test(`cancellation ${outcome}: hold kept (still RETRY_SCHEDULED), escalated with an audit row and an OPEN exception visible to BAs`, async () => {
      const s = await retryingDd(w, `Unconf${outcome}`);
      sandbox().simulateCancellation(s.ref, outcome);
      const r = await act("waive", s.c.requestId);
      assert.equal(r.status, 409, r.raw);
      assert.equal(r.json.code, "RECOVERY_CANCELLATION_UNCONFIRMED");
      assert.equal((await request(s.c.requestId)).status, "RETRY_SCHEDULED");
      assert.equal((await outboxOf(s.c.requestId))[0]!.status, "DISPATCHED");
      const ex = await exceptionsFor(s.c.requestId);
      assert.equal(ex.length, 1);
      assert.equal(ex[0]!.kind, "CANCELLATION_UNCONFIRMED");
      assert.equal(ex[0]!.status, "OPEN");
      const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "provider_retry_cancellation_unconfirmed"), eq(auditLogs.recordId, String(s.c.requestId))));
      assert.equal(audits.length, 1);
      const list = await call(w.baseUrl, "GET", "/financial/reconciliation-exceptions?status=OPEN", w.X.admin.cookie);
      assert.ok(list.json.exceptions.some((e: { id: number; kind: string }) => e.id === ex[0]!.id && e.kind === "CANCELLATION_UNCONFIRMED"));
      // A second attempt does not open a duplicate exception.
      assert.equal((await act("write-off", s.c.requestId)).status, 409);
      assert.equal((await exceptionsFor(s.c.requestId)).length, 1);
    });
  }
});
