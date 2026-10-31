// Owner t212u item 1: Pit Crew may initiate a collection REQUEST but never execute a payment.
// The request is recorded; the authorised payment workflow (system identity) independently
// re-validates settlement, written authority, fee eligibility and collection timing before any
// provider call. Sandbox provider only.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, financialPaymentRequests, pcFeeCollectionRequests, transactions } from "@aee/db";
import { executeCollectionRequest, requestServiceFeeCollection } from "../../lib/financial/collectionRequests.js";
import { cleanupBrokerages } from "./testSupport.js";
import { call, collect, request, type World } from "./serviceFeeStatementFixtures.js";
import { dueDd, sendsDuring, startWorld } from "./t212uCommon.js";

const here = dirname(fileURLToPath(import.meta.url));
let server: Server;
let w: World;
const crewCaller = () => ({ id: w.crew.user.id, role: "Pit Crew", brokerageId: w.X.brokerageId });
const rowsFor = (requestId: number) => db.select().from(pcFeeCollectionRequests).where(eq(pcFeeCollectionRequests.paymentRequestId, requestId));

before(async () => ({ server, w } = await startWorld("T212uReq")));
after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t212u item 1: Pit Crew requests; the authorised workflow executes", { concurrency: false }, () => {
  test("a Pit Crew collect records a request (requested by Pit Crew) and the system workflow executes it after re-validation", async () => {
    const c = await dueDd(w, "ReqOk");
    const { result: r, sends } = await sendsDuring(() => collect(w, w.crew, c));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(sends, 1);
    const rows = await rowsFor(c.requestId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.requestedByUserId, w.crew.user.id);
    assert.equal(rows[0]!.requestedByRole, "Pit Crew");
    assert.equal(rows[0]!.status, "EXECUTED");
    assert.equal(rows[0]!.executedBy, "SYSTEM_PAYMENT_WORKFLOW");
    assert.equal((await request(c.requestId)).status, "DEBIT_SCHEDULED");
  });

  test("recording a request never calls the provider", async () => {
    const c = await dueDd(w, "ReqOnly");
    const { result, sends } = await sendsDuring(() => requestServiceFeeCollection(crewCaller(), c.transactionId));
    assert.equal(sends, 0);
    assert.equal(result.status, "PENDING");
    assert.equal((await request(c.requestId)).status, "NOTICE_SENT");
  });

  const gates: [string, (c: Awaited<ReturnType<typeof dueDd>>) => Promise<void>][] = [
    ["settlement no longer confirmed", async (c) => { await db.update(transactions).set({ settlementCompletedAt: null }).where(eq(transactions.id, c.transactionId)); }],
    ["written authority revoked", async (c) => {
      const [pr] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, c.requestId));
      const rv = await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${pr!.pcFeeAuthorityId}/revoke`, w.X.admin.cookie, { reason: "Synthetic revoke" });
      assert.equal(rv.status, 200, rv.raw);
    }],
    ["fee no longer eligible (amount differs from the finalised fee)", async (c) => { await db.update(financialPaymentRequests).set({ amountCents: c.amountCents + 1 }).where(eq(financialPaymentRequests.id, c.requestId)); }],
    ["collection timing (notice period restarted, not elapsed)", async (c) => { await db.update(financialPaymentRequests).set({ noticeSentAt: new Date() }).where(eq(financialPaymentRequests.id, c.requestId)); }],
  ];
  for (const [name, breakGate] of gates) {
    test(`a recorded Pit Crew request cannot reach the provider when a gate fails at execution: ${name}`, async () => {
      const c = await dueDd(w, `Gate${name.slice(0, 6).replace(/\W/g, "")}`);
      const rec = await requestServiceFeeCollection(crewCaller(), c.transactionId);
      await breakGate(c);
      const { result, sends } = await sendsDuring(() => executeCollectionRequest(rec.id));
      assert.equal(sends, 0, "no provider call");
      assert.equal(result.status, "REFUSED", JSON.stringify(result));
      assert.ok(result.code, "refusal code recorded");
      const [row] = await db.select().from(pcFeeCollectionRequests).where(eq(pcFeeCollectionRequests.id, rec.id));
      assert.equal(row!.status, "REFUSED");
      assert.equal(row!.refusalCode, result.code);
      assert.notEqual((await request(c.requestId)).status, "DEBIT_SCHEDULED");
    });
  }

  test("a request executes once: duplicate requests reuse the open one; re-executing is a no-op", async () => {
    const c = await dueDd(w, "ReqDup");
    const a = await requestServiceFeeCollection(crewCaller(), c.transactionId);
    const b = await requestServiceFeeCollection(crewCaller(), c.transactionId);
    assert.equal(a.id, b.id);
    const first = await sendsDuring(() => executeCollectionRequest(a.id));
    const second = await sendsDuring(() => executeCollectionRequest(a.id));
    assert.equal(first.sends + second.sends, 1);
    assert.equal(second.result.status, "EXECUTED");
    assert.equal((await db.select().from(pcFeeCollectionRequests).where(and(eq(pcFeeCollectionRequests.paymentRequestId, c.requestId)))).length, 1);
  });

  test("static: no Pit Crew path calls the provider directly", () => {
    const pc = readFileSync(join(here, "../../lib/pitCrewServiceFee.ts"), "utf8");
    for (const forbidden of ["scheduleDebitForPaymentRequest", "chargeServiceFeeStoredCard", "mandatePaymentProvider", "paymentProvider", "dispatchOutboxEntry"]) {
      assert.ok(!pc.includes(forbidden), `pitCrewServiceFee.ts must not reference ${forbidden}`);
    }
    const route = readFileSync(join(here, "../payments.ts"), "utf8");
    const collectRoute = route.slice(route.indexOf('"/pit-crew-service-fee/:transactionId/collect"'), route.indexOf('"/service-orders/:id/payments"'));
    for (const forbidden of ["scheduleDebit", "chargeServiceFeeStoredCard", "mandatePaymentProvider", "executeCollectionRequest"]) {
      assert.ok(!collectRoute.includes(forbidden), `collect route must not reference ${forbidden}`);
    }
    const exec = readFileSync(join(here, "../../lib/financial/collectionRequests.ts"), "utf8");
    assert.match(exec, /role: "System"/, "execution runs under the system identity");
  });
});
