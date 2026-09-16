import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  brokerages,
  db,
  entitlementGrants,
  growCallRecordingConsents,
  growCallSessions,
  parties,
  users,
} from "@aee/db";
import {
  captureConsentState,
  recordConsentPolicy,
  recordDncrStatus,
} from "../../consentControlsPersistence.js";
import {
  PHONE_CALL_CONSENT_PURPOSE,
  PHONE_CALL_CONSENT_SCOPE,
} from "../eligibility.js";
import {
  allRecordingGatesPassed,
  evaluateRecordingGates,
  LIVE_RECORDING_APPROVAL_ENV,
} from "../recordingGates.js";
import {
  confirmInCallRecording,
  recordInCallRecordingDisclosure,
} from "../callSessions.js";
import { captureRecordingConsent, withdrawRecordingConsent } from "../consent.js";
import { invalidateEntitlementCache } from "../../entitlements/resolver.js";
import { cleanupBrokerages } from "../../../routes/__tests__/testSupport.js";

const passingGates = {
  entitlement: { passed: true },
  legalPolicy: { passed: true },
  legacyConsentAndDisclosure: { passed: true },
  adapterCapability: { passed: true },
  operationalApproval: { passed: true },
};

test("recording gate conjunction passes only when all five gates pass", () => {
  assert.equal(Object.keys(passingGates).length, 5);
  assert.equal(allRecordingGatesPassed(passingGates), true);
});

for (const gateName of Object.keys(passingGates)) {
  test(`recording gate independently denies when ${gateName} is false`, () => {
    const gates = Object.fromEntries(
      Object.entries(passingGates).map(([name, gate]) => [name, { passed: name === gateName ? false : gate.passed }]),
    );
    assert.equal(allRecordingGatesPassed(gates), false);
  });
}

const databaseEnabled = Boolean(process.env.DATABASE_URL);
const gateNames = [
  "entitlement",
  "legalPolicy",
  "legacyConsentAndDisclosure",
  "adapterCapability",
  "operationalApproval",
] as const;

type GateSession = Parameters<typeof evaluateRecordingGates>[0]["session"];

interface GateFixture {
  brokerageId: number;
  userId: number;
  partyId: number;
  recordingConsentId: number;
  callSessionId: number;
  policyVersion: string;
}

const fakeProviderCapabilities = {
  recording: true,
  transcription: false,
} as const;

const previousLiveRecordingApproval = () => process.env[LIVE_RECORDING_APPROVAL_ENV];

async function withLiveRecordingApproval<T>(
  value: string | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = previousLiveRecordingApproval();
  try {
    if (value === undefined) delete process.env[LIVE_RECORDING_APPROVAL_ENV];
    else process.env[LIVE_RECORDING_APPROVAL_ENV] = value;
    return await callback();
  } finally {
    if (previous === undefined) delete process.env[LIVE_RECORDING_APPROVAL_ENV];
    else process.env[LIVE_RECORDING_APPROVAL_ENV] = previous;
  }
}

