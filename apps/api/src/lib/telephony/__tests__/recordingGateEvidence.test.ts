// AE GROW W3-B (D-4) — recording-gate evidence regression.
//
// THE DEFECT
//
// evaluateRecordingGates()'s in-transaction branch recorded a consent
// decision (evaluateOutboundCallEligibilityInTransaction persists a
// growConsentDecisions row whatever the outcome) but then kept the returned
// object only `if (recorded.evaluation.decision === "ELIGIBLE")`. Everything
// else fell through to null, so the evidence written at the bottom of that
// function — outboundDecisionId and outboundReasonCode — was persisted as
// null EXACTLY when the call was blocked. The row explaining why it was
// blocked still existed in the database; the recording-gate evidence simply
// stopped pointing at it, at the one moment anyone reviewing that evidence
// would care.
//
// The read-only branch immediately below it passes throwIfIneligible: false
// and keeps whatever it resolves, with no such asymmetry — which is what
// marks the transaction branch as an oversight rather than a design.
//
// The non-transaction branch is a second drop of the same evidence. It calls
// evaluateOutboundCallEligibility, which writes the row and then throws
// CallConsentEligibilityError carrying that row's id and reason code. An
// empty catch used to discard both, so outboundDecisionId and
// outboundReasonCode were null on that path too, again exactly when the
// call was blocked. The catch now keeps those two fields and still does not
// feed the blocked decision into the legalPolicy gate.
//
// WHAT THIS FILE PINS
//
//   * A blocked in-transaction evaluation carries a non-null decision id and
//     the correct reason code, and that id resolves to the real
//     growConsentDecisions row with a matching reason code.
//   * The five gate outcomes are UNCHANGED by that fix. This is the half of
//     the regression that is easy to miss: outboundDecision also supplies the
//     policy snapshot, jurisdiction and policyVersion that feed the
//     legalPolicy gate, so retaining an ineligible decision in that variable
//     — rather than in a separate evidence-only one — would have let a
//     blocked call's policy snapshot satisfy a recording gate. Widening the
//     conjunction is out of scope for this slice and is the wrong direction
//     regardless, so it is asserted against here rather than left to review.

import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  brokerages,
  db,
  entitlementGrants,
  growCallSessions,
  growConsentDecisions,
  parties,
  users,
} from "@aee/db";
import { recordConsentPolicy, withConsentBrokerageLock } from "../../consentControlsPersistence.js";
import { evaluateRecordingGates, LIVE_RECORDING_APPROVAL_ENV } from "../recordingGates.js";
import { confirmInCallRecording } from "../callSessions.js";
import { captureRecordingConsent } from "../consent.js";
import { invalidateEntitlementCache } from "../../entitlements/resolver.js";
import { cleanupBrokerages } from "../../../routes/__tests__/testSupport.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);

const recordingCapableAdapter = { recording: true, transcription: false } as const;

interface EvidenceFixture {
  brokerageId: number;
  userId: number;
  partyId: number;
  recordingConsentId: number;
  callSessionId: number;
}

/**
 * Deliberately does NOT capture a PHONE_CALL consent state and does NOT
 * record a DNCR clearance, so the authoritative outbound decision evaluates
 * to something other than ELIGIBLE — the blocked case whose evidence used to
 * be discarded. Everything else (entitlement, policy, recording consent,
 * connected session) is present so the remaining gates have real evidence to
 * evaluate rather than failing for incidental reasons.
 */
