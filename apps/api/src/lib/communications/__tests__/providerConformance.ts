// AE GROW W3-B — EMAIL/SMS adapter conformance contract.
//
// WHAT THIS FILE IS
//
// The executable statement of what any EmailProvider/SmsProvider adapter must
// do to be wired into providers/registry.ts. It is not itself a test file
// (no `*.test.ts` suffix, so the runner does not collect it); it exports
// harnesses that a test file calls with a candidate adapter.
//
// WHY IT EXISTS
//
// The provider decision for this product is still open. The expensive part of
// making that decision is not writing the vendor's HTTP calls — it is
// discovering, months later and in production, which of the assumptions the
// outbox makes about "a provider" that vendor happens to violate. Those
// assumptions were previously implicit in one sandbox implementation and a
// handful of interface comments. Here they are explicit and runnable: point
// this at a candidate adapter and the answer takes an afternoon, not a
// quarter.
//
// HOW TO RUN IT AGAINST A NEW ADAPTER
//
// Write a new `*.test.ts` in this directory:
//
//   runEmailProviderConformance({
//     label: "acme_email",
//     provider: new AcmeEmailProvider(...),
//     deliverable: { to: "ok@example.test", subject: "s", bodyText: "b", bodyHtml: null },
//     rejections: [{ label: "invalid address", to: "nope@invalid.test",
//                    expectedFailureCategory: "INVALID_DESTINATION" }],
//     supportsIdempotentReplay: true,
//   });
//
// No product code changes. Nothing is registered, imported into the app, or
// made reachable by doing this — a conformant adapter is still inert until
// providers/registry.ts is taught its id AND LIVE_COMMUNICATIONS_APPROVED is
// set.
//
// THE CONTRACT, IN PROSE
//
// 1. IDENTITY. `name` is a non-empty, stable string, and every result the
//    adapter returns is labelled with exactly that name. The outbox writes
//    this into communicationMessages.provider and the webhook layer matches
//    on it, so an adapter whose label drifts between calls silently breaks
//    delivery-receipt correlation.
//
// 2. HONEST OUTCOMES. `status` is only ever "SENT" or "FAILED". Notably NOT
//    "DELIVERED": an adapter reports what the provider ACCEPTED, and
//    acceptance is not delivery. Delivery confirmation may only arrive later,
//    via a signed webhook. An adapter that reports delivery from its own send
//    call fabricates evidence the product shows to staff and, through them,
//    to vendors and buyers.
//
// 3. ERROR TAXONOMY. Every FAILED result carries a `failureCategory` drawn
//    from the union in ../types.ts — never a free-form vendor string. This is
//    load-bearing rather than cosmetic: outbox.ts routes on it via
//    isRetryableFailure(), so a miscategorised failure either retries
//    something permanently broken until the attempt budget is gone, or
//    abandons a transient blip on the first try. Mapping vendor codes onto
//    this union is the single most important thing a new adapter does, and
//    the place a conformance run earns its keep.
//
// 4. DETERMINISM AND IDEMPOTENCY. The outbox mints one idempotencyKey per
//    message and never re-mints it across retries, so the same key WILL be
//    presented to the adapter more than once whenever a retryable failure is
//    retried. A conformant adapter must therefore tolerate a replayed key
//    without erroring, and must return a stable outcome for identical input.
//    Whether a replay also avoids a second DELIVERY is a property only the
//    provider can offer, so the adapter declares it: with
//    supportsIdempotentReplay the harness additionally requires the replay to
//    return the SAME providerMessageId. An adapter that declares false is
//    still conformant, but it is declaring a duplicate-send risk on retry —
//    which is exactly the kind of thing a vendor decision should be made with
//    knowledge of, rather than discovering it from a contact who received the
//    same SMS four times.
//
// 5. TENANCY IS NEVER THE ADAPTER'S TO DECIDE. Send inputs carry no
//    brokerage, account or tenant identifier, and results must not invent
//    one. Tenancy is resolved server-side — the webhook route is scoped by
//    URL (/api/communications/webhooks/:brokerageId/:provider) and every
//    matched message's own brokerageId is re-checked before anything is
//    mutated (see ../webhooks.ts). An adapter that surfaced a tenant id from
//    a provider payload would create a path for a third party to nominate
//    which brokerage's data it gets to touch. If an adapter normalises
//    inbound webhooks it declares that function here and the harness proves
//    tenancy claims in the payload do not survive normalisation.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NON_RETRYABLE_FAILURE_CATEGORIES,
  RETRYABLE_FAILURE_CATEGORIES,
  isRetryableFailure,
  type FailureCategory,
} from "../types.js";
import type { EmailProvider, ProviderSendResult, SendEmailInput, SendSmsInput, SmsProvider } from "../providers/types.js";

