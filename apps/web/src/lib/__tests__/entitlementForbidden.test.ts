import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiError,
  apiFetch,
  humanizeApiError,
  humanizeForbiddenMessage,
  readEntitlementKey,
  readEntitlementUpgrade,
} from "../api";

// G-2 — reason-aware entitlement 403s. The middleware contract is preserved
// on ApiError, and friendly copy distinguishes a missing plan (with or
// without an upgrade hint) from a wrong role and from a bare 403.

const GENERIC = "You don't have permission to do that — ask a Brokerage Administrator.";
const WRONG_ROLE = "You don't have the right role for that — ask a Brokerage Administrator.";
const PLAN_MISSING = "Your plan doesn't include this.";
const PLAN_UPGRADE = "Your plan doesn't include this. A Brokerage Administrator can add it.";
const SUBSCRIPTION_INACTIVE = "Your subscription isn't active — ask a Brokerage Administrator to restore it.";
const ENTITLEMENT_EXPIRED = "This access has expired — ask a Brokerage Administrator to renew it.";

const MIDDLEWARE_UPGRADE = { action: "grow.checkout", productCode: "grow" };

type FetchImpl = typeof fetch;

async function withFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function rejected(path: string, status: number, body: unknown): Promise<ApiError> {
  return withFetch(
    async () => (body === undefined ? new Response("", { status }) : jsonResponse(status, body)),
    async () => {
      const error = await apiFetch(path).then(
        () => assert.fail("expected rejection"),
        (caught: unknown) => caught,
      );
      assert.ok(error instanceof ApiError);
      return error;
    },
  );
}

test("apiFetch preserves the entitlement 403 contract and uses upgrade-path copy", async () => {
  const error = await rejected("/grow/today", 403, {
    error: "Not entitled",
    reason: "ENTITLEMENT_MISSING",
    entitlementKey: "grow.access",
    upgrade: MIDDLEWARE_UPGRADE,
  });
  assert.equal(error.status, 403);
  assert.equal(error.reason, "ENTITLEMENT_MISSING");
  assert.equal(error.entitlementKey, "grow.access");
  assert.deepEqual(error.upgrade, MIDDLEWARE_UPGRADE);
  assert.equal(error.serverMessage, "Not entitled");
  assert.equal(error.friendly, PLAN_UPGRADE);
  assert.doesNotMatch(error.friendly, /checkout|https?:/i);
  assert.notEqual(error.friendly, GENERIC);
  assert.notEqual(error.friendly, WRONG_ROLE);
});

test("a lapsed subscription 403 reads differently from a missing plan", async () => {
  const error = await rejected("/grow/calls", 403, {
    error: "Not entitled",
    reason: "SUBSCRIPTION_INACTIVE",
    entitlementKey: "grow.calling.transcription",
    upgrade: { action: "grow.checkout", productCode: "grow", ignored: true },
  });
  assert.equal(error.reason, "SUBSCRIPTION_INACTIVE");
  assert.equal(error.entitlementKey, "grow.calling.transcription");
  assert.deepEqual(error.upgrade, MIDDLEWARE_UPGRADE);
  assert.equal(error.friendly, SUBSCRIPTION_INACTIVE);
  assert.notEqual(error.friendly, PLAN_UPGRADE);
});

test("an expired entitlement 403 names expiry, and a fail-closed body has no upgrade", async () => {
  const expired = await rejected("/grow/contacts", 403, {
    error: "Not entitled",
    reason: "ENTITLEMENT_EXPIRED",
    entitlementKey: "grow.contacts.manage",
    upgrade: MIDDLEWARE_UPGRADE,
  });
  assert.equal(expired.friendly, ENTITLEMENT_EXPIRED);
  assert.equal(expired.entitlementKey, "grow.contacts.manage");

  const failClosed = await rejected("/ai/ask", 403, {
    error: "Not entitled",
    reason: "ENTITLEMENT_MISSING",
    entitlementKey: "grow.ai.use",
  });
  assert.equal(failClosed.friendly, PLAN_MISSING);
  assert.equal(failClosed.entitlementKey, "grow.ai.use");
  assert.equal(failClosed.upgrade, undefined);
  assert.notEqual(failClosed.friendly, PLAN_UPGRADE);
});

test("a key without reason or upgrade is still a missing-plan denial", async () => {
  const error = await rejected("/ai/voice", 403, {
    error: "Grow-scoped Ask AE requires a Grow or Pro plan with Grow AI enabled.",
    entitlementKey: "grow.ai.use",
  });
  assert.equal(error.entitlementKey, "grow.ai.use");
  assert.equal(error.upgrade, undefined);
  assert.equal(error.reason, undefined);
  assert.equal(error.friendly, PLAN_MISSING);
});

