// AE GROW W3-B — TelephonyProvider adapter conformance contract.
//
// Companion to ../../communications/__tests__/providerConformance.ts, which
// carries the fuller rationale. Same purpose, same shape: the executable
// statement of what a candidate telephony adapter must do, so that choosing
// a vendor is an afternoon's work rather than a discovery exercise conducted
// in production. Not a `*.test.ts`, so the runner does not collect it
// directly; a test file calls runTelephonyProviderConformance() with a
// candidate.
//
// THE CONTRACT, IN PROSE
//
// 1. IDENTITY. `name` is a non-empty, stable string. It is persisted on
//    growCallSessions.provider and forms half of the (provider,
//    providerCallId) key that ../webhooks.ts deduplicates receipts by and
//    resolves sessions by, so an unstable name breaks both.
//
// 2. CAPABILITIES ARE CLAIMS, NOT PERMISSIONS. `capabilities.recording` and
//    `.transcription` must be real booleans, and they describe only what the
//    adapter is able to do. They grant nothing. The recording conjunction in
//    ../recordingGates.ts requires FIVE independent gates — entitlement,
//    legal policy, consent plus in-call disclosure and confirmation, adapter
//    capability, and operational approval — and adapter capability is one of
//    them, never a shortcut past the others. The harness proves this
//    directly, because "the adapter says it can record" is precisely the
//    reasoning by which a recording control gets quietly lost.
//
// 3. DIAL IS IDEMPOTENT PER CALL SESSION. dial() must return the same
//    providerCallId for the same callSessionId, and different ids for
//    different sessions. This is a stronger requirement than it looks and it
//    is the one most worth testing a vendor against: a retried dial that
//    mints a second provider call places a SECOND REAL PHONE CALL to a
//    contact, and leaves this app's session pointing at only one of them. A
//    vendor that cannot offer this needs a deduplicating wrapper, and that
//    cost belongs in the vendor comparison rather than in a later incident.
//
// 4. ERROR TAXONOMY. A dial that cannot proceed raises TelephonyProviderError
//    with one of its three codes (provider_error / live_provider_disabled /
//    missing_credentials) — never a bare Error and never a silently
//    successful-looking result. This mirrors the communications seam's
//    taxonomy and ai/voice/gateway.ts's, so the outbound domains speak one
//    error vocabulary.
//
// 5. TENANCY IS NEVER THE ADAPTER'S TO DECIDE. Neither the dial request nor
//    the dial result carries a brokerage id the adapter chose, and inbound
//    webhook handling resolves the call session by (provider,
//    providerCallId) alone, then uses THAT row's stored brokerageId for every
//    mutation (see ../webhooks.ts's header). An adapter that surfaced a
//    tenant id from a provider payload would let a third party nominate which
//    brokerage's calls it can touch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TelephonyProviderError, type TelephonyProvider } from "../provider.js";
import { allRecordingGatesPassed } from "../recordingGates.js";

const TENANCY_BEARING_KEYS = [
  "brokerageId",
  "brokerage_id",
  "brokerage",
  "tenantId",
  "tenant_id",
  "tenant",
  "accountId",
  "account_id",
  "organizationId",
  "organisationId",
  "orgId",
] as const;

export interface TelephonyProviderConformanceSubject {
  label: string;
  provider: TelephonyProvider;
  /** A brokerage id to dial under. Never reaches a real network for a conformant sandbox adapter. */
  brokerageId?: number;
  /** An E.164 destination the adapter accepts. Must be a test number. */
  destinationE164?: string;
  /**
   * Optional. A dial the adapter must refuse, and the code it must refuse
   * with. Adapters that cannot fail deterministically declare nothing and
   * clause 4 is proven only at the type level — say so rather than pretending.
   */
  refusal?: { label: string; callSessionId: number; expectedCode: TelephonyProviderError["code"] };
  /** Optional. If the adapter normalises inbound provider webhooks, clause 5 is proven against it. */
  normalizeWebhook?: (payload: Record<string, unknown>) => Record<string, unknown>;
}

function assertNoTenancy(value: unknown, what: string): void {
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of TENANCY_BEARING_KEYS) {
    assert.equal(
      Object.hasOwn(record, key),
      false,
      `${what} exposes "${key}". Tenancy is resolved from this app's own records, never carried up from a provider.`,
    );
  }
}

