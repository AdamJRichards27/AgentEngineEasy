// Owner t181u(B): notice-period collection scheduler for the Pit Crew service
// fee. A system-initiated tick that collects ONLY fees under an issued
// statement and a valid authority whose notice period has passed (or a card
// retry whose backoff is due), re-gating everything at run time through the
// same collectPitCrewServiceFee workflow. Idempotent and advisory-lock safe;
// mock/sandbox providers only (fail closed otherwise); UNKNOWN/PROCESSING
// never picked. Registered in index.ts OFF by default
// (PC_FEE_COLLECTION_SCHEDULER_ENABLED, never set anywhere); no HTTP route,
// so Pit Crew can never trigger a payment through it. Synthetic data.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, financialCardCharges, financialPaymentOutbox, pcFeeAuthorities } from "@aee/db";
import { paymentProvider } from "../../lib/paymentProvider.js";
import { mandatePaymentProvider } from "../../lib/financial/provider.js";
import { cleanupBrokerages } from "./testSupport.js";
import {
  activeDebitAuthority,
  cardAuthorityViaApi,
  collect,
  confirmBoth,
  elapseNotice,
  elapseRetry,
  feeChain,
  makeWorld,
  prepareAndIssue,
  request,
  saveCard,
  type Chain,
  type World,
} from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, "..", "..");
let server: Server;
let w: World;
const sched = () => import("../../lib/financial/serviceFeeScheduler.js");
const charges = (c: Chain) => db.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, c.requestId)).orderBy(financialCardCharges.attemptNo);
const outbox = (c: Chain) => db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, c.requestId));
const tick = async (extra: Record<string, unknown> = {}) => (await sched()).runServiceFeeCollectionTick({ brokerageIds: [w.X.brokerageId], ...extra });

async function issued(authorityId: number, tag: string): Promise<Chain> {
  const c = await feeChain(w, authorityId, tag);
  await confirmBoth(w, c);
  const iss = await prepareAndIssue(w, w.crew, c);
  assert.equal(iss.status, 200, iss.raw);
  assert.equal(iss.json.collection?.outcome, "notice_started", JSON.stringify(iss.json.collection));
  return c;
}
async function cardAuthority() {
  const card = await saveCard("Agent", w.X.agent.user.id);
  const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
  assert.equal(a.activated.status, 200, a.activated.raw);
  return a.id;
}
function spyCharges(script?: Array<"Succeeded" | "Failed" | "throw">) {
  const original = paymentProvider.chargeStoredMethod.bind(paymentProvider);
  let i = 0;
  return mock.method(paymentProvider, "chargeStoredMethod", async (input: Parameters<typeof original>[0]) => {
    const step = script?.[i++];
    if (step === "Failed") return { providerChargeRef: `mock-failed-${input.idempotencyKey}`, status: "Failed" as const, failureReason: "card_declined" };
    if (step === "throw") throw new Error("network timeout");
    return original(input);
  });
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "Sched");
});

