// AE GROW "Brokerage-wide Signal Sweep" — independent-review remediation.
//
// One regression test per confirmed finding, each written so that it FAILS
// against the code as it was before the fix. Real Postgres, real fixtures, no
// mocks of the module under test — the convention every suite here follows.
// The only injection used is the statement observer that packages/db already
// exposes as a test-only seam, plus a one-shot wrapper around pool.connect()
// for the advisory-lock failure path, which cannot be provoked any other way.
//
// Every sweep in this file is SCOPED to this file's own brokerages, except
// the two places where the production (unscoped) path is precisely what is
// under test; both of those are bounded to a single brokerage.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  setDbQueryObserver,
  growOpportunitySignals,
  growRelationships,
  growSignalSweepRuns,
  growSignalSweepCursors,
  growContactDncrStatuses,
  growContactChannelSuppressions,
  parties,
  properties,
  GROW_CONSENT_CHANNELS,
} from "@aee/db";
import {
  runSignalSweep,
  tryHoldSignalSweepLockForTests,
  resetSweepResumePointForTests,
  listBrokeragesDueForSweep,
  LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS,
} from "../sweep.js";
import { dismissSignal } from "../signals.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let C: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Created in order, so A.brokerageId < B.brokerageId < C.brokerageId.
  A = await createBrokerageWithUsers(baseUrl, `Sweep Remediation A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Sweep Remediation B ${suffix}`);
  C = await createBrokerageWithUsers(baseUrl, `Sweep Remediation C ${suffix}`);
  resetSweepResumePointForTests();
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId, C?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

/* ---------------------------------------------------------------------
 * Fixtures.
 * -----------------------------------------------------------------*/

async function createParty(brokerageId: number, label: string): Promise<number> {
  const [row] = await db.insert(parties).values({ brokerageId, partyType: "Person", firstName: "Remediation", lastName: label }).returning({ id: parties.id });
  return row.id;
}

async function createProperty(tenant: { brokerageId: number; admin: DevLoginResult }, label: string): Promise<number> {
  const [row] = await db
    .insert(properties)
    .values({ brokerageId: tenant.brokerageId, agentId: tenant.admin.user.id, formattedAddress: `${label} ${suffix}`, state: "NSW", suburb: "Testville", postcode: "2000" })
    .returning({ id: properties.id });
  return row.id;
}

/**
 * An Active owner relationship acquired `years` ago — the long_ownership_tenure
 * rule's input.
 *
 * `ownershipStartDate` is what the rule actually reads, and it ABSTAINS when
 * that is NULL. `validFrom` is row-creation time (defaultNow()) and says
 * nothing about when the owner acquired the property, so setting it alone
 * produces no signal at all and every assertion below would pass vacuously.
 * Both are set here so the fixture states one coherent fact.
 */
async function createTenureRelationship(brokerageId: number, partyId: number, propertyId: number, years: number): Promise<number> {
  const acquiredAt = new Date(Date.now() - years * 365 * MS_PER_DAY);
  const [row] = await db
    .insert(growRelationships)
    .values({
      brokerageId,
      partyId,
      propertyId,
      relationshipType: "owner",
      status: "Active",
      validFrom: acquiredAt,
      ownershipStartDate: acquiredAt,
      ownershipStartSource: "manual",
      ownershipStartPrecision: "day",
    })
    .returning({ id: growRelationships.id });
  return row.id;
}

/** A party with one 11-year tenure relationship — one candidate, one signal, unless contactability withholds it. */
async function createContactWithSignal(tenant: { brokerageId: number; admin: DevLoginResult }, label: string): Promise<number> {
  const partyId = await createParty(tenant.brokerageId, label);
  const propertyId = await createProperty(tenant, `${label} St`);
  await createTenureRelationship(tenant.brokerageId, partyId, propertyId, 11);
  return partyId;
}

async function signalsForParty(brokerageId: number, partyId: number) {
  return db
    .select()
    .from(growOpportunitySignals)
    .where(and(eq(growOpportunitySignals.brokerageId, brokerageId), eq(growOpportunitySignals.partyId, partyId)));
}