async function createEvidenceFixture(label: string): Promise<EvidenceFixture> {
  const suffix = `${label}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const [brokerage] = await db.insert(brokerages).values({ name: `Recording evidence ${suffix}` }).returning();
  const [user] = await db
    .insert(users)
    .values({
      authProviderId: `recording-evidence-${suffix}`,
      email: `recording-evidence-${suffix}@example.test`,
      firstName: "Synthetic",
      lastName: "Evidence Actor",
      role: "Agent",
      brokerageId: brokerage!.id,
    })
    .returning();
  const [party] = await db
    .insert(parties)
    .values({
      brokerageId: brokerage!.id,
      firstName: "Synthetic",
      lastName: "Evidence Contact",
      email: `recording-evidence-contact-${suffix}@example.test`,
    })
    .returning();

  await db.insert(entitlementGrants).values({
    brokerageId: brokerage!.id,
    entitlementKey: "grow.calling.recording",
    granteeType: "brokerage",
    granteeId: brokerage!.id,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerage!.id);

  await recordConsentPolicy({
    brokerageId: brokerage!.id,
    jurisdiction: "AU",
    version: `recording-evidence-${suffix}`,
    effectiveAt: new Date(Date.now() - 60_000),
    dncrRequired: true,
    suppressionEnabled: true,
    timeZone: "Etc/UTC",
    allowedHoursStart: "00:00",
    allowedHoursEnd: "00:00",
    policyData: { recordingPolicy: { allowed: true, jurisdiction: "AU" } },
    recordedByUserId: user!.id,
  });

  const recordingConsent = await captureRecordingConsent({
    brokerageId: brokerage!.id,
    partyId: party!.id,
    scope: "STANDING",
    source: "VERBAL_ON_CALL",
    capturedByUserId: user!.id,
    jurisdiction: "AU",
    consentVersion: "synthetic-recording-consent-v1",
    evidenceMetadata: { synthetic: true },
  });

  const [session] = await db
    .insert(growCallSessions)
    .values({
      brokerageId: brokerage!.id,
      partyId: party!.id,
      initiatedByUserId: user!.id,
      destinationRaw: "+61400000001",
      destinationNormalized: "+61400000001",
      destinationCountry: "AU",
      provider: "sandbox",
      status: "CONNECTED",
      recordingRequested: true,
      recordingPermitted: false,
      recordingConsentId: recordingConsent.id,
      recordingStatus: "PERMITTED_NOT_CAPTURED",
    })
    .returning();

  return {
    brokerageId: brokerage!.id,
    userId: user!.id,
    partyId: party!.id,
    recordingConsentId: recordingConsent.id,
    callSessionId: session!.id,
  };
}

test(
  "D-4: a blocked in-transaction recording evaluation retains its decision id and reason code",
  { skip: !databaseEnabled, concurrency: false },
  async (t) => {
    const fixture = await createEvidenceFixture("blocked-evidence");
    const previousApproval = process.env[LIVE_RECORDING_APPROVAL_ENV];
    t.after(async () => {
      if (previousApproval === undefined) delete process.env[LIVE_RECORDING_APPROVAL_ENV];
      else process.env[LIVE_RECORDING_APPROVAL_ENV] = previousApproval;
      invalidateEntitlementCache(fixture.brokerageId);
      await cleanupBrokerages([fixture.brokerageId]);
    });

    // Operational approval on, so the evaluation is not short-circuited by an
    // unrelated gate and the outbound decision genuinely drives the outcome.
    process.env[LIVE_RECORDING_APPROVAL_ENV] = "true";

    const evaluation = await withConsentBrokerageLock(fixture.brokerageId, (tx) =>
      evaluateRecordingGates({
        session: {
          brokerageId: fixture.brokerageId,
          partyId: fixture.partyId,
          destinationCountry: "AU",
          recordingRequested: true,
          recordingStatus: "PERMITTED_NOT_CAPTURED",
          recordingConsentId: fixture.recordingConsentId,
        },
        actor: { id: fixture.userId, role: "Agent", brokerageId: fixture.brokerageId },
        providerName: "synthetic-adapter",
        providerCapabilities: recordingCapableAdapter,
        tx,
      }),
    );

    // The call is blocked: this is the case whose evidence used to be lost.
    assert.equal(evaluation.permitted, false, "no consent was captured, so recording must be refused");
    assert.equal(evaluation.evidence.allPassed, false);

    // The defect, pinned.
    assert.notEqual(
      evaluation.evidence.outboundDecisionId,
      null,
      "a blocked evaluation must still point at the decision row it just wrote",
    );
    assert.equal(typeof evaluation.evidence.outboundDecisionId, "number");
    assert.notEqual(
      evaluation.evidence.outboundReasonCode,
      null,
      "the reason the call was blocked is the whole point of the evidence",
    );

    // The id must resolve to the real row, with a matching reason code and a
    // non-eligible decision — not merely be non-null.
    const [decision] = await db
      .select()
      .from(growConsentDecisions)
      .where(eq(growConsentDecisions.id, evaluation.evidence.outboundDecisionId!));
    assert.ok(decision, "the retained decision id must resolve to a real growConsentDecisions row");
    assert.equal(decision.brokerageId, fixture.brokerageId, "and that row must belong to this tenant");
    assert.notEqual(decision.decision, "ELIGIBLE", "the recorded decision must be the blocking one");
    assert.equal(
      evaluation.evidence.outboundReasonCode,
      decision.reasonCode,
      "the evidence's reason code must be the recorded decision's own reason code, not a reconstruction",
    );
  },
);

test(
  "D-4: retaining blocked evidence does not widen the five-gate recording conjunction",
  { skip: !databaseEnabled, concurrency: false },
  async (t) => {
    const fixture = await createEvidenceFixture("conjunction-unchanged");
    const previousApproval = process.env[LIVE_RECORDING_APPROVAL_ENV];
    t.after(async () => {
      if (previousApproval === undefined) delete process.env[LIVE_RECORDING_APPROVAL_ENV];
      else process.env[LIVE_RECORDING_APPROVAL_ENV] = previousApproval;
      invalidateEntitlementCache(fixture.brokerageId);
      await cleanupBrokerages([fixture.brokerageId]);
    });
    process.env[LIVE_RECORDING_APPROVAL_ENV] = "true";

    const evaluation = await withConsentBrokerageLock(fixture.brokerageId, (tx) =>
      evaluateRecordingGates({
        session: {
          brokerageId: fixture.brokerageId,
          partyId: fixture.partyId,
          destinationCountry: "AU",
          recordingRequested: true,
          recordingStatus: "PERMITTED_NOT_CAPTURED",
          recordingConsentId: fixture.recordingConsentId,
        },
        actor: { id: fixture.userId, role: "Agent", brokerageId: fixture.brokerageId },
        providerName: "synthetic-adapter",
        providerCapabilities: recordingCapableAdapter,
        tx,
      }),
    );

    assert.equal(Object.keys(evaluation.evidence.gates).length, 5, "still exactly five gates");

    // The blocked decision's policy snapshot must NOT have been promoted into
    // the legalPolicy gate. The fixture's policy explicitly allows recording
    // in AU, so if an ineligible decision's snapshot were feeding this gate it
    // would read RECORDING_POLICY_ALLOWED. It must not.
    assert.equal(
      evaluation.evidence.gates.legalPolicy.passed,
      false,
      "a blocked call's policy snapshot must not satisfy the legal-policy gate",
    );
    assert.equal(evaluation.evidence.gates.legalPolicy.reason, "RECORDING_POLICY_NOT_CONFIGURED");
    assert.equal(evaluation.evidence.gates.legalPolicy.policyVersion, null);

    // The function's own return value keeps its eligibility semantics: only an
    // ELIGIBLE decision is surfaced there, because callers treat it as the
    // authoritative call permission rather than as evidence.
    assert.equal(evaluation.outboundDecision, null, "an ineligible decision must not be returned as the call authority");

    // ...while the evidence still records it.
    assert.notEqual(evaluation.evidence.outboundDecisionId, null);
  },
);

test(
  "D-4: a blocked non-transaction recording evaluation retains the thrown decision id and reason code",
  { skip: !databaseEnabled, concurrency: false },
  async (t) => {
    const fixture = await createEvidenceFixture("blocked-thrown-evidence");
    const previousApproval = process.env[LIVE_RECORDING_APPROVAL_ENV];
    t.after(async () => {
      if (previousApproval === undefined) delete process.env[LIVE_RECORDING_APPROVAL_ENV];
      else process.env[LIVE_RECORDING_APPROVAL_ENV] = previousApproval;
      invalidateEntitlementCache(fixture.brokerageId);
      await cleanupBrokerages([fixture.brokerageId]);
    });
    process.env[LIVE_RECORDING_APPROVAL_ENV] = "true";

    // No tx and not readOnly: this is the branch that records the decision
    // and then throws. The reason must still land on the evidence.
    const evaluation = await evaluateRecordingGates({
      session: {
        brokerageId: fixture.brokerageId,
        partyId: fixture.partyId,
        destinationCountry: "AU",
        recordingRequested: true,
        recordingStatus: "PERMITTED_NOT_CAPTURED",
        recordingConsentId: fixture.recordingConsentId,
      },
      actor: { id: fixture.userId, role: "Agent", brokerageId: fixture.brokerageId },
      providerName: "synthetic-adapter",
      providerCapabilities: recordingCapableAdapter,
    });

    assert.equal(evaluation.permitted, false);
    assert.equal(evaluation.evidence.allPassed, false);
    assert.equal(evaluation.outboundDecision, null, "a thrown ineligible decision must not become the call authority");
    assert.equal(evaluation.evidence.gates.legalPolicy.passed, false);
    assert.equal(evaluation.evidence.gates.legalPolicy.reason, "RECORDING_POLICY_NOT_CONFIGURED");
    assert.equal(evaluation.evidence.gates.legalPolicy.policyVersion, null);
    assert.equal(typeof evaluation.evidence.outboundDecisionId, "number");
    assert.notEqual(evaluation.evidence.outboundReasonCode, null);

    const [decision] = await db
      .select()
      .from(growConsentDecisions)
      .where(eq(growConsentDecisions.id, evaluation.evidence.outboundDecisionId!));
    assert.ok(decision, "the retained id must resolve to the row the thrown evaluator wrote");
    assert.equal(decision.brokerageId, fixture.brokerageId);
    assert.notEqual(decision.decision, "ELIGIBLE");
    assert.equal(evaluation.evidence.outboundReasonCode, decision.reasonCode);
  },
);

test(
  "D-4: a blocked read-only recording evaluation keeps the reason code and does not invent a decision id",
  { skip: !databaseEnabled, concurrency: false },
  async (t) => {
    const fixture = await createEvidenceFixture("blocked-readonly-evidence");
    const previousApproval = process.env[LIVE_RECORDING_APPROVAL_ENV];
    t.after(async () => {
      if (previousApproval === undefined) delete process.env[LIVE_RECORDING_APPROVAL_ENV];
      else process.env[LIVE_RECORDING_APPROVAL_ENV] = previousApproval;
      invalidateEntitlementCache(fixture.brokerageId);
      await cleanupBrokerages([fixture.brokerageId]);
    });
    process.env[LIVE_RECORDING_APPROVAL_ENV] = "true";

    const before = await db
      .select({ id: growConsentDecisions.id })
      .from(growConsentDecisions)
      .where(eq(growConsentDecisions.brokerageId, fixture.brokerageId));

    const evaluation = await evaluateRecordingGates({
      session: {
        brokerageId: fixture.brokerageId,
        partyId: fixture.partyId,
        destinationCountry: "AU",
        recordingRequested: true,
        recordingStatus: "PERMITTED_NOT_CAPTURED",
        recordingConsentId: fixture.recordingConsentId,
      },
      actor: { id: fixture.userId, role: "Agent", brokerageId: fixture.brokerageId },
      providerName: "synthetic-adapter",
      providerCapabilities: recordingCapableAdapter,
      readOnly: true,
    });

    const after = await db
      .select({ id: growConsentDecisions.id })
      .from(growConsentDecisions)
      .where(eq(growConsentDecisions.brokerageId, fixture.brokerageId));
    assert.equal(after.length, before.length, "a read-only evaluation must not write a consent decision");
    assert.notEqual(evaluation.outboundDecision, null);
    assert.notEqual(evaluation.outboundDecision?.evaluation.decision, "ELIGIBLE");
    assert.equal(evaluation.evidence.outboundDecisionId, null, "read-only evidence must not manufacture an authority id");
    assert.equal(
      evaluation.evidence.outboundReasonCode,
      evaluation.outboundDecision?.evaluation.reasonCode,
      "the blocked reason on a read must be the evaluator's own reason code",
    );
    assert.equal(typeof evaluation.evidence.outboundReasonCode, "string");
    assert.notEqual(evaluation.evidence.outboundReasonCode, "");
  },
);

test(
  "D-4: confirming a blocked call persists the non-eligible decision id and reason on the unrecorded audit",
  { skip: !databaseEnabled, concurrency: false },
  async (t) => {
    const fixture = await createEvidenceFixture("blocked-persisted-audit");
    const previousApproval = process.env[LIVE_RECORDING_APPROVAL_ENV];
    t.after(async () => {
      if (previousApproval === undefined) delete process.env[LIVE_RECORDING_APPROVAL_ENV];
      else process.env[LIVE_RECORDING_APPROVAL_ENV] = previousApproval;
      invalidateEntitlementCache(fixture.brokerageId);
      await cleanupBrokerages([fixture.brokerageId]);
    });
    process.env[LIVE_RECORDING_APPROVAL_ENV] = "true";

    await db
      .update(growCallSessions)
      .set({ recordingStatus: "DISCLOSED", recordingPermitted: false })
      .where(eq(growCallSessions.id, fixture.callSessionId));

    const confirmed = await confirmInCallRecording({
      brokerageId: fixture.brokerageId,
      callSessionId: fixture.callSessionId,
      confirmedByUserId: fixture.userId,
      actorRole: "Agent",
    });
    assert.equal(confirmed.recordingPermitted, false);
    assert.equal(confirmed.recordingStatus, "UNRECORDED");

    const recordingAudits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "grow_call_recording_unrecorded"),
          eq(auditLogs.recordId, String(fixture.callSessionId)),
        ),
      );
    assert.equal(recordingAudits.length, 1);
    const persisted = JSON.parse(recordingAudits[0]!.updatedValue ?? "{}") as {
      allPassed?: boolean;
      outboundDecisionId?: number | null;
      outboundReasonCode?: string | null;
      gates?: { legalPolicy?: { passed?: boolean; reason?: string; policyVersion?: string | null } };
    };
    assert.equal(persisted.allPassed, false);
    assert.equal(typeof persisted.outboundDecisionId, "number");
    assert.notEqual(persisted.outboundReasonCode, null);
    assert.equal(persisted.gates?.legalPolicy?.passed, false);
    assert.equal(persisted.gates?.legalPolicy?.reason, "RECORDING_POLICY_NOT_CONFIGURED");
    assert.equal(persisted.gates?.legalPolicy?.policyVersion ?? null, null);

    const [decision] = await db
      .select()
      .from(growConsentDecisions)
      .where(eq(growConsentDecisions.id, persisted.outboundDecisionId!));
    assert.ok(decision);
    assert.equal(decision.brokerageId, fixture.brokerageId);
    assert.notEqual(decision.decision, "ELIGIBLE");
    assert.equal(persisted.outboundReasonCode, decision.reasonCode);
  },
);