test("wrong-role 403s stay distinct from entitlement and bare 403s", async () => {
  const policy = await rejected("/ai/actions/requests/1/approve", 403, {
    error: "Action denied by policy",
    reason: "ROLE_FORBIDDEN",
  });
  assert.equal(policy.friendly, WRONG_ROLE);
  assert.equal(policy.reason, "ROLE_FORBIDDEN");
  assert.equal(policy.entitlementKey, undefined);
  assert.equal(policy.upgrade, undefined);

  const approver = await rejected("/ai/actions/requests/1/approve", 403, {
    error: "Action denied by policy",
    reason: "APPROVER_ROLE_FORBIDDEN",
  });
  assert.equal(approver.friendly, WRONG_ROLE);

  const requireRole = await rejected("/grow/property-intelligence/ops/health", 403, { error: "Forbidden" });
  assert.equal(requireRole.friendly, WRONG_ROLE);
  assert.equal(requireRole.reason, undefined);
  assert.equal(requireRole.entitlementKey, undefined);
  assert.equal(requireRole.upgrade, undefined);
  assert.notEqual(requireRole.friendly, GENERIC);
  assert.notEqual(requireRole.friendly, PLAN_MISSING);
});

test("a bare 403 keeps the generic sentence and does not invent entitlement fields", async () => {
  const other = await rejected("/payments/1", 403, { error: "Only a Brokerage Administrator can add a brokerage-level payment method." });
  assert.equal(other.friendly, GENERIC);
  assert.equal(other.entitlementKey, undefined);
  assert.equal(other.upgrade, undefined);
  assert.equal(other.reason, undefined);

  const empty = await rejected("/grow/today", 403, undefined);
  assert.equal(empty.friendly, GENERIC);
  assert.equal(empty.serverMessage, undefined);
  assert.equal(empty.entitlementKey, undefined);
  assert.equal(empty.upgrade, undefined);

  const html = await withFetch(
    async () => new Response("<html>forbidden</html>", { status: 403, headers: { "Content-Type": "text/html" } }),
    async () => {
      const error = (await apiFetch("/grow/today").catch((caught) => caught)) as ApiError;
      return error;
    },
  );
  assert.equal(html.friendly, GENERIC);
  assert.equal(html.entitlementKey, undefined);
  assert.equal(html.upgrade, undefined);
});

test("a malformed upgrade is dropped, and entitlement fields are ignored off 403", async () => {
  const malformed = await rejected("/grow/today", 403, {
    error: "Not entitled",
    reason: "ENTITLEMENT_MISSING",
    entitlementKey: "grow.access",
    upgrade: { action: "grow.checkout" },
  });
  assert.equal(malformed.upgrade, undefined);
  assert.equal(malformed.entitlementKey, "grow.access");
  assert.equal(malformed.friendly, PLAN_MISSING);

  const junkKey = await rejected("/grow/today", 403, {
    error: "Not entitled",
    reason: "ENTITLEMENT_MISSING",
    entitlementKey: "<script>",
    upgrade: ["grow.checkout"],
  });
  assert.equal(junkKey.entitlementKey, undefined);
  assert.equal(junkKey.upgrade, undefined);
  assert.equal(junkKey.friendly, PLAN_MISSING);

  const notForbidden = await rejected("/grow/today", 409, {
    error: "Already actioned.",
    reason: "WRONG_STATUS",
    entitlementKey: "grow.access",
    upgrade: MIDDLEWARE_UPGRADE,
  });
  assert.equal(notForbidden.status, 409);
  assert.equal(notForbidden.friendly, "Already actioned.");
  assert.equal(notForbidden.reason, "WRONG_STATUS");
  assert.equal(notForbidden.entitlementKey, undefined);
  assert.equal(notForbidden.upgrade, undefined);
});

test("humanizeForbiddenMessage covers the remaining denial reasons without a checkout", () => {
  assert.equal(humanizeForbiddenMessage({ reason: "SEAT_NOT_ALLOCATED", entitlementKey: "grow.access" }), "You don't have a seat for this — ask a Brokerage Administrator.");
  assert.equal(humanizeForbiddenMessage({ reason: "LIMIT_REACHED", entitlementKey: "grow.access", upgrade: MIDDLEWARE_UPGRADE }), "You've reached the limit on your plan — ask a Brokerage Administrator.");
  assert.equal(humanizeForbiddenMessage({ reason: "TENANT_CONTEXT_REQUIRED" }), "That isn't available for this brokerage.");
  assert.equal(humanizeForbiddenMessage({ reason: "TENANT_MISMATCH", entitlementKey: "grow.access" }), "That isn't available for this brokerage.");
  assert.equal(humanizeForbiddenMessage({ reason: "NOT_AUTHENTICATED" }), "You're not signed in. Sign in to continue.");
  assert.equal(humanizeApiError("/grow/today", 403), GENERIC);
  assert.equal(humanizeApiError("/grow/today", 403, "Forbidden"), WRONG_ROLE);
  assert.equal(
    humanizeApiError("/grow/today", 403, "Not entitled", undefined, {
      reason: "ENTITLEMENT_MISSING",
      entitlementKey: "grow.access",
      upgrade: MIDDLEWARE_UPGRADE,
    }),
    PLAN_UPGRADE,
  );
  assert.equal(readEntitlementKey("  grow.access  "), "grow.access");
  assert.equal(readEntitlementKey(""), undefined);
  assert.deepEqual(readEntitlementUpgrade({ action: " grow.checkout ", productCode: "grow" }), MIDDLEWARE_UPGRADE);
  assert.equal(readEntitlementUpgrade({ action: "grow.checkout", productCode: "" }), undefined);
  assert.equal(readEntitlementUpgrade(null), undefined);
});