async function sweepScoped(brokerageIds: number[], options: { force?: boolean } = {}) {
  const result = await runSignalSweep("MANUAL", { brokerageIds, force: true, ...options });
  assert.ok(result.ok, `sweep was skipped: ${result.ok ? "" : result.skippedReason}`);
  return result.summary;
}

/** Captures the structured log lines (stderr — warn and error) written while `fn` runs. */
async function captureErrorLog(fn: () => Promise<void>): Promise<Array<{ level: string; message: string }>> {
  const lines: Array<{ level: string; message: string }> = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: unknown }).write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    for (const line of text.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const parsed = JSON.parse(line) as { level?: unknown; message?: unknown };
        if (typeof parsed.level === "string" && typeof parsed.message === "string") lines.push({ level: parsed.level, message: parsed.message });
      } catch {
        /* not one of ours */
      }
    }
    return (realWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as unknown as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    (process.stderr as unknown as { write: unknown }).write = realWrite;
  }
  return lines;
}

/* ---------------------------------------------------------------------
 * P1-1 — a failing lock acquisition must DESTROY its connection.
 * -----------------------------------------------------------------*/

test("P1-1 — a pg_try_advisory_lock statement that rejects destroys its pooled connection instead of returning it", async () => {
  // WHY THIS MATTERS. A session-level advisory lock is not transactional: it
  // survives statement rollback and cancellation. If the function executed
  // server-side and the statement then failed anyway (statement_timeout, a
  // cancellation, a read error), the lock is HELD by that connection. Handing
  // that connection back to the pool leaks (0x41455351, 1) forever: every
  // later run is refused with "already running", no RUNNING row exists, and
  // sweeping is silently dead until the process restarts.
  //
  // release(err) is pg's documented "destroy this client" contract, and
  // Postgres drops a session advisory lock the instant its connection closes.
  // So the assertion is precisely: release was called WITH an Error.
  const pool = db.$client;
  const realConnect = pool.connect.bind(pool);
  let armed = true;
  let releasedWith: unknown = "RELEASE_NEVER_CALLED";

  (pool as unknown as { connect: unknown }).connect = (async () => {
    const client = await realConnect();
    if (!armed) return client;
    armed = false;
    return new Proxy(client, {
      get(target, prop) {
        if (prop === "query") {
          return (...args: unknown[]) => {
            const first = args[0] as string | { text?: string } | undefined;
            const text = typeof first === "string" ? first : first?.text;
            if (typeof text === "string" && text.includes("pg_try_advisory_lock")) {
              // The shape the finding describes: the lock may well have been
              // taken server-side, and we never learn whether it was.
              return Promise.reject(new Error("injected: canceling statement due to statement timeout"));
            }
            return (target as unknown as { query: (...a: unknown[]) => unknown }).query(...args);
          };
        }
        if (prop === "release") {
          return (err?: unknown) => {
            releasedWith = err;
            return (target as unknown as { release: (e?: unknown) => void }).release(err as Error | undefined);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }) as unknown as typeof pool.connect;

  try {
    await assert.rejects(
      () => runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] }),
      /statement timeout/,
      "a lock acquisition that rejects must propagate, not be swallowed",
    );
  } finally {
    (pool as unknown as { connect: unknown }).connect = realConnect;
  }

  assert.ok(
    releasedWith instanceof Error,
    `the lock connection must be released WITH the error (destroyed); release was called with ${String(releasedWith)}. ` +
      "release(undefined) returns a possibly-lock-holding connection to the pool and permanently disables sweeping.",
  );

  // And the pool recovered: a normal sweep still works immediately afterwards.
  const summary = await sweepScoped([A.brokerageId]);
  assert.equal(summary.brokeragesConsidered, 1);
});

test("P1-1 — repeated 'already running' refusals with NO running row are alerted, not reported as the expected outcome", async () => {
  resetSweepResumePointForTests();

  // The condition under test is "the lock is held but nothing is sweeping".
  // Any RUNNING row left behind by another suite would mask it — and is
  // itself abandoned, which is exactly what an unscoped sweep's own
  // stale-run recovery would conclude about it.
  await db
    .update(growSignalSweepRuns)
    .set({ status: "FAILED", completedAt: new Date(), errorMessage: "Abandoned: the sweep did not complete (its process stopped while running)." })
    .where(eq(growSignalSweepRuns.status, "RUNNING"));

  const release = await tryHoldSignalSweepLockForTests();
  assert.ok(release, "the lock must be free at the start of this test");
  let lines: Array<{ level: string; message: string }> = [];
  try {
    lines = await captureErrorLog(async () => {
      for (let attempt = 0; attempt < LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS; attempt += 1) {
        const refused = await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] });
        assert.equal(refused.ok, false, "the lock is held, so every attempt must be refused");
      }
    });
  } finally {
    await release();
  }

  const warnings = lines.filter((l) => l.message === "property_signal_sweep_lock_held_with_no_running_row");
  const alerts = lines.filter((l) => l.message === "property_signal_sweep_lock_suspected_leak");
  assert.equal(warnings.length, LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS - 1, "each orphaned refusal below the threshold is warned about");
  assert.equal(alerts.length, 1, "a run of orphaned refusals must escalate to an alertable error, not stay silent");
  assert.equal(alerts[0].level, "error");

  // A successful acquisition resets the run, so an ordinary race never
  // accumulates towards the alert.
  await sweepScoped([A.brokerageId]);
  const afterSuccess = await captureErrorLog(async () => {
    const holder = await tryHoldSignalSweepLockForTests();
    assert.ok(holder);
    try {
      await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] });
    } finally {
      await holder();
    }
  });
  assert.equal(afterSuccess.filter((l) => l.message === "property_signal_sweep_lock_suspected_leak").length, 0, "a single refusal after a healthy run is not an alert");
});

