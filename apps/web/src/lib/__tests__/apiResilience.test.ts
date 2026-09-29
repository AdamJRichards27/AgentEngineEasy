import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiError,
  CORRELATION_ID_HEADER,
  NETWORK_ERROR_MESSAGE,
  SESSION_ENDED_MESSAGE,
  apiFetch,
  formatSupportReference,
  humanizeApiError,
  isSessionExpiryResponse,
  readCorrelationId,
  setSessionExpiredHandler,
  withSupportReference,
} from "../api";

// AE GROW Pilot Readiness WP5 — 401 classification, correlation-id capture
// and support-reference formatting for lib/api.ts.

const UUID = "3f9c2a1b-7d4e-4c2a-9b1e-0a1b2c3d4e5f";

test("401 from an authenticated call is classified as session expiry", () => {
  for (const path of ["/grow/today", "/grow/contacts/12", "/properties/4?tab=offers", "/auth/admin/users", "/ai/actions/requests/9/approve"]) {
    assert.equal(isSessionExpiryResponse(path, 401), true, path);
  }
});

test("sign-in / session-probe / public auth endpoints never trigger global logout", () => {
  for (const path of [
    "/auth/me",
    "/auth/me?fresh=1",
    "/auth/login",
    "/auth/dev-login",
    "/auth/logout",
    "/auth/known-users",
    "/auth/invitations/abc123/status",
    "/auth/invitations/abc123/accept",
    "/auth/password-reset/request",
    "/auth/password-reset/confirm",
    "/legal/acceptance",
  ]) {
    assert.equal(isSessionExpiryResponse(path, 401), false, path);
  }
});

test("403 (entitlement / permission) and other statuses are never session expiry", () => {
  assert.equal(isSessionExpiryResponse("/grow/today", 403), false);
  assert.equal(isSessionExpiryResponse("/grow/today", 404), false);
  assert.equal(isSessionExpiryResponse("/grow/today", 500), false);
  assert.equal(isSessionExpiryResponse("/grow/today", 0), false);
});

test("readCorrelationId reads the X-Correlation-Id header case-insensitively and rejects junk", () => {
  assert.equal(readCorrelationId(new Headers({ [CORRELATION_ID_HEADER]: UUID })), UUID);
  assert.equal(readCorrelationId(new Headers({ "x-correlation-id": `  ${UUID}  ` })), UUID);
  assert.equal(readCorrelationId(new Headers()), undefined);
  assert.equal(readCorrelationId(new Headers({ "x-correlation-id": "<script>alert(1)</script>" })), undefined);
  assert.equal(readCorrelationId(null), undefined);
  assert.equal(readCorrelationId(undefined), undefined);
});

test("formatSupportReference shows the first 8 id characters, hyphens dropped", () => {
  assert.equal(formatSupportReference(UUID), "Reference: 3f9c2a1b");
  assert.equal(formatSupportReference("ab-cd-ef-12-34"), "Reference: abcdef12");
  assert.equal(formatSupportReference("abc"), "Reference: abc");
  assert.equal(formatSupportReference(""), undefined);
  assert.equal(formatSupportReference("---"), undefined);
  assert.equal(formatSupportReference(undefined), undefined);
  assert.equal(withSupportReference("Oops.", UUID), "Oops. Reference: 3f9c2a1b");
  assert.equal(withSupportReference("Oops.", undefined), "Oops.");
});

test("humanizeApiError appends the reference to 5xx messages only", () => {
  assert.equal(humanizeApiError("/grow/today", 500, undefined, UUID), "Something went wrong on our end. Try again in a moment. Reference: 3f9c2a1b");
  assert.match(humanizeApiError("/payments/1/charge", 502, undefined, UUID), /Your card has not been charged\. Try again\. Reference: 3f9c2a1b$/);
  assert.equal(humanizeApiError("/grow/today", 500), "Something went wrong on our end. Try again in a moment.");
  assert.equal(humanizeApiError("/grow/today", 409, "Already done.", UUID), "Already done.");
  assert.equal(humanizeApiError("/grow/today", 403, undefined, UUID), "You don't have permission to do that — ask a Brokerage Administrator.");
});

test("humanizeApiError: session-ended copy for authenticated 401s, server reason for sign-in 401s", () => {
  assert.equal(humanizeApiError("/grow/today", 401, "Not authenticated"), SESSION_ENDED_MESSAGE);
  assert.equal(humanizeApiError("/auth/login", 401, "Invalid email or password."), "Invalid email or password.");
});

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

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

test("apiFetch captures the correlation id on ApiError and puts the reference in the 5xx message", async () => {
  await withFetch(
    async () => jsonResponse(500, { error: "boom: stack trace" }, { "X-Correlation-Id": UUID }),
    async () => {
      const error = await apiFetch("/grow/today").then(
        () => assert.fail("expected rejection"),
        (e: unknown) => e,
      );
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 500);
      assert.equal(error.correlationId, UUID);
      assert.equal(error.friendly, "Something went wrong on our end. Try again in a moment. Reference: 3f9c2a1b");
      assert.doesNotMatch(error.friendly, /stack trace/);
    },
  );
});

