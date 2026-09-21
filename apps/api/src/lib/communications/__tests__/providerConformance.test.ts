// AE GROW W3-B — conformance run + dispatch-seam activation gate.
//
// Three things are proven here:
//
//   1. The existing sandbox adapters satisfy the conformance contract in
//      providerConformance.ts. If they did not, the contract would be
//      describing an adapter nobody has written rather than the one the
//      product actually dispatches through.
//   2. The same contract runs unchanged against an adapter that did not
//      exist when the contract was written (CandidateEmailAdapter /
//      CandidateSmsAdapter below). That is the property that makes a future
//      vendor decision cheap, and it is only credible if demonstrated.
//   3. The seam in providers/registry.ts is fail-closed: sandbox by default,
//      byte-identical to the behaviour it replaced, and a typed
//      live_provider_disabled error — never a quiet downgrade — for any
//      non-sandbox selection without LIVE_COMMUNICATIONS_APPROVED.
//
// Nothing here activates, or makes activatable, a live provider. The
// candidate adapters are in-memory objects defined in this test file; they
// make no network call, have no credential, and are unreachable from the app.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runEmailProviderConformance,
  runSmsProviderConformance,
} from "./providerConformance.js";
import { SANDBOX_EMAIL_PROVIDER_NAME, sandboxEmailProvider } from "../providers/sandboxEmail.js";
import { SANDBOX_SMS_PROVIDER_NAME, sandboxSmsProvider } from "../providers/sandboxSms.js";
import {
  EMAIL_PROVIDER_ENV,
  LIVE_COMMUNICATIONS_APPROVAL_ENV,
  SANDBOX_PROVIDER_ID,
  SMS_PROVIDER_ENV,
  loadCommunicationProviderConfig,
  resetCommunicationProvidersForTests,
  resolveEmailProvider,
  resolveSmsProvider,
  setCommunicationProvidersForTests,
} from "../providers/registry.js";
import { CommunicationProviderError, type EmailProvider, type ProviderSendResult, type SmsProvider } from "../providers/types.js";

// ---------------------------------------------------------------------------
// 1. The shipped sandbox adapters against the contract.
// ---------------------------------------------------------------------------

runEmailProviderConformance({
  label: "sandbox_email",
  provider: sandboxEmailProvider,
  deliverable: { to: "conformance@example.test", subject: "Conformance", bodyText: "body", bodyHtml: null },
  rejections: [
    {
      label: "undeliverable address",
      input: { to: "sandboxfail+invalid@example.test", subject: null, bodyText: "body", bodyHtml: null },
      expectedFailureCategory: "INVALID_DESTINATION",
    },
    {
      label: "provider timeout",
      input: { to: "sandboxfail+timeout@example.test", subject: null, bodyText: "body", bodyHtml: null },
      expectedFailureCategory: "PROVIDER_TIMEOUT",
    },
  ],
  // The sandbox mints a fresh providerMessageId per call and holds no state,
  // so it cannot claim provider-side replay suppression. Declaring this
  // honestly is the point of the flag — and it costs nothing here, because
  // the sandbox delivers nothing to duplicate.
  supportsIdempotentReplay: false,
});

runSmsProviderConformance({
  label: "sandbox_sms",
  provider: sandboxSmsProvider,
  // Deliberately not a +6140000000x number: the sandbox treats a run of seven
  // zeros as its undeliverable-number trigger, which this fixture must avoid.
  deliverable: { to: "+61412345678", bodyText: "body" },
  rejections: [
    {
      label: "undeliverable number",
      input: { to: "+61400000000", bodyText: "body" },
      expectedFailureCategory: "INVALID_DESTINATION",
    },
    {
      label: "provider timeout",
      input: { to: "+61499999999", bodyText: "body" },
      expectedFailureCategory: "PROVIDER_TIMEOUT",
    },
  ],
  supportsIdempotentReplay: false,
});

// ---------------------------------------------------------------------------
// 2. A candidate adapter the contract has never seen.
//
// Stands in for whatever vendor is eventually chosen: it keeps per-key state
// so it CAN honour idempotent replay, maps its own opaque vendor codes onto
// the shared failure taxonomy, and normalises a webhook payload. It exists
// only to demonstrate that a new adapter is conformance-tested by writing a
// subject literal and nothing else — no product-code change, no registration.
// ---------------------------------------------------------------------------

const CANDIDATE_VENDOR_CODES: Record<string, ProviderSendResult["failureCategory"]> = {
  "recipient-unreachable": "INVALID_DESTINATION",
  "upstream-congested": "RATE_LIMITED",
};