/* ---------------------------------------------------------------------
 * P1-2 — one bad brokerage must not abort the run or starve the rest.
 * -----------------------------------------------------------------*/

test("P1-2 — a brokerage whose pass throws is counted and skipped over; the brokerages after it are still swept", async () => {
  const poisonedParty = await createContactWithSignal(A, "PoisonedTenant");
  const healthyParty = await createContactWithSignal(B, "TenantAfterThePoisonedOne");

  // Make brokerage A's pass throw at its very first statement. Injected
  // through the statement observer rather than by mocking the module, so the
  // failure travels the same path a genuine query error would.
  let injected = 0;
  const uninstall = setDbQueryObserver((query, params) => {
    if (injected > 0) return;
    const text = query.toLowerCase();
    if (text.startsWith("select") && text.includes("grow_signal_sweep_cursors") && params.length === 1 && params[0] === A.brokerageId) {
      injected += 1;
      throw new Error("injected: brokerage read failed");
    }
  });

  let summary;
  try {
    // Scoped, so it iterates A then B in ascending id order: the POISONED
    // tenant is first, and the healthy one is behind it.
    const result = await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId, B.brokerageId], force: true });
    assert.ok(result.ok, "one failing tenant must not fail the whole run");
    summary = result.summary;
  } finally {
    uninstall();
  }

  assert.equal(injected, 1, "the failure really was injected");
  assert.equal(summary.errors, 1, "SweepSummary.errors counts the failing brokerage (it was previously never incremented at all)");
  assert.equal(summary.brokeragesConsidered, 2, "the run continued past the failing tenant");
  assert.equal(summary.brokeragesEvaluated, 1, "the tenant behind the failing one was evaluated");

  assert.equal((await signalsForParty(A.brokerageId, poisonedParty)).length, 0, "the failing tenant's pass wrote nothing");
  assert.equal((await signalsForParty(B.brokerageId, healthyParty)).length, 1, "the tenant AFTER the failing one is swept — it used to be starved indefinitely");

  const [run] = await db.select().from(growSignalSweepRuns).where(eq(growSignalSweepRuns.id, summary.sweepRunId));
  assert.equal(run.status, "COMPLETED", "a run that lost one tenant is completed-with-errors, not FAILED");
  assert.equal(run.errors, 1, "the error count is persisted on the run row");
  assert.match(run.errorMessage ?? "", /Completed with 1 failed brokerage/);

  // The failing tenant's resume point advanced, so it cannot poison later
  // runs — but its high-water marks did NOT, so the next pass still fully
  // evaluates it rather than skipping it as unchanged.
  const [cursor] = await db.select().from(growSignalSweepCursors).where(eq(growSignalSweepCursors.brokerageId, A.brokerageId));
  assert.ok(cursor, "a failing brokerage still advances its last_evaluated_at");
  assert.ok(cursor.lastEvaluatedAt, "last_evaluated_at is stamped so the failing tenant moves to the back of the durable ordering");

  const recovered = await sweepScoped([A.brokerageId]);
  assert.equal(recovered.brokeragesEvaluated, 1, "the next run evaluates the previously failing tenant normally");
  assert.equal(recovered.errors, 0);
  assert.equal((await signalsForParty(A.brokerageId, poisonedParty)).length, 1, "and its signal is raised once the transient failure is gone");
});

