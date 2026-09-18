import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { eq } from "drizzle-orm";

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const options = { skip: !databaseEnabled, concurrency: false };

async function fixture(t: TestContext) {
  const schema = await import("@aee/db");
  const consent = await import("../consent.js");
  const sessions = await import("../callSessions.js");
  const { db, brokerages, users, parties, growCallSessions, growCallRecordingConsents, auditLogs, growActivities } = schema;
  const suffix = randomUUID();
  const [brokerage] = await db.insert(brokerages).values({ name: `F2 consent regression ${suffix}` }).returning();
  t.after(async () => {
    // No webhook fixtures or global triggers: every row belongs to this tenant.
    await db.delete(growActivities).where(eq(growActivities.brokerageId, brokerage.id));
    await db.delete(growCallSessions).where(eq(growCallSessions.brokerageId, brokerage.id));
    await db.delete(growCallRecordingConsents).where(eq(growCallRecordingConsents.brokerageId, brokerage.id));
    await db.delete(auditLogs).where(eq(auditLogs.brokerageId, brokerage.id));
    await db.delete(parties).where(eq(parties.brokerageId, brokerage.id));
    await db.delete(users).where(eq(users.brokerageId, brokerage.id));
    await db.delete(brokerages).where(eq(brokerages.id, brokerage.id));
  });
  const [user] = await db.insert(users).values({
    authProviderId: `f2-consent-${suffix}`,
    email: `f2-consent-${suffix}@example.test`,
    firstName: "Consent",
    lastName: "Regression",
    brokerageId: brokerage.id,
  }).returning();
  const [party] = await db.insert(parties).values({
    brokerageId: brokerage.id,
    firstName: "Consent",
    mobile: "+61412345678",
  }).returning();
  const [session] = await db.insert(growCallSessions).values({
    brokerageId: brokerage.id,
    partyId: party.id,
    initiatedByUserId: user.id,
    destinationRaw: "+61412345678",
    destinationNormalized: "+61412345678",
    destinationCountry: "AU",
    status: "CONNECTED",
    recordingRequested: true,
    recordingStatus: "DISCLOSURE_REQUIRED",
    startedAt: new Date(),
  }).returning();
  const capture = () => consent.captureRecordingConsent({
    brokerageId: brokerage.id,
    partyId: party.id,
    scope: "PER_CALL",
    source: "VERBAL_ON_CALL",
    capturedByUserId: user.id,
    jurisdiction: "AU",
    callSessionId: session.id,
    evidenceMetadata: { fixture: suffix },
  });
  const withdraw = (consentId: number) => consent.withdrawRecordingConsent({
    brokerageId: brokerage.id,
    consentId,
    withdrawnByUserId: user.id,
    withdrawalReason: "Contact withdrew consent",
  });
  const readSession = async () => {
    const [row] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, session.id));
    return row;
  };
  const readConsents = () => db.select().from(growCallRecordingConsents).where(eq(growCallRecordingConsents.brokerageId, brokerage.id));
  const readAudits = () => db.select().from(auditLogs).where(eq(auditLogs.brokerageId, brokerage.id)).orderBy(auditLogs.id);
  const decline = () => sessions.declineInCallRecording({
    brokerageId: brokerage.id,
    callSessionId: session.id,
    declinedByUserId: user.id,
    declinedByUserRole: "AGENT",
  });
  const assertGuards = async () => {
    const before = await readSession();
    await assert.rejects(sessions.recordInCallRecordingDisclosure({
      brokerageId: brokerage.id,
      callSessionId: session.id,
      disclosedByUserId: user.id,
      disclosedByUserRole: "AGENT",
    }), sessions.GrowCallSessionValidationError);
    await assert.rejects(sessions.confirmInCallRecording({
      brokerageId: brokerage.id,
      callSessionId: session.id,
      confirmedByUserId: user.id,
      actorRole: "AGENT",
    }), sessions.GrowCallSessionValidationError);
    assert.deepEqual(await readSession(), before, "rejected attestations cannot mutate closed evidence");
  };
  return { ...schema, sessions, brokerage, user, party, session, capture, withdraw, readSession, readConsents, readAudits, decline, assertGuards };
}