function buildCandidate<TInput extends { to: string; idempotencyKey: string }>(name: string) {
  const byKey = new Map<string, ProviderSendResult>();
  let counter = 0;
  return {
    name,
    async send(input: TInput): Promise<ProviderSendResult> {
      // Provider-side idempotent replay: the same key returns the original
      // receipt without sending again.
      const replay = byKey.get(input.idempotencyKey);
      if (replay) return replay;

      const vendorCode = Object.keys(CANDIDATE_VENDOR_CODES).find((code) => input.to.includes(code));
      counter += 1;
      const result: ProviderSendResult = vendorCode
        ? {
            provider: name,
            providerMessageId: `${name}-${counter}`,
            status: "FAILED",
            failureCategory: CANDIDATE_VENDOR_CODES[vendorCode],
            failureDetail: `Candidate vendor code: ${vendorCode}`,
          }
        : { provider: name, providerMessageId: `${name}-${counter}`, status: "SENT" };
      byKey.set(input.idempotencyKey, result);
      return result;
    },
  };
}

/** A vendor payload naming its own account/tenant; normalisation must drop it. */
function candidateNormalizeWebhook(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    providerMessageId: String(payload.messageId ?? ""),
    eventType: payload.status === "delivered" ? "DELIVERY_RECEIPT" : "BOUNCE",
  };
}

const candidateEmail: EmailProvider = buildCandidate<{ to: string; idempotencyKey: string }>("candidate_email");
const candidateSms: SmsProvider = buildCandidate<{ to: string; idempotencyKey: string }>("candidate_sms");

runEmailProviderConformance({
  label: "candidate_email",
  provider: candidateEmail,
  deliverable: { to: "candidate@example.test", subject: "Candidate", bodyText: "body", bodyHtml: null },
  rejections: [
    {
      label: "vendor code recipient-unreachable",
      input: { to: "recipient-unreachable@example.test", subject: null, bodyText: "body", bodyHtml: null },
      expectedFailureCategory: "INVALID_DESTINATION",
    },
    {
      label: "vendor code upstream-congested",
      input: { to: "upstream-congested@example.test", subject: null, bodyText: "body", bodyHtml: null },
      expectedFailureCategory: "RATE_LIMITED",
    },
  ],
  supportsIdempotentReplay: true,
  normalizeWebhook: candidateNormalizeWebhook,
});

runSmsProviderConformance({
  label: "candidate_sms",
  provider: candidateSms,
  deliverable: { to: "+61412345679", bodyText: "body" },
  rejections: [
    {
      label: "vendor code upstream-congested",
      input: { to: "+61412345679-upstream-congested", bodyText: "body" },
      expectedFailureCategory: "RATE_LIMITED",
    },
  ],
  supportsIdempotentReplay: true,
  normalizeWebhook: candidateNormalizeWebhook,
});

// ---------------------------------------------------------------------------
// 3. The activation gate.
// ---------------------------------------------------------------------------

const SEAM_ENV_KEYS = [LIVE_COMMUNICATIONS_APPROVAL_ENV, EMAIL_PROVIDER_ENV, SMS_PROVIDER_ENV] as const;

/**
 * Runs `callback` with the seam's environment set to exactly `values` —
 * every key not named is DELETED, not merely left alone, so "no env set"
 * genuinely means none. Restores the prior values afterwards.
 */