/* ---------------------------------------------------------------------
 * P1-4 — the resume point lives in the database, not in this process.
 * -----------------------------------------------------------------*/

test("P1-4 — an unscoped run takes the least-recently-evaluated brokerage from grow_signal_sweep_cursors, not a per-process integer", async () => {
  // Three known states: C has never been evaluated (no cursor row), B was
  // evaluated impossibly long ago, A was evaluated just now.
  await sweepScoped([A.brokerageId]);
  await db.delete(growSignalSweepCursors).where(eq(growSignalSweepCursors.brokerageId, C.brokerageId));
  await db
    .insert(growSignalSweepCursors)
    .values({ brokerageId: B.brokerageId, lastEvaluatedAt: new Date("1900-01-01T00:00:00Z"), updatedAt: new Date() })
    .onConflictDoUpdate({ target: growSignalSweepCursors.brokerageId, set: { lastEvaluatedAt: sql`excluded.last_evaluated_at` } });

  const order = await listBrokeragesDueForSweep(1_000_000);
  const indexOf = (id: number) => order.indexOf(id);
  assert.ok(indexOf(B.brokerageId) >= 0 && indexOf(C.brokerageId) >= 0 && indexOf(A.brokerageId) >= 0);
  assert.ok(indexOf(B.brokerageId) < indexOf(C.brokerageId), "the longest-unevaluated brokerage sweeps first");
  assert.ok(indexOf(C.brokerageId) < indexOf(A.brokerageId), "a brokerage with no cursor row at all counts as never evaluated and sweeps before a recently evaluated one");

  // B is now the most overdue brokerage in the whole database, so the
  // PRODUCTION path — unscoped, no caller-supplied cursor — must pick it.
  // Before this fix the unscoped path read a module-level integer and would
  // have started at the lowest brokerage id in the database instead.
  assert.deepEqual(await listBrokeragesDueForSweep(1), [B.brokerageId]);
  const result = await runSignalSweep("MANUAL", { maxBrokerages: 1 });
  assert.ok(result.ok);
  assert.equal(result.summary.brokeragesConsidered, 1);
  assert.equal(result.summary.lastBrokerageId, B.brokerageId, "the unscoped run swept the most overdue brokerage");

  // And the resume point advanced IN THE DATABASE, so the next run — in this
  // process or any other — continues rather than repeating B.
  const [cursor] = await db.select().from(growSignalSweepCursors).where(eq(growSignalSweepCursors.brokerageId, B.brokerageId));
  assert.ok(cursor.lastEvaluatedAt && cursor.lastEvaluatedAt.getTime() > new Date("1990-01-01T00:00:00Z").getTime(), "the considered brokerage's cursor moved to now");
  assert.notEqual((await listBrokeragesDueForSweep(1))[0], B.brokerageId, "B is no longer the most overdue, so the next run moves on");
});

/* ---------------------------------------------------------------------
 * P2-1 — "latest row" means what the consent model says it means.
 * -----------------------------------------------------------------*/

