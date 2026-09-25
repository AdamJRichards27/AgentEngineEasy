// AE GROW D-6 — the call-session row stores the adapter's name.
//
// THE DEFECT
//
// createCallSession inserted grow_call_sessions.provider as the literal
// "sandbox". The module already owns a TelephonyProvider and already passes
// that adapter's name into evaluateRecordingGates. A future adapter swapped
// onto the same instance would still have been labelled sandbox on the row.
//
// WHAT THIS FILE PINS
//
//   * With an in-process adapter whose name is not "sandbox", the persisted
//     provider column equals that adapter's name. The old hardcoded insert
//     would store "sandbox" and fail this assertion.
//   * After the test seam is cleared, a session created on the shipped
//     sandbox adapter stores that adapter's own name.
//
// The labelled adapter dials nothing and is not a live provider.
// LIVE_*_APPROVED is not read or set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { brokerages, db, growCallSessions, parties, users } from "@aee/db";
import { captureConsentState, recordConsentPolicy, recordDncrStatus } from "../../consentControlsPersistence.js";
import { PHONE_CALL_CONSENT_PURPOSE, PHONE_CALL_CONSENT_SCOPE } from "../eligibility.js";
import type { TelephonyDialRequest, TelephonyDialResult, TelephonyProvider } from "../provider.js";
import { SandboxTelephonyProvider } from "../sandboxProvider.js";
import { createCallSession, setTelephonyProviderForTests } from "../callSessions.js";
import { cleanupBrokerages } from "../../../routes/__tests__/testSupport.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);

const LABELLED_ADAPTER_NAME = "labelled-adapter";

class LabelledTelephonyProvider implements TelephonyProvider {
  readonly name = LABELLED_ADAPTER_NAME;
  readonly capabilities = { recording: false, transcription: false } as const;

  async dial(_request: TelephonyDialRequest): Promise<TelephonyDialResult> {
    throw new Error("D-6 create must not dial.");
  }
}

async function createEligibleContact(label: string): Promise<{ brokerageId: number; userId: number; partyId: number }> {
  const suffix = `${label}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const mobile = "+61400111006";
  const [brokerage] = await db.insert(brokerages).values({ name: `D-6 provider ${suffix}` }).returning();
  const [user] = await db
    .insert(users)
    .values({
      authProviderId: `d6-provider-${suffix}`,
      email: `d6-provider-${suffix}@example.test`,
      firstName: "Synthetic",
      lastName: "Caller",
      role: "Agent",
      brokerageId: brokerage!.id,
    })
    .returning();
  const [party] = await db
    .insert(parties)
    .values({
      brokerageId: brokerage!.id,
      firstName: "Synthetic",
      lastName: "Contact",
      email: `d6-contact-${suffix}@example.test`,
      mobile,
    })
    .returning();

  await recordConsentPolicy({
    brokerageId: brokerage!.id,
    jurisdiction: "AU",
    version: `d6-call-${suffix}`,
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
    source: "d6-provider-fixture",
    captureMethod: "test-fixture",
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
    source: "d6-provider-fixture",
    reference: `dncr-d6-${party!.id}`,
    recordedByUserId: user!.id,
  });

  return { brokerageId: brokerage!.id, userId: user!.id, partyId: party!.id };
}

async function persistedProvider(callSessionId: number): Promise<string> {
  const [row] = await db.select({ provider: growCallSessions.provider }).from(growCallSessions).where(eq(growCallSessions.id, callSessionId)).limit(1);
  if (!row) throw new Error(`call session ${callSessionId} was not persisted`);
  return row.provider;
}

test(
  "D-6: the persisted call provider equals the adapter name, not a hardcoded sandbox literal",
  { skip: !databaseEnabled, concurrency: false },
  async (t) => {
    const fixture = await createEligibleContact("labelled");
    const labelled = new LabelledTelephonyProvider();
    t.after(async () => {
      setTelephonyProviderForTests(null);
      await cleanupBrokerages([fixture.brokerageId]);
    });

    assert.notEqual(labelled.name, "sandbox");
    setTelephonyProviderForTests(labelled);
    const labelledSession = await createCallSession({
      brokerageId: fixture.brokerageId,
      partyId: fixture.partyId,
      initiatedByUserId: fixture.userId,
    });
    assert.equal(labelledSession.provider, labelled.name);
    assert.equal(await persistedProvider(labelledSession.id), labelled.name);

    setTelephonyProviderForTests(null);
    const sandbox = new SandboxTelephonyProvider();
    const sandboxSession = await createCallSession({
      brokerageId: fixture.brokerageId,
      partyId: fixture.partyId,
      initiatedByUserId: fixture.userId,
    });
    assert.equal(sandbox.name, "sandbox");
    assert.equal(sandboxSession.provider, sandbox.name);
    assert.equal(await persistedProvider(sandboxSession.id), sandbox.name);
  },
);