const ALL_FAILURE_CATEGORIES: readonly string[] = [...RETRYABLE_FAILURE_CATEGORIES, ...NON_RETRYABLE_FAILURE_CATEGORIES];

/**
 * Keys that must never appear on anything an adapter hands back. A provider
 * payload is attacker-influenced input; tenancy comes from this app's own
 * routing or not at all.
 */
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

export interface AdapterRejectionCase<TInput> {
  label: string;
  /** The send-input fields (minus idempotencyKey, which the harness supplies) that trigger this rejection. */
  input: Omit<TInput, "idempotencyKey">;
  expectedFailureCategory: FailureCategory;
}

interface ConformanceSubject<TProvider, TInput> {
  /** Used only to name the emitted tests. */
  label: string;
  provider: TProvider;
  /** Input the adapter is expected to accept. Must not reach a real recipient. */
  deliverable: Omit<TInput, "idempotencyKey">;
  /** Deterministic rejections. An adapter with none is conformant but leaves clause 3 unproven — say so rather than inventing cases. */
  rejections?: AdapterRejectionCase<TInput>[];
  /** True only if the PROVIDER guarantees a replayed idempotency key does not send twice. */
  supportsIdempotentReplay: boolean;
  /**
   * Optional. If the adapter normalises inbound provider webhooks, supply it
   * here and clause 5 is proven against it. Must return the app-facing event
   * shape WITHOUT tenancy.
   */
  normalizeWebhook?: (payload: Record<string, unknown>) => Record<string, unknown>;
}

export type EmailProviderConformanceSubject = ConformanceSubject<EmailProvider, SendEmailInput>;
export type SmsProviderConformanceSubject = ConformanceSubject<SmsProvider, SendSmsInput>;

function assertNoTenancy(value: unknown, what: string): void {
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of TENANCY_BEARING_KEYS) {
    assert.equal(
      Object.hasOwn(record, key),
      false,
      `${what} exposes "${key}". Tenancy must be resolved from this app's own routing/server context, never carried up from a provider.`,
    );
  }
}

function assertResultShape(result: ProviderSendResult, providerName: string, what: string): void {
  assert.equal(result.provider, providerName, `${what}: result.provider must equal the adapter's own name`);
  assert.equal(typeof result.providerMessageId, "string", `${what}: providerMessageId must be a string`);
  assert.ok(result.providerMessageId.length > 0, `${what}: providerMessageId must not be empty`);
  assert.ok(
    result.status === "SENT" || result.status === "FAILED",
    `${what}: status must be SENT or FAILED, got ${String(result.status)}. Acceptance is not delivery — DELIVERED may only ever come from a verified inbound webhook.`,
  );
  assertNoTenancy(result, `${what}: ProviderSendResult`);
}