test("P2-1 — a RELEASED suppression dated in the future never un-suppresses, and serial id decides the current row", async () => {
  const futureReleaseParty = await createContactWithSignal(C, "FutureRelease");
  const lowerIdReleaseParty = await createContactWithSignal(C, "SupersededRelease");
  const genuinelyReleasedParty = await createContactWithSignal(C, "GenuinelyReleased");

  const recordedByUserId = C.admin.user.id;

  // (a) Suppressed on every channel, then "released" with an effective_at 30
  //     days out. consentControlsPersistence only considers rows already in
  //     force, so the consent engine keeps this party blocked; the sweep must
  //     agree. Ordering by effective_at (as this module used to) picked the
  //     future RELEASED row and raised the signal — divergence in the unsafe
  //     direction.
  await db.insert(growContactChannelSuppressions).values(
    GROW_CONSENT_CHANNELS.map((channel) => ({
      brokerageId: C.brokerageId,
      partyId: futureReleaseParty,
      channel,
      state: "SUPPRESSED",
      reason: "test-fixture",
      effectiveAt: new Date(Date.now() - MS_PER_DAY),
      recordedByUserId,
    })),
  );
  await db.insert(growContactChannelSuppressions).values(
    GROW_CONSENT_CHANNELS.map((channel) => ({
      brokerageId: C.brokerageId,
      partyId: futureReleaseParty,
      channel,
      state: "RELEASED",
      reason: "test-fixture-not-yet-in-force",
      effectiveAt: new Date(Date.now() + 30 * MS_PER_DAY),
      recordedByUserId,
    })),
  );

  // (b) A RELEASED row written FIRST (lower serial id) with a LATER
  //     effective_at than the SUPPRESSED row written after it. Serial id is
  //     the append order and the only canonical current-state ordering, so
  //     the SUPPRESSED rows are current.
  await db.insert(growContactChannelSuppressions).values(
    GROW_CONSENT_CHANNELS.map((channel) => ({
      brokerageId: C.brokerageId,
      partyId: lowerIdReleaseParty,
      channel,
      state: "RELEASED",
      reason: "test-fixture-superseded",
      effectiveAt: new Date(Date.now() - MS_PER_DAY),
      recordedByUserId,
    })),
  );
  await db.insert(growContactChannelSuppressions).values(
    GROW_CONSENT_CHANNELS.map((channel) => ({
      brokerageId: C.brokerageId,
      partyId: lowerIdReleaseParty,
      channel,
      state: "SUPPRESSED",
      reason: "test-fixture-current",
      effectiveAt: new Date(Date.now() - 10 * MS_PER_DAY),
      recordedByUserId,
    })),
  );

  // (c) The control: suppressed, then genuinely released in force and after
  //     it. This party must still be visible — the fix must not turn the
  //     filter into "once suppressed, always suppressed".
  await db.insert(growContactChannelSuppressions).values(
    GROW_CONSENT_CHANNELS.map((channel) => ({
      brokerageId: C.brokerageId,
      partyId: genuinelyReleasedParty,
      channel,
      state: "SUPPRESSED",
      reason: "test-fixture",
      effectiveAt: new Date(Date.now() - 10 * MS_PER_DAY),
      recordedByUserId,
    })),
  );
  await db.insert(growContactChannelSuppressions).values(
    GROW_CONSENT_CHANNELS.map((channel) => ({
      brokerageId: C.brokerageId,
      partyId: genuinelyReleasedParty,
      channel,
      state: "RELEASED",
      reason: "test-fixture",
      effectiveAt: new Date(Date.now() - MS_PER_DAY),
      recordedByUserId,
    })),
  );

  await sweepScoped([C.brokerageId]);

  assert.equal((await signalsForParty(C.brokerageId, futureReleaseParty)).length, 0, "a release that is not yet in force must never un-suppress a contact");
  assert.equal((await signalsForParty(C.brokerageId, lowerIdReleaseParty)).length, 0, "the current row is the highest serial id, not the latest caller-supplied timestamp");
  assert.equal((await signalsForParty(C.brokerageId, genuinelyReleasedParty)).length, 1, "a release that IS in force and IS the latest row restores the contact");
});

/* ---------------------------------------------------------------------
 * P2-2 — unknown consent states fail closed; absent data does not.
 * -----------------------------------------------------------------*/