async function createGateFixture(label: string): Promise<GateFixture> {
  const suffix = `${label}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const [brokerage] = await db
    .insert(brokerages)
    .values({ name: `Recording gates ${suffix}` })
    .returning();
  const [user] = await db
    .insert(users)
    .values({
      authProviderId: `recording-gates-${suffix}`,
      email: `recording-gates-${suffix}@example.test`,
      firstName: "Synthetic",
      lastName: "Gate Actor",
      role: "Agent",
      brokerageId: brokerage!.id,
    })
    .returning();
  const [party] = await db
    .insert(parties)
    .values({
      brokerageId: brokerage!.id,
      firstName: "Synthetic",
      lastName: "Gate Contact",
      email: `recording-gates-contact-${suffix}@example.test`,
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

  const policyVersion = `recording-gates-${suffix}`;
  await recordConsentPolicy({
    brokerageId: brokerage!.id,
    jurisdiction: "AU",
    version: policyVersion,
    effectiveAt: new Date(Date.now() - 60_000),
    dncrRequired: true,
    suppressionEnabled: true,
    timeZone: "Etc/UTC",
    allowedHoursStart: "00:00",
    allowedHoursEnd: "00:00",
    policyData: { recordingPolicy: { allowed: true, jurisdiction: "AU" } },
    recordedByUserId: user!.id,
  });
  await captureConsentState({
    brokerageId: brokerage!.id,
    partyId: party!.id,
    channel: "PHONE_CALL",
    state: "EXPRESS",
    source: "recording-gates-test",
    captureMethod: "synthetic-fixture",
    purpose: PHONE_CALL_CONSENT_PURPOSE,
    scope: PHONE_CALL_CONSENT_SCOPE,
    jurisdiction: "AU",
    recordedByUserId: user!.id,
  });
  await recordDncrStatus({
    brokerageId: brokerage!.id,
    partyId: party!.id,
    channel: "PHONE_CALL",
    jurisdiction: "AU",
    status: "CLEARED",
    checkedAt: new Date(Date.now() - 1_000),
    validUntil: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    reviewAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    source: "recording-gates-test",
    reference: `synthetic-dncr-${suffix}`,
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
    policyVersion,
  };
}

function gateSession(
  fixture: GateFixture,
  overrides: Partial<GateSession> = {},
): GateSession {
  return {
    brokerageId: fixture.brokerageId,
    partyId: fixture.partyId,
    destinationCountry: "AU",
    recordingRequested: true,
    recordingStatus: "PERMITTED_NOT_CAPTURED",
    recordingConsentId: fixture.recordingConsentId,
    ...overrides,
  };
}

async function evaluateFixture(
  fixture: GateFixture,
  options: {
    session?: GateSession;
    providerCapabilities?: { recording: boolean; transcription: boolean };
    actor?: { id: number; role: string; brokerageId: number };
  } = {},
) {
  return evaluateRecordingGates({
    session: options.session ?? gateSession(fixture),
    actor: options.actor ?? {
      id: fixture.userId,
      role: "Agent",
      brokerageId: fixture.brokerageId,
    },
    providerName: "synthetic-adapter",
    providerCapabilities: options.providerCapabilities ?? fakeProviderCapabilities,
  });
}

async function appendRecordingPolicy(
  fixture: GateFixture,
  policyData: Record<string, unknown>,
): Promise<void> {
  await recordConsentPolicy({
    brokerageId: fixture.brokerageId,
    jurisdiction: "AU",
    version: `recording-gates-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    effectiveAt: new Date(Date.now() - 1_000),
    dncrRequired: true,
    suppressionEnabled: true,
    timeZone: "Etc/UTC",
    allowedHoursStart: "00:00",
    allowedHoursEnd: "00:00",
    policyData,
    recordedByUserId: fixture.userId,
  });
}