test("apiFetch keeps a positive integer contactId from a 409 body", async () => {
  await withFetch(
    async () => jsonResponse(409, { error: "A contact with this email already exists.", contactId: 42 }),
    async () => {
      const error = (await apiFetch("/grow/contacts", { method: "POST" }).catch((e) => e)) as ApiError;
      assert.equal(error.status, 409);
      assert.equal(error.friendly, "A contact with this email already exists.");
      assert.equal(error.contactId, 42);
    },
  );
  await withFetch(
    async () => jsonResponse(409, { error: "Already actioned.", contactId: "42" }),
    async () => {
      const error = (await apiFetch("/grow/contacts", { method: "POST" }).catch((e) => e)) as ApiError;
      assert.equal(error.contactId, undefined);
    },
  );
});

test("apiFetch captures the correlation id on 4xx errors too (message unchanged)", async () => {
  await withFetch(
    async () => jsonResponse(409, { error: "Already actioned.", reason: "WRONG_STATUS" }, { "X-Correlation-Id": UUID }),
    async () => {
      const error = (await apiFetch("/ai/actions/requests/1/approve", { method: "POST" }).catch((e) => e)) as ApiError;
      assert.equal(error.correlationId, UUID);
      assert.equal(error.friendly, "Already actioned.");
      assert.equal(error.reason, "WRONG_STATUS");
    },
  );
});

test("apiFetch turns a network failure into a friendly ApiError with status 0", async () => {
  await withFetch(
    async () => {
      throw new TypeError("Failed to fetch");
    },
    async () => {
      const error = (await apiFetch("/grow/today").catch((e) => e)) as ApiError;
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 0);
      assert.equal(error.friendly, NETWORK_ERROR_MESSAGE);
      assert.equal(error.correlationId, undefined);
    },
  );
});

// AE GROW Pilot Readiness WP8 — lib/sessionProbe.ts tells "the API is broken"
// apart from "the API was never reached" by whether the failure carried a
// server-authored message, so apiFetch has to keep that raw string.
test("apiFetch keeps the raw server message alongside the friendly one", async () => {
  await withFetch(
    async () => jsonResponse(500, { error: "boom: stack trace" }),
    async () => {
      const error = (await apiFetch("/auth/me").catch((e) => e)) as ApiError;
      assert.equal(error.serverMessage, "boom: stack trace");
      // The agent still only ever sees the humanised text.
      assert.equal(error.friendly, "Something went wrong on our end. Try again in a moment.");
    },
  );
});

test("apiFetch leaves serverMessage unset when nothing authored a JSON error body", async () => {
  // What Vite's dev proxy actually returns when its target refuses the
  // connection: 500 with an empty body. No server message means no API answer.
  await withFetch(
    async () => new Response("", { status: 500 }),
    async () => {
      const error = (await apiFetch("/auth/me").catch((e) => e)) as ApiError;
      assert.equal(error.status, 500);
      assert.equal(error.serverMessage, undefined);
    },
  );
  await withFetch(
    async () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }),
    async () => {
      const error = (await apiFetch("/auth/me").catch((e) => e)) as ApiError;
      assert.equal(error.status, 502);
      assert.equal(error.serverMessage, undefined);
    },
  );
});

test("apiFetch rethrows an AbortError untouched", async () => {
  await withFetch(
    async () => {
      throw new DOMException("aborted", "AbortError");
    },
    async () => {
      const error = await apiFetch("/grow/today").catch((e) => e);
      assert.ok(error instanceof DOMException);
      assert.equal((error as DOMException).name, "AbortError");
    },
  );
});

test("apiFetch calls the global session-expired handler only for authenticated 401s", async () => {
  let calls = 0;
  setSessionExpiredHandler(() => {
    calls++;
  });
  try {
    const cases: Array<[string, number, number]> = [
      ["/grow/today", 401, 1],
      ["/auth/me", 401, 0],
      ["/auth/login", 401, 0],
      ["/grow/today", 403, 0],
      ["/grow/today", 500, 0],
    ];
    for (const [path, status, expected] of cases) {
      calls = 0;
      await withFetch(
        async () => jsonResponse(status, { error: "x" }),
        () => apiFetch(path).catch(() => undefined),
      );
      assert.equal(calls, expected, `${status} ${path}`);
    }
  } finally {
    setSessionExpiredHandler(null);
  }
});

test("a throwing session-expired handler never masks the original ApiError", async () => {
  setSessionExpiredHandler(() => {
    throw new Error("handler failed");
  });
  try {
    await withFetch(
      async () => jsonResponse(401, { error: "Not authenticated" }),
      async () => {
        const error = (await apiFetch("/grow/today").catch((e) => e)) as ApiError;
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 401);
        assert.equal(error.friendly, SESSION_ENDED_MESSAGE);
      },
    );
  } finally {
    setSessionExpiredHandler(null);
  }
});