test("P2-2 — DNCR UNKNOWN and an unrecognised suppression state both suppress; NOT_CHECKED and no data at all do not", async () => {
  const unknownDncrParty = await createContactWithSignal(C, "DncrUnknown");
  const notCheckedParty = await createContactWithSignal(C, "DncrNotChecked");
  const unknownStateParty = await createContactWithSignal(C, "SuppressionStateUnknown");
  const noDataParty = await createContactWithSignal(C, "NoConsentDataAtAll");
  const recordedByUserId = C.admin.user.id;

  // UNKNOWN means the register WAS consulted and could not answer — the
  // consent engine refuses to proceed on exactly that (DNCR_STATUS_UNKNOWN),
  // so a prospecting suggestion must not be raised either.
  await db.insert(growContactDncrStatuses).values({
    brokerageId: C.brokerageId,
    partyId: unknownDncrParty,
    channel: "PHONE_CALL",
    status: "UNKNOWN",
    source: "test-fixture",
    recordedByUserId,
  });

  // NOT_CHECKED means nobody has looked yet; it is missing data, not an
  // inconclusive answer, and must not suppress.
  await db.insert(growContactDncrStatuses).values({
    brokerageId: C.brokerageId,
    partyId: notCheckedParty,
    channel: "PHONE_CALL",
    status: "NOT_CHECKED",
    source: "test-fixture",
    recordedByUserId,
  });

  // A state this build does not recognise — a corrupted value, or one added
  // by a newer build writing into the same database. It must not silently
  // un-suppress the channel.
  await db.insert(growContactChannelSuppressions).values(
    GROW_CONSENT_CHANNELS.map((channel) => ({
      brokerageId: C.brokerageId,
      partyId: unknownStateParty,
      channel,
      state: "QUARANTINED_PENDING_REVIEW",
      reason: "test-fixture-unrecognised-state",
      recordedByUserId,
    })),
  );

  await sweepScoped([C.brokerageId]);

  assert.equal((await signalsForParty(C.brokerageId, unknownDncrParty)).length, 0, "an explicit DNCR UNKNOWN fails closed");
  assert.equal((await signalsForParty(C.brokerageId, unknownStateParty)).length, 0, "an unrecognised suppression state fails closed");
  assert.equal((await signalsForParty(C.brokerageId, notCheckedParty)).length, 1, "NOT_CHECKED is missing data, not an inconclusive answer");
  assert.equal((await signalsForParty(C.brokerageId, noDataParty)).length, 1, "a contact with no consent rows at all is unaffected — the common pilot case");
});

/* ---------------------------------------------------------------------
 * P2-5 — the statement observer is a test-only seam.
 * -----------------------------------------------------------------*/

test("P2-5 — setDbQueryObserver refuses to install outside tests, and uninstall clears rather than restores", async () => {
  const realNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.throws(
      () => setDbQueryObserver(() => {}),
      /test-only seam/,
      "an ungated process-wide tap on every statement and its bind parameters must not be installable in production",
    );
  } finally {
    process.env.NODE_ENV = realNodeEnv;
  }

  // Out-of-order teardown must not resurrect an earlier observer. Restoring a
  // captured `previous` would leave `first` live for the rest of the process.
  let firstSaw = 0;
  let secondSaw = 0;
  const uninstallFirst = setDbQueryObserver(() => {
    firstSaw += 1;
  });
  const uninstallSecond = setDbQueryObserver(() => {
    secondSaw += 1;
  });
  uninstallFirst();
  await db.select({ id: parties.id }).from(parties).limit(1);
  uninstallSecond();

  assert.equal(secondSaw, 0, "the uninstalled observer is gone");
  assert.equal(firstSaw, 0, "and uninstalling out of order must not reinstate an older observer");

  // The seam still works normally, which sweepScale.test.ts depends on.
  let counted = 0;
  const uninstall = setDbQueryObserver(() => {
    counted += 1;
  });
  try {
    await db.select({ id: parties.id }).from(parties).limit(1);
  } finally {
    uninstall();
  }
  assert.ok(counted >= 1, "an installed observer still sees statements");
});