test("DECLINED remains closed after multiple later captures, with its evidence and attestation guards intact", options, async (t) => {
  const f = await fixture(t);
  await f.capture();
  const declined = await f.decline();
  const declineAudit = (await f.readAudits()).find((row) => row.action === "grow_call_recording_declined_in_call");
  assert.ok(declineAudit);
  const first = await f.capture();
  const afterFirst = await f.readSession();
  const second = await f.capture();
  const afterSecond = await f.readSession();
  assert.equal(afterFirst.recordingStatus, "DECLINED");
  assert.equal(afterSecond.recordingStatus, "DECLINED");
  assert.equal(afterFirst.recordingPermitted, false);
  assert.equal(afterSecond.recordingPermitted, false);
  assert.deepEqual(afterFirst, declined, "later evidence must not rewrite the declined session");
  assert.deepEqual(afterSecond, declined);
  assert.equal(first.status, "ACTIVE");
  assert.equal(second.status, "ACTIVE");
  assert.deepEqual((await f.readAudits()).find((row) => row.id === declineAudit.id), declineAudit);
  await f.assertGuards();
});

test("withdrawal preserves DECLINED and its original consent association", options, async (t) => {
  const f = await fixture(t);
  const captured = await f.capture();
  const declined = await f.decline();
  const withdrawn = await f.withdraw(captured.id);
  assert.equal(withdrawn.status, "WITHDRAWN");
  assert.ok(withdrawn.withdrawnAt);
  assert.equal(withdrawn.withdrawnByUserId, f.user.id);
  assert.deepEqual(await f.readSession(), declined);
  const later = await f.capture();
  await f.withdraw(later.id);
  await f.capture();
  assert.deepEqual(await f.readSession(), declined, "repeated capture/withdraw cycles cannot erase a decline");
  assert.equal((await f.readSession()).recordingPermitted, false);
  await f.assertGuards();
});

for (const terminal of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
  test(`${terminal} recording closure is not reopened by multiple captures or withdrawal`, options, async (t) => {
    const f = await fixture(t);
    const captured = await f.capture();
    if (terminal === "CANCELLED") {
      // Cancellation is only reachable before CONNECTED.
      await f.db.update(f.growCallSessions).set({ status: "READY" }).where(eq(f.growCallSessions.id, f.session.id));
      await f.sessions.cancelCallSession({
        brokerageId: f.brokerage.id,
        callSessionId: f.session.id,
        cancelledByUserId: f.user.id,
        cancelledByUserRole: "AGENT",
      });
    } else {
      await f.sessions.applySandboxLifecycleEvent(f.session.id, terminal);
    }
    const closed = await f.readSession();
    assert.equal(closed.status, terminal);
    assert.equal(closed.recordingPermitted, false);
    if (terminal !== "CANCELLED") assert.equal(closed.recordingStatus, "UNRECORDED");
    const sessionAudits = (await f.readAudits()).filter((row) => row.recordType === "grow_call_session");
    await f.capture();
    const afterFirst = await f.readSession();
    await f.capture();
    const afterSecond = await f.readSession();
    await f.withdraw(captured.id);
    const afterWithdrawal = await f.readSession();
    assert.deepEqual(afterFirst, closed, "capture cannot rewrite terminal evidence");
    assert.deepEqual(afterSecond, closed, "repeated capture cannot reopen terminal recording");
    assert.deepEqual(afterWithdrawal, closed, "withdrawal cannot rewrite terminal evidence");
    assert.equal(afterFirst.recordingPermitted, false);
    assert.equal(afterSecond.recordingPermitted, false);
    assert.equal(afterWithdrawal.recordingPermitted, false);
    assert.deepEqual((await f.readAudits()).filter((row) => row.recordType === "grow_call_session"), sessionAudits);
    await f.assertGuards();
  });
}

for (const terminal of ["COMPLETED", "FAILED"] as const) {
  test(`${terminal} preserves an in-call decline through closure, capture and withdrawal`, options, async (t) => {
    const f = await fixture(t);
    const captured = await f.capture();
    await f.decline();
    await f.sessions.applySandboxLifecycleEvent(f.session.id, terminal);
    const closed = await f.readSession();
    assert.equal(closed.recordingStatus, "DECLINED");
    assert.equal(closed.recordingPermitted, false);
    await f.capture();
    await f.withdraw(captured.id);
    assert.deepEqual(await f.readSession(), closed);
    await f.assertGuards();
  });
}