export function runTelephonyProviderConformance(subject: TelephonyProviderConformanceSubject): void {
  const { label, provider } = subject;
  const brokerageId = subject.brokerageId ?? 1;
  const destinationE164 = subject.destinationE164 ?? "+61400000001";

  // Clause 1.
  test(`telephony conformance[${label}]: exposes a non-empty, stable adapter name`, () => {
    assert.equal(typeof provider.name, "string");
    assert.ok(provider.name.length > 0, "adapter name must not be empty");
    assert.equal(provider.name, provider.name, "adapter name must be stable across reads");
  });

  // Clause 2.
  test(`telephony conformance[${label}]: reports both capabilities as real booleans`, () => {
    assert.equal(typeof provider.capabilities.recording, "boolean", "recording capability must be a boolean, not merely truthy");
    assert.equal(typeof provider.capabilities.transcription, "boolean", "transcription capability must be a boolean");
    assert.equal(provider.capabilities.recording, provider.capabilities.recording, "capabilities must be stable");
  });

  test(`telephony conformance[${label}]: a recording-capable claim does not by itself permit recording`, () => {
    // The five-gate conjunction, with adapter capability standing in for
    // whatever this adapter claims and every other gate failing. Recording
    // must still be refused. An adapter can never be the reason a recording
    // happens; it can only ever be one of the five reasons it may.
    const onlyCapability = {
      entitlement: { passed: false },
      legalPolicy: { passed: false },
      legacyConsentAndDisclosure: { passed: false },
      adapterCapability: { passed: provider.capabilities.recording },
      operationalApproval: { passed: false },
    };
    assert.equal(Object.keys(onlyCapability).length, 5);
    assert.equal(
      allRecordingGatesPassed(onlyCapability),
      false,
      "adapter capability alone must never satisfy the recording conjunction",
    );

    // And conversely: an adapter that cannot record must block recording even
    // when every other gate passes.
    if (!provider.capabilities.recording) {
      assert.equal(
        allRecordingGatesPassed({
          entitlement: { passed: true },
          legalPolicy: { passed: true },
          legacyConsentAndDisclosure: { passed: true },
          adapterCapability: { passed: false },
          operationalApproval: { passed: true },
        }),
        false,
        "a non-recording adapter must fail the conjunction regardless of the other four gates",
      );
    }
  });

  // Clause 3.
  test(`telephony conformance[${label}]: dial is idempotent per call session`, async () => {
    const callSessionId = 4_242;
    const first = await provider.dial({ callSessionId, brokerageId, destinationE164 });
    const second = await provider.dial({ callSessionId, brokerageId, destinationE164 });

    assert.equal(typeof first.providerCallId, "string");
    assert.ok(first.providerCallId.length > 0, "providerCallId must not be empty");
    assert.equal(
      second.providerCallId,
      first.providerCallId,
      "re-dialling the same call session must return the same providerCallId — a second id means a second real call was placed",
    );
  });

  test(`telephony conformance[${label}]: distinct call sessions get distinct provider call ids`, async () => {
    const a = await provider.dial({ callSessionId: 4_243, brokerageId, destinationE164 });
    const b = await provider.dial({ callSessionId: 4_244, brokerageId, destinationE164 });
    assert.notEqual(
      a.providerCallId,
      b.providerCallId,
      "colliding ids would let one session's webhook mutate another's — the id is half the webhook lookup key",
    );
  });

  // Clause 5 — the dial result must not carry tenancy the adapter chose.
  test(`telephony conformance[${label}]: the dial result carries no tenancy`, async () => {
    const result = await provider.dial({ callSessionId: 4_245, brokerageId, destinationE164 });
    assertNoTenancy(result, "TelephonyDialResult");
  });

  // Clause 4.
  if (subject.refusal) {
    const refusal = subject.refusal;
    test(`telephony conformance[${label}]: refusal "${refusal.label}" raises a typed TelephonyProviderError`, async () => {
      await assert.rejects(
        () => provider.dial({ callSessionId: refusal.callSessionId, brokerageId, destinationE164 }),
        (err: unknown) => {
          assert.ok(err instanceof TelephonyProviderError, "must be TelephonyProviderError, not a bare Error");
          assert.equal(err.code, refusal.expectedCode);
          assert.equal(err.provider, provider.name);
          return true;
        },
      );
    });
  }

  // Clause 5 — inbound webhook tenancy.
  if (subject.normalizeWebhook) {
    const normalizeWebhook = subject.normalizeWebhook;
    test(`telephony conformance[${label}]: webhook normalisation discards tenancy claimed by the payload`, () => {
      const hostile: Record<string, unknown> = { providerCallId: "abc", event: "call.completed" };
      for (const key of TENANCY_BEARING_KEYS) hostile[key] = 999_999;
      const normalized = normalizeWebhook(hostile);
      assertNoTenancy(normalized, "normalised telephony webhook event");
      assert.equal(
        normalized.providerCallId,
        "abc",
        "the provider call id must survive — it is how the session (and therefore the tenant) is resolved server-side",
      );
    });
  }
}
