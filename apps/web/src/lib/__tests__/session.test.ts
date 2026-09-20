import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSession } from "../session";

test("fetchSession reads the full /auth/me payload used for post-login gating", async () => {
  const originalFetch = globalThis.fetch;
  const payload = {
    user: {
      id: 7,
      email: "agent@example.test",
      firstName: "Agent",
      lastName: "Example",
      role: "Agent",
      brokerageId: 3,
      brokerageName: "Example Brokerage",
    },
    entitlements: ["grow.access", "run.access"],
  };

  globalThis.fetch = (async (input, init) => {
    assert.equal(input, "/api/auth/me");
    assert.equal(init?.credentials, "include");
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    assert.deepEqual(await fetchSession(), payload);
  } finally {
    globalThis.fetch = originalFetch;
  }
});