/* ---------------------------------------------------------------------
 * P2-6 — a legacy NULL fingerprint must not earn a re-raise.
 * -----------------------------------------------------------------*/

test("P2-6 — a human-decided signal with no recorded fingerprint stays terminal; one with a fingerprint still re-raises on a real change", async () => {
  const partyId = await createParty(C.brokerageId, "LegacyFingerprint");
  const propertyId = await createProperty(C, "Legacy Fingerprint St");
  const relationshipId = await createTenureRelationship(C.brokerageId, partyId, propertyId, 6); // Emerging, so the band has room to move

  await sweepScoped([C.brokerageId]);
  const [raised] = (await signalsForParty(C.brokerageId, partyId)).filter((s) => s.signalType === "long_ownership_tenure");
  assert.ok(raised);

  // Make it look like a row written before evidence fingerprints existed.
  await db.update(growOpportunitySignals).set({ evidenceFingerprint: null }).where(eq(growOpportunitySignals.id, raised.id));

  const dismissed = await dismissSignal({ signalId: raised.id, brokerageId: C.brokerageId, userId: C.admin.user.id, dismissedReason: "Legacy row; spoken to." });
  assert.equal(dismissed.status, "Dismissed");
  assert.ok(dismissed.nextReviewAt);
  const [stillNull] = await db
    .select({ fingerprint: growOpportunitySignals.evidenceFingerprint })
    .from(growOpportunitySignals)
    .where(and(eq(growOpportunitySignals.id, raised.id), isNull(growOpportunitySignals.evidenceFingerprint)));
  assert.ok(stillNull, "the fixture really is a NULL-fingerprint dismissal");

  // Quiet period elapses with the evidence COMPLETELY UNCHANGED. NULL IS
  // DISTINCT FROM 'band|Emerging' is true, so the old predicate re-raised
  // here — an unearned re-raise, which is precisely what the second
  // condition of the re-review policy exists to prevent.
  await db.update(growOpportunitySignals).set({ nextReviewAt: new Date(Date.now() - MS_PER_DAY) }).where(eq(growOpportunitySignals.id, raised.id));
  await sweepScoped([C.brokerageId]);

  const [afterQuietPeriod] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, raised.id));
  assert.equal(afterQuietPeriod.status, "Dismissed", "with no record of what the human decided against, the sweep cannot claim the evidence changed");
  assert.equal(afterQuietPeriod.reRaiseCount, 0);

  // Even a GENUINE change cannot rescue a row with no stored fingerprint.
  // That is the accepted tradeoff: a legacy NULL-fingerprint dismissal is
  // terminal until something else rewrites the row.
  // A genuine correction to the acquisition date itself — 11 years becomes 6,
  // which moves the tenure band and therefore the evidence fingerprint. It has
  // to be ownershipStartDate: the rule does not read validFrom, so changing
  // that would not be a change in evidence at all.
  await db
    .update(growRelationships)
    .set({ ownershipStartDate: new Date(Date.now() - 6 * 365 * MS_PER_DAY) })
    .where(eq(growRelationships.id, relationshipId));
  await sweepScoped([C.brokerageId]);
  const [afterRealChange] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, raised.id));
  assert.equal(afterRealChange.status, "Dismissed");

  // The normal flow is untouched: give the row the fingerprint a sweep would
  // have written, and the same material change re-raises it exactly once.
  // The fingerprint the sweep would have written when this row was raised at
  // an 11-year tenure, i.e. what the human actually decided against. The
  // acquisition date has since been corrected to 6 years, so the evidence now
  // genuinely differs from that record.
  await db.update(growOpportunitySignals).set({ evidenceFingerprint: "band|StrongIndicator" }).where(eq(growOpportunitySignals.id, raised.id));
  await sweepScoped([C.brokerageId]);
  const [reRaised] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, raised.id));
  assert.equal(reRaised.status, "Active", "a row that DOES record what it was decided against still re-raises on a real change");
  assert.equal(reRaised.confidenceBand, "Emerging", "re-raised against the corrected 6-year tenure, not the stale 11-year band");
  assert.equal(reRaised.reRaiseCount, 1);
});