async function withSeamEnv<T>(values: Partial<Record<(typeof SEAM_ENV_KEYS)[number], string>>, callback: () => T | Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of SEAM_ENV_KEYS) {
    previous.set(key, process.env[key]);
    const next = values[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    return await callback();
  } finally {
    for (const key of SEAM_ENV_KEYS) {
      const prior = previous.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    resetCommunicationProvidersForTests();
  }
}

test("seam: with no environment set, resolution returns the exact sandbox singletons the outbox used to name directly", async () => {
  await withSeamEnv({}, () => {
    // Object identity, not merely equivalent behaviour. `===` against the
    // very objects outbox.ts imported before this slice is the strongest
    // available statement that the default dispatch path is unchanged: the
    // outbox calls .send() on the same instance it always did.
    assert.equal(resolveEmailProvider(), sandboxEmailProvider);
    assert.equal(resolveSmsProvider(), sandboxSmsProvider);
    assert.equal(resolveEmailProvider().name, SANDBOX_EMAIL_PROVIDER_NAME);
    assert.equal(resolveSmsProvider().name, SANDBOX_SMS_PROVIDER_NAME);

    const config = loadCommunicationProviderConfig();
    assert.deepEqual(config, { email: SANDBOX_PROVIDER_ID, sms: SANDBOX_PROVIDER_ID });
  });
});

test("seam: an explicit sandbox selection, or an empty selector, still resolves to the sandbox without approval", async () => {
  await withSeamEnv({ [EMAIL_PROVIDER_ENV]: "sandbox", [SMS_PROVIDER_ENV]: "  " }, () => {
    assert.equal(resolveEmailProvider(), sandboxEmailProvider);
    assert.equal(resolveSmsProvider(), sandboxSmsProvider);
  });
});

for (const [channel, selectorEnv, resolve] of [
  ["EMAIL", EMAIL_PROVIDER_ENV, resolveEmailProvider],
  ["SMS", SMS_PROVIDER_ENV, resolveSmsProvider],
] as const) {
  test(`seam: selecting a non-sandbox ${channel} provider without approval throws live_provider_disabled and never downgrades`, async () => {
    await withSeamEnv({ [selectorEnv]: "some_vendor" }, () => {
      let thrown: unknown;
      let returned: unknown;
      try {
        returned = resolve();
      } catch (err) {
        thrown = err;
      }
      assert.equal(returned, undefined, "resolution must not return an adapter at all");
      assert.ok(thrown instanceof CommunicationProviderError, "must be the typed seam error, not a bare Error");
      assert.equal(thrown.code, "live_provider_disabled");
      assert.equal(thrown.channel, channel);
      assert.equal(thrown.provider, "some_vendor");
      // The failure mode this guards against is the quiet substitution, so
      // assert the sandbox is not what came back — not merely that something
      // was thrown.
      assert.notEqual(returned, channel === "EMAIL" ? sandboxEmailProvider : sandboxSmsProvider);
      assert.match(thrown.message, /LIVE_COMMUNICATIONS_APPROVED/);
    });
  });

  test(`seam: the ${channel} gate is enforced outside production too`, async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    try {
      for (const nodeEnv of ["development", "test", "staging", undefined]) {
        if (nodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = nodeEnv;
        await withSeamEnv({ [selectorEnv]: "some_vendor" }, () => {
          assert.throws(
            () => resolve(),
            (err: unknown) => err instanceof CommunicationProviderError && err.code === "live_provider_disabled",
            `NODE_ENV=${String(nodeEnv)} must not relax the gate — a real message sent from a laptop is just as delivered`,
          );
        });
      }
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  test(`seam: ${channel} approval alone still resolves nothing — this build ships no live adapter`, async () => {
    await withSeamEnv({ [LIVE_COMMUNICATIONS_APPROVAL_ENV]: "true", [selectorEnv]: "some_vendor" }, () => {
      assert.throws(
        () => resolve(),
        (err: unknown) =>
          err instanceof CommunicationProviderError && err.code === "provider_error" && err.channel === channel,
        "an approved but unknown provider is a misconfiguration to fail on, not a reason to fall back",
      );
    });
  });

  for (const nearMiss of ["TRUE", "True", "1", "yes", "true ", ""]) {
    test(`seam: ${channel} approval value ${JSON.stringify(nearMiss)} does not open the gate`, async () => {
      await withSeamEnv({ [LIVE_COMMUNICATIONS_APPROVAL_ENV]: nearMiss, [selectorEnv]: "some_vendor" }, () => {
        assert.throws(
          () => resolve(),
          (err: unknown) => err instanceof CommunicationProviderError && err.code === "live_provider_disabled",
          "only the literal string \"true\" approves live dispatch",
        );
      });
    });
  }
}

test("seam: the test override cannot smuggle a non-sandbox adapter past the gate", async () => {
  await withSeamEnv({}, () => {
    setCommunicationProvidersForTests({ email: candidateEmail, sms: candidateSms });
    // Selector says "sandbox" and approval is absent: the override must not
    // be honoured, or the test seam would be the bypass.
    assert.throws(
      () => resolveEmailProvider(),
      (err: unknown) => err instanceof CommunicationProviderError && err.code === "live_provider_disabled",
    );
    assert.throws(
      () => resolveSmsProvider(),
      (err: unknown) => err instanceof CommunicationProviderError && err.code === "live_provider_disabled",
    );
  });
});

test("seam: with approval, the override resolves — so the conformance suite can drive a candidate adapter", async () => {
  await withSeamEnv({ [LIVE_COMMUNICATIONS_APPROVAL_ENV]: "true" }, () => {
    setCommunicationProvidersForTests({ email: candidateEmail, sms: candidateSms });
    assert.equal(resolveEmailProvider(), candidateEmail);
    assert.equal(resolveSmsProvider(), candidateSms);
  });
});

test("seam: resolving one channel never selects the other's provider", async () => {
  await withSeamEnv({ [EMAIL_PROVIDER_ENV]: "some_vendor" }, () => {
    assert.throws(() => resolveEmailProvider(), CommunicationProviderError);
    // SMS was not selected, so it is unaffected and still the sandbox.
    assert.equal(resolveSmsProvider(), sandboxSmsProvider);
  });
});

test("seam: no adapter reachable from the registry performs any network call", async () => {
  // A structural statement of the slice's central claim. Both resolvable
  // adapters are the sandbox singletons, whose own module headers document
  // that they make no network call; there is no third reachable adapter.
  await withSeamEnv({}, async () => {
    const email = resolveEmailProvider();
    const sms = resolveSmsProvider();
    assert.equal(email.name, SANDBOX_EMAIL_PROVIDER_NAME);
    assert.equal(sms.name, SANDBOX_SMS_PROVIDER_NAME);
    const emailResult = await email.send({
      to: "no-network@example.test",
      subject: null,
      bodyText: "body",
      bodyHtml: null,
      idempotencyKey: "no-network-email",
    });
    const smsResult = await sms.send({ to: "+61412345670", bodyText: "body", idempotencyKey: "no-network-sms" });
    assert.equal(emailResult.provider, SANDBOX_EMAIL_PROVIDER_NAME);
    assert.equal(smsResult.provider, SANDBOX_SMS_PROVIDER_NAME);
  });
});