after(async () => {
  (await sched().catch(() => null))?.stopServiceFeeCollectionScheduler();
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t181u(B): notice-period collection scheduler", { concurrency: false }, () => {
  test("OFF by default: register starts nothing unless NODE_ENV != test AND PC_FEE_COLLECTION_SCHEDULER_ENABLED === 'true'", async () => {
    const s = await sched();
    const origNodeEnv = process.env.NODE_ENV;
    const origFlag = process.env.PC_FEE_COLLECTION_SCHEDULER_ENABLED;
    const timers = mock.method(globalThis, "setInterval");
    try {
      for (const [nodeEnv, flag] of [
        ["test", undefined],
        ["test", "true"],
        ["production", undefined],
        ["production", "false"],
        ["production", "1"],
        ["production", "TRUE"],
        ["development", ""],
      ] as Array<[string, string | undefined]>) {
        process.env.NODE_ENV = nodeEnv;
        if (flag === undefined) delete process.env.PC_FEE_COLLECTION_SCHEDULER_ENABLED;
        else process.env.PC_FEE_COLLECTION_SCHEDULER_ENABLED = flag;
        s.registerServiceFeeCollectionScheduler();
        assert.equal(s.serviceFeeCollectionSchedulerActive(), false, `NODE_ENV=${nodeEnv} flag=${flag}`);
      }
      assert.equal(timers.mock.callCount(), 0, "no interval timer is ever created while disabled");
    } finally {
      timers.mock.restore();
      if (origNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = origNodeEnv;
      if (origFlag === undefined) delete process.env.PC_FEE_COLLECTION_SCHEDULER_ENABLED;
      else process.env.PC_FEE_COLLECTION_SCHEDULER_ENABLED = origFlag;
    }
    // The detector works: an explicit start is visible and stop clears it.
    s.registerServiceFeeCollectionScheduler({ startScheduler: true, intervalMs: 3_600_000 });
    assert.equal(s.serviceFeeCollectionSchedulerActive(), true);
    s.stopServiceFeeCollectionScheduler();
    assert.equal(s.serviceFeeCollectionSchedulerActive(), false);
  });

  test("disabled does nothing: a due fee is untouched while the scheduler is registered but disabled", async () => {
    const s = await sched();
    const dd = await activeDebitAuthority(w);
    const c = await issued(dd.id, "SchedOff");
    await elapseNotice(c);
    delete process.env.PC_FEE_COLLECTION_SCHEDULER_ENABLED;
    s.registerServiceFeeCollectionScheduler({ intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.serviceFeeCollectionSchedulerActive(), false);
    assert.equal((await request(c.requestId)).status, "NOTICE_SENT");
    assert.equal((await outbox(c)).length, 0, "no debit while disabled");
  });

  test("index.ts: exactly one registration line next to the refund reconciler; flag is set nowhere in the repo config", () => {
    const index = readFileSync(join(apiSrc, "index.ts"), "utf8");
    const calls = index.split("\n").filter((l) => l.includes("registerServiceFeeCollectionScheduler("));
    assert.equal(calls.length, 1, calls.join("\n"));
    assert.ok(calls[0]!.includes(".registerServiceFeeCollectionScheduler())"), "registered with no options (env-gated, OFF by default)");
    const lines = index.split("\n");
    const at = lines.findIndex((l) => l.includes("registerServiceFeeCollectionScheduler("));
    assert.ok(lines.slice(Math.max(0, at - 3), at + 3).some((l) => l.includes("registerPaymentRefundReconciler(")), "next to the refund reconciler");
    assert.ok(!index.includes("PC_FEE_COLLECTION_SCHEDULER_ENABLED"), "index.ts never enables it");
  });

  test("no HTTP route: no route module imports the scheduler (Pit Crew cannot trigger it)", () => {
    const routesDir = join(apiSrc, "routes");
    for (const f of readdirSync(routesDir).filter((n) => n.endsWith(".ts"))) {
      assert.ok(!readFileSync(join(routesDir, f), "utf8").includes("serviceFeeScheduler"), f);
    }
    assert.ok(!readFileSync(join(apiSrc, "app.ts"), "utf8").includes("serviceFeeScheduler"));
  });

  test("tick collects only due fees: elapsed DD notice -> one debit; running notice, UNKNOWN and not-due retries untouched; idempotent", async () => {
    // Activate the card authority FIRST. Activation marks one prior ACTIVE authority for the agent as
    // REPLACED (priorActiveRows[0], unordered). If the fixture-made debit authority below already
    // existed alongside the one left ACTIVE by the "disabled does nothing" test, which of the two
    // got replaced depended on row order, and the due fee was intermittently refused with
    // SERVICE_FEE_AUTHORITY_INVALID. Created afterwards, the debit authority is never replaced here.
    const cardId = await cardAuthority();
    const dd = await activeDebitAuthority(w);
    const due = await issued(dd.id, "SchedDue");
    await elapseNotice(due);
    const running = await issued(dd.id, "SchedRunning");
    const unknown = await issued(cardId, "SchedUnknown");
    await elapseNotice(unknown);
    const notDue = await issued(cardId, "SchedNotDue");
    await elapseNotice(notDue);
    const spy = spyCharges(["throw", "Failed"]);
    try {
      assert.equal((await collect(w, w.crew, unknown)).json.outcome, "card_outcome_unknown");
      assert.equal((await collect(w, w.crew, notDue)).json.outcome, "card_failed_retry_scheduled");
    } finally {
      spy.mock.restore();
    }
    const spy2 = spyCharges();
    try {
      const r1 = await tick();
      assert.equal(r1.skipped, undefined, JSON.stringify(r1));
      assert.ok(r1.results.some((x) => x.paymentRequestId === due.requestId && (x.outcome === "debit_scheduled" || x.outcome === "debit_queued")), JSON.stringify(r1));
      for (const c of [running, unknown, notDue]) assert.ok(!r1.results.some((x) => x.paymentRequestId === c.requestId), `request ${c.requestId} never picked`);
      assert.equal(spy2.mock.callCount(), 0, "no card charged");
      const r2 = await tick();
      assert.ok(!r2.results.some((x) => x.paymentRequestId === due.requestId), "idempotent: the scheduled fee is not picked again");
    } finally {
      spy2.mock.restore();
    }
    assert.equal((await outbox(due)).filter((o) => o.action === "SCHEDULE_DEBIT").length, 1);
    assert.equal((await outbox(running)).length, 0);
    assert.equal((await request(running.requestId)).status, "NOTICE_SENT");
    assert.equal((await request(unknown.requestId)).status, "PROCESSING");
    assert.equal((await charges(unknown)).length, 1);
    assert.equal((await request(notDue.requestId)).status, "RETRY_SCHEDULED");
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "transaction"), eq(auditLogs.recordId, String(due.transactionId))));
    const a = audits.find((x) => x.action === "pit_crew_service_fee_scheduler_collection");
    assert.ok(a, "scheduler collection audited");
    assert.equal(a!.userId, null, "system-initiated");
    assert.equal(JSON.parse(a!.updatedValue ?? "{}").trigger, "scheduler");
  });

  test("due card retry: concurrent ticks charge exactly once (advisory lock + row lock); charge is system-initiated", async () => {
    const cardId = await cardAuthority();
    const c = await issued(cardId, "SchedRetry");
    await elapseNotice(c);
    const spy = spyCharges(["Failed"]);
    try {
      assert.equal((await collect(w, w.crew, c)).json.outcome, "card_failed_retry_scheduled");
    } finally {
      spy.mock.restore();
    }
    await elapseRetry(c);
    const spy2 = spyCharges();
    try {
      const rs = await Promise.all([1, 2, 3].map(() => tick()));
      assert.equal(rs.flatMap((r) => r.results).filter((x) => x.paymentRequestId === c.requestId && x.outcome === "card_charged").length, 1, JSON.stringify(rs));
      assert.equal(spy2.mock.callCount(), 1);
      await tick();
      assert.equal(spy2.mock.callCount(), 1, "a paid fee is never charged again");
    } finally {
      spy2.mock.restore();
    }
    const rows = await charges(c);
    assert.deepEqual(rows.map((x) => x.status), ["FAILED", "SUCCEEDED"]);
    assert.equal(rows[1]!.trigger, "scheduler");
    assert.equal(rows[1]!.initiatedByUserId, null);
  });

  test("re-gates at run time: a revoked authority is skipped with a refusal audit, nothing collected", async () => {
    const dd = await activeDebitAuthority(w);
    const c = await issued(dd.id, "SchedRevoked");
    await elapseNotice(c);
    await db.update(pcFeeAuthorities).set({ status: "REVOKED" }).where(eq(pcFeeAuthorities.id, dd.id));
    const r = await tick();
    const mine = r.results.find((x) => x.paymentRequestId === c.requestId);
    assert.ok(mine && mine.code, JSON.stringify(r));
    assert.equal((await outbox(c)).length, 0);
    assert.equal((await request(c.requestId)).status, "NOTICE_SENT");
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "transaction"), eq(auditLogs.recordId, String(c.transactionId))));
    assert.ok(audits.some((x) => x.action === "pit_crew_service_fee_scheduler_collection_refused"));
  });

  test("fail closed on a non-sandbox provider: the whole tick is skipped, nothing collected", async () => {
    const dd = await activeDebitAuthority(w);
    const c = await issued(dd.id, "SchedLive");
    await elapseNotice(c);
    const orig = mandatePaymentProvider.name;
    (mandatePaymentProvider as { name: string }).name = "live-bank";
    try {
      const r = await tick();
      assert.equal(r.skipped, "PROVIDER_NOT_PERMITTED");
      assert.equal(r.results.length, 0);
    } finally {
      (mandatePaymentProvider as { name: string }).name = orig;
    }
    assert.equal((await outbox(c)).length, 0);
  });
});