/**
 * Intercept only this transaction's audit values writer, before it executes
 * SQL. A SQL trigger would abort PostgreSQL's transaction independently and
 * would therefore hide logAudit's non-strict error swallowing.
 */
function failAuditBeforeSql(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, action: string) {
  const originalTransaction = f.db.transaction.bind(f.db);
  let faults = 0;
  const fault = new Error(`F2 pre-SQL audit fault: ${action}`);
  const mocked = t.mock.method(f.db, "transaction", (
    callback: Parameters<typeof originalTransaction>[0],
    config: Parameters<typeof originalTransaction>[1],
  ) =>
    originalTransaction(async (tx) => {
      const originalInsert = tx.insert.bind(tx);
      t.mock.method(tx, "insert", (table: Parameters<typeof originalInsert>[0]) => {
        const builder = originalInsert(table);
        if (table === f.auditLogs) {
          const originalValues = builder.values.bind(builder);
          t.mock.method(builder, "values", (input: typeof f.auditLogs.$inferInsert | (typeof f.auditLogs.$inferInsert)[]) => {
            if (!Array.isArray(input) && input.action === action) {
              faults++;
              throw fault;
            }
            return originalValues(input);
          });
        }
        return builder;
      });
      return callback(tx);
    }, config),
  );
  return { fault, count: () => faults, restore: () => mocked.mock.restore() };
}

for (const operation of ["capture", "withdraw", "permission-denied"] as const) {
  test(`${operation} pre-SQL audit failure rolls back consent, session state and transaction audits`, options, async (t) => {
    const f = await fixture(t);
    const captured = await f.capture();
    await f.db.update(f.growCallSessions).set({
      recordingStatus: "PERMITTED_NOT_CAPTURED",
      recordingPermitted: true,
    }).where(eq(f.growCallSessions.id, f.session.id));
    const before = { session: await f.readSession(), consents: await f.readConsents(), audits: await f.readAudits() };
    const action = operation === "capture"
      ? "grow_call_recording_consent_captured"
      : operation === "withdraw" ? "grow_call_recording_consent_withdrawn" : "grow_call_recording_permission_denied";
    const injected = failAuditBeforeSql(t, f, action);
    let rejected: unknown;
    try {
      try {
        if (operation === "capture") await f.capture();
        else await f.withdraw(captured.id);
      } catch (error) {
        rejected = error;
      }
    } finally {
      injected.restore();
    }
    assert.equal(injected.count(), 1, "the intended pre-SQL fault must actually run");
    assert.deepEqual(await f.readConsents(), before.consents, "source mutation must roll back");
    assert.deepEqual(await f.readSession(), before.session, "permission and association must roll back");
    assert.deepEqual(await f.readAudits(), before.audits, "earlier transaction audit writes must roll back too");
    assert.equal(rejected, injected.fault, "the caller must receive the original audit failure");
  });
}

test("open-session capture stays fail-closed and successful withdrawal atomically records permission denial", options, async (t) => {
  const f = await fixture(t);
  const captured = await f.capture();
  const open = await f.readSession();
  assert.equal(open.recordingPermitted, false);
  assert.equal(open.recordingConsentId, captured.id);
  await f.db.update(f.growCallSessions).set({
    recordingStatus: "PERMITTED_NOT_CAPTURED",
    recordingPermitted: true,
  }).where(eq(f.growCallSessions.id, f.session.id));
  await f.withdraw(captured.id);
  const withdrawn = await f.readSession();
  assert.equal(withdrawn.status, "CONNECTED");
  assert.equal(withdrawn.recordingPermitted, false);
  assert.equal(withdrawn.recordingStatus, "UNRECORDED");
  assert.equal(withdrawn.recordingConsentId, null);
  assert.deepEqual((await f.readAudits()).map((row) => row.action), [
    "grow_call_recording_consent_captured",
    "grow_call_recording_consent_withdrawn",
    "grow_call_recording_permission_denied",
  ]);
});