test(
  "evaluateRecordingGates evaluates exactly five independent gates with real entitlement, policy, consent, and session evidence",
  { skip: !databaseEnabled, concurrency: false },
  async (t) => {
    const fixture = await createGateFixture("five-gate-matrix");
    const initialLiveRecordingApproval = process.env[LIVE_RECORDING_APPROVAL_ENV];
    t.after(async () => {
      invalidateEntitlementCache(fixture.brokerageId);
      await cleanupBrokerages([fixture.brokerageId]);
    });

    const allPassed = await withLiveRecordingApproval("true", () =>
      evaluateFixture(fixture),
    );
    assert.equal(allPassed.permitted, true);
    assert.equal(allPassed.evidence.allPassed, true);
    assert.equal(Object.keys(allPassed.evidence.gates).length, 5);
    assert.deepEqual(Object.keys(allPassed.evidence.gates).sort(), [...gateNames].sort());
    assert.equal(allPassed.outboundDecision?.evaluation.decision, "ELIGIBLE");
    assert.equal(allPassed.evidence.gates.legalPolicy.policyVersion, fixture.policyVersion);
    assert.equal(allPassed.evidence.gates.legalPolicy.policyVersion, allPassed.outboundDecision?.evaluation.policyVersion);
    assert.equal(allPassed.evidence.gates.legalPolicy.reason, "RECORDING_POLICY_ALLOWED");
    assert.equal(allPassed.evidence.gates.legacyConsentAndDisclosure.reason, "LEGACY_CONSENT_AND_DISCLOSURE_CONFIRMED");
    assert.equal(allPassed.evidence.gates.adapterCapability.reason, "ADAPTER_RECORDING_CAPABLE");
    assert.equal(allPassed.evidence.gates.operationalApproval.reason, "OPERATIONAL_RECORDING_APPROVED");

    const deniedReasons: Record<(typeof gateNames)[number], string> = {
      entitlement: "ENTITLEMENT_MISSING",
      legalPolicy: "RECORDING_POLICY_NOT_ALLOWED",
      legacyConsentAndDisclosure: "IN_CALL_CONFIRMATION_REQUIRED",
      adapterCapability: "ADAPTER_RECORDING_UNAVAILABLE",
      operationalApproval: "OPERATIONAL_RECORDING_NOT_APPROVED",
    };

    for (const gateName of gateNames) {
      if (gateName === "entitlement") {
        await db
          .delete(entitlementGrants)
          .where(
            and(
              eq(entitlementGrants.brokerageId, fixture.brokerageId),
              eq(entitlementGrants.entitlementKey, "grow.calling.recording"),
            ),
          );
        invalidateEntitlementCache(fixture.brokerageId);
      } else if (gateName === "legalPolicy") {
        await appendRecordingPolicy(fixture, {
          recordingPolicy: { allowed: false, jurisdiction: "AU" },
        });
      }

      const evaluation = await withLiveRecordingApproval(
        gateName === "operationalApproval" ? "false" : "true",
        () =>
          evaluateFixture(fixture, {
            session:
              gateName === "legacyConsentAndDisclosure"
                ? gateSession(fixture, { recordingStatus: "DISCLOSED" })
                : undefined,
            providerCapabilities:
              gateName === "adapterCapability"
                ? { recording: false, transcription: false }
                : undefined,
          }),
      );
      assert.equal(evaluation.permitted, false, `${gateName} must deny recording`);
      assert.equal(evaluation.evidence.allPassed, false);
      assert.equal(Object.keys(evaluation.evidence.gates).length, 5);
      for (const otherGate of gateNames) {
        assert.equal(
          evaluation.evidence.gates[otherGate].passed,
          otherGate !== gateName,
          `${otherGate} changed while testing ${gateName}`,
        );
      }
      assert.equal(evaluation.evidence.gates[gateName].reason, deniedReasons[gateName]);

      if (gateName === "entitlement") {
        await db.insert(entitlementGrants).values({
          brokerageId: fixture.brokerageId,
          entitlementKey: "grow.calling.recording",
          granteeType: "brokerage",
          granteeId: fixture.brokerageId,
          sourceType: "manual",
          status: "Active",
        });
        invalidateEntitlementCache(fixture.brokerageId);
      } else if (gateName === "legalPolicy") {
        await appendRecordingPolicy(fixture, {
          recordingPolicy: { allowed: true, jurisdiction: "AU" },
        });
      }
    }

    assert.equal(
      process.env[LIVE_RECORDING_APPROVAL_ENV],
      initialLiveRecordingApproval,
      "the operational flag must be restored after the matrix",
    );
  },
);