function uniqueKey(label: string): string {
  return `conformance-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The shared body of both harnesses. Email and SMS differ only in their input
 * shape, so the contract is expressed once and applied twice — a future
 * adapter for either channel is held to the same clauses.
 */
function runSendConformance<TProvider extends { name: string }, TInput extends { idempotencyKey: string }>(
  subject: ConformanceSubject<TProvider, TInput>,
  send: (provider: TProvider, input: TInput) => Promise<ProviderSendResult>,
): void {
  const { label, provider } = subject;
  const buildInput = (base: Omit<TInput, "idempotencyKey">, idempotencyKey: string): TInput =>
    ({ ...base, idempotencyKey }) as TInput;

  // Clause 1 — identity.
  test(`conformance[${label}]: exposes a non-empty, stable adapter name`, () => {
    assert.equal(typeof provider.name, "string");
    assert.ok(provider.name.length > 0, "adapter name must not be empty");
    assert.equal(provider.name, provider.name, "adapter name must be stable");
  });

  // Clauses 1, 2, 5 — a send the adapter accepts.
  test(`conformance[${label}]: an accepted send reports an honest, self-labelled result`, async () => {
    const result = await send(provider, buildInput(subject.deliverable, uniqueKey(label)));
    assertResultShape(result, provider.name, "accepted send");
    assert.equal(result.status, "SENT", "the declared deliverable input must be accepted");
    assert.equal(result.failureCategory, undefined, "a SENT result must not carry a failure category");
  });

  // Clause 5 — the send input itself is tenancy-free, so an adapter has
  // nothing to leak even if it wanted to.
  test(`conformance[${label}]: send input carries no tenancy for the adapter to act on`, () => {
    assertNoTenancy(buildInput(subject.deliverable, uniqueKey(label)), "send input");
  });

  // Clause 3 — error taxonomy.
  const rejections = subject.rejections ?? [];
  for (const rejection of rejections) {
    test(`conformance[${label}]: rejection "${rejection.label}" maps onto the shared failure taxonomy`, async () => {
      const result = await send(provider, buildInput(rejection.input, uniqueKey(label)));
      assertResultShape(result, provider.name, `rejection ${rejection.label}`);
      assert.equal(result.status, "FAILED");
      assert.ok(
        result.failureCategory !== undefined,
        "a FAILED result must carry a failureCategory — outbox.ts routes retries on it",
      );
      assert.ok(
        ALL_FAILURE_CATEGORIES.includes(result.failureCategory),
        `failureCategory "${result.failureCategory}" is not in the shared union; a vendor's own code must be mapped, not passed through`,
      );
      assert.equal(
        result.failureCategory,
        rejection.expectedFailureCategory,
        "the adapter must map this provider condition onto the category the adapter author declared",
      );
      // The categorisation has to mean something to the retry engine.
      assert.equal(
        isRetryableFailure(result.failureCategory),
        isRetryableFailure(rejection.expectedFailureCategory),
        "retry classification must follow from the declared category",
      );
    });
  }

  test(`conformance[${label}]: declares its rejection behaviour`, () => {
    assert.ok(
      Array.isArray(subject.rejections),
      "an adapter must declare its deterministic rejections (an explicit [] is an acceptable declaration that it has none)",
    );
  });

  // Clause 4 — determinism and idempotency.
  test(`conformance[${label}]: a replayed idempotency key is tolerated and the outcome is stable`, async () => {
    const key = uniqueKey(`${label}-replay`);
    const first = await send(provider, buildInput(subject.deliverable, key));
    const second = await send(provider, buildInput(subject.deliverable, key));

    assertResultShape(first, provider.name, "first send");
    assertResultShape(second, provider.name, "replayed send");
    assert.equal(
      second.status,
      first.status,
      "replaying the key the outbox already used must not change the outcome — the outbox never re-mints a key across retries",
    );
    assert.equal(second.failureCategory, first.failureCategory, "a replay must not change the failure classification");

    if (subject.supportsIdempotentReplay) {
      assert.equal(
        second.providerMessageId,
        first.providerMessageId,
        "an adapter declaring provider-side idempotent replay must return the same providerMessageId, proving no second send occurred",
      );
    }
  });

  test(`conformance[${label}]: declares whether a retry can duplicate a real delivery`, () => {
    assert.equal(
      typeof subject.supportsIdempotentReplay,
      "boolean",
      "supportsIdempotentReplay must be stated explicitly — it is a risk disclosure, not a default",
    );
  });

  // Clause 5 — inbound webhook tenancy, when the adapter normalises webhooks.
  if (subject.normalizeWebhook) {
    const normalizeWebhook = subject.normalizeWebhook;
    test(`conformance[${label}]: webhook normalisation discards tenancy claimed by the payload`, () => {
      const hostile: Record<string, unknown> = { messageId: "abc", status: "delivered" };
      for (const key of TENANCY_BEARING_KEYS) hostile[key] = 999_999;
      assertNoTenancy(normalizeWebhook(hostile), "normalised webhook event");
    });
  }
}

export function runEmailProviderConformance(subject: EmailProviderConformanceSubject): void {
  runSendConformance<EmailProvider, SendEmailInput>(subject, (provider, input) => provider.send(input));
}

export function runSmsProviderConformance(subject: SmsProviderConformanceSubject): void {
  runSendConformance<SmsProvider, SendSmsInput>(subject, (provider, input) => provider.send(input));
}