test(
  "recording consent is fail-closed for absent, withdrawn, and jurisdiction-mismatched evidence, while confirmed in-call state is required",
  { skip: !databaseEnabled, concurrency: false },
  async (t) => {
    const fixture = await createGateFixture("consent-states");
    t.after(async () => {
      invalidateEntitlementCache(fixture.brokerageId);
      await cleanupBrokerages([fixture.brokerageId]);
    });

    const present = await withLiveRecordingApproval("true", () => evaluateFixture(fixture));
    assert.equal(present.permitted, true);
    assert.equal(present.evidence.gates.legacyConsentAndDisclosure.passed, true);

    await withdrawRecordingConsent({
      brokerageId: fixture.brokerageId,
      consentId: fixture.recordingConsentId,
      withdrawnByUserId: fixture.userId,
      withdrawalReason: "synthetic withdrawal variant",
    });
    const absent = await withLiveRecordingApproval("true", () =>
      evaluateFixture(fixture, {
        session: gateSession(fixture, { recordingConsentId: null }),
      }),
    );
    assert.equal(absent.permitted, false);
    assert.equal(absent.evidence.gates.legacyConsentAndDisclosure.passed, false);
    assert.equal(absent.evidence.gates.legacyConsentAndDisclosure.reason, "LEGACY_RECORDING_CONSENT_INVALID");

    const withdrawn = await withLiveRecordingApproval("true", () => evaluateFixture(fixture));
    assert.equal(withdrawn.permitted, false);
    assert.equal(withdrawn.evidence.gates.legacyConsentAndDisclosure.reason, "LEGACY_RECORDING_CONSENT_INVALID");

    await db
      .update(growCallRecordingConsents)
      .set({ status: "ACTIVE", withdrawnAt: null, jurisdiction: "NZ" })
      .where(eq(growCallRecordingConsents.id, fixture.recordingConsentId));
    const jurisdictionMismatch = await withLiveRecordingApproval("true", () =>
      evaluateFixture(fixture),
    );
    assert.equal(jurisdictionMismatch.permitted, false);
    assert.equal(
      jurisdictionMismatch.evidence.gates.legacyConsentAndDisclosure.reason,
      "LEGACY_RECORDING_CONSENT_INVALID",
    );
    assert.equal(
      jurisdictionMismatch.evidence.gates.legacyConsentAndDisclosure.consentJurisdiction,
      "NZ",
    );

    await db
      .update(growCallRecordingConsents)
      .set({ jurisdiction: "AU" })
      .where(eq(growCallRecordingConsents.id, fixture.recordingConsentId));
    const disclosedOnly = await withLiveRecordingApproval("true", () =>
      evaluateFixture(fixture, {
        session: gateSession(fixture, { recordingStatus: "DISCLOSED" }),
      }),
    );
    assert.equal(disclosedOnly.permitted, false);
    assert.equal(disclosedOnly.evidence.gates.legacyConsentAndDisclosure.reason, "IN_CALL_CONFIRMATION_REQUIRED");

    const confirmed = await withLiveRecordingApproval("true", () =>
      evaluateFixture(fixture, {
        session: gateSession(fixture, { recordingStatus: "CONFIRMED" }),
      }),
    );
    assert.equal(confirmed.permitted, true);
    assert.equal(confirmed.evidence.gates.legacyConsentAndDisclosure.confirmedInCall, true);
  },
);

test(
  "the recording service persists a reasoned unrecorded action audit without a route or live provider",
  { skip: !databaseEnabled, concurrency: false },
  async (t) => {
    const fixture = await createGateFixture("service-audit");
    t.after(async () => {
      invalidateEntitlementCache(fixture.brokerageId);
      await cleanupBrokerages([fixture.brokerageId]);
    });

    await db
      .update(growCallSessions)
      .set({ recordingStatus: "DISCLOSURE_REQUIRED", recordingPermitted: false })
      .where(eq(growCallSessions.id, fixture.callSessionId));

    await withLiveRecordingApproval("true", async () => {
      const disclosed = await recordInCallRecordingDisclosure({
        brokerageId: fixture.brokerageId,
        callSessionId: fixture.callSessionId,
        disclosedByUserId: fixture.userId,
        disclosedByUserRole: "Agent",
      });
      assert.equal(disclosed.recordingStatus, "DISCLOSED");

      const confirmed = await confirmInCallRecording({
        brokerageId: fixture.brokerageId,
        callSessionId: fixture.callSessionId,
        confirmedByUserId: fixture.userId,
        actorRole: "Agent",
      });
      assert.equal(confirmed.recordingPermitted, false);
      assert.equal(confirmed.recordingStatus, "UNRECORDED");
    });

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
    const persistedEvidence = JSON.parse(recordingAudits[0]!.updatedValue ?? "{}") as {
      allPassed?: boolean;
      gates?: {
        adapterCapability?: { reason?: string };
        operationalApproval?: { reason?: string };
      };
    };
    assert.equal(persistedEvidence.allPassed, false);
    assert.equal(
      persistedEvidence.gates?.adapterCapability?.reason,
      "ADAPTER_RECORDING_UNAVAILABLE",
      "the service must persist the actual sandbox capability denial",
    );
    assert.equal(
      persistedEvidence.gates?.operationalApproval?.reason,
      "OPERATIONAL_RECORDING_APPROVED",
    );
  },
);