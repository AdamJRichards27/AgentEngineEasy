import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ApiError, apiFetch, configureOwnerRequestContext } from "../api";

test("owner writes carry the selected brokerage; readonly requests do not", async () => {
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(init ?? {});
    return new Response(JSON.stringify({ ok: true }));
  };
  try {
    configureOwnerRequestContext({ platformOwner: true, ownerSelectedBrokerageId: 37 });
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "post"]) {
      await apiFetch("/auth/admin/users/8", { method, headers: { "X-AEE-Owner-Brokerage": "92" } });
      assert.equal(new Headers(requests.at(-1)?.headers).get("X-AEE-Owner-Brokerage"), "37");
      assert.equal(requests.at(-1)?.credentials, "include");
    }
    for (const method of [undefined, "GET", "HEAD"]) {
      await apiFetch("/owner/status", { method, headers: { "X-AEE-Owner-Brokerage": "92" } });
      assert.equal(new Headers(requests.at(-1)?.headers).has("X-AEE-Owner-Brokerage"), false);
    }
  } finally {
    configureOwnerRequestContext(null);
    globalThis.fetch = originalFetch;
  }
});

test("latest session context replaces the header and logout/nonowners clear it", async () => {
  const originalFetch = globalThis.fetch;
  let header: string | null = null;
  globalThis.fetch = async (_input, init) => {
    header = new Headers(init?.headers).get("X-AEE-Owner-Brokerage");
    return new Response("{}");
  };
  try {
    for (const selectedId of [37, 92]) {
      configureOwnerRequestContext({ platformOwner: true, ownerSelectedBrokerageId: selectedId });
      await apiFetch("/auth/admin/invitations", { method: "POST" });
      assert.equal(header, String(selectedId));
    }
    for (const user of [
      null, undefined, { platformOwner: false, ownerSelectedBrokerageId: 92 },
      { platformOwner: true, ownerSelectedBrokerageId: null }, { platformOwner: true },
    ]) {
      configureOwnerRequestContext(user);
      await apiFetch("/owner/context", { method: "POST" });
      assert.equal(header, null);
    }
  } finally {
    configureOwnerRequestContext(null);
    globalThis.fetch = originalFetch;
  }
});

test("409 context_changed is surfaced without refreshing or retrying the write", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "context_changed", reason: "context_changed" }), { status: 409 });
  };
  try {
    configureOwnerRequestContext({ platformOwner: true, ownerSelectedBrokerageId: 37 });
    await assert.rejects(() => apiFetch("/auth/admin/invitations", { method: "POST" }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      assert.equal(error.reason, "context_changed");
      assert.match(error.friendly, /not saved.*Reload/);
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    configureOwnerRequestContext(null);
    globalThis.fetch = originalFetch;
  }
});

test("owner mutations always carry the CSRF action header, never on reads or other endpoints", async () => {
  const originalFetch = globalThis.fetch;
  let headers = new Headers();
  globalThis.fetch = async (_input, init) => {
    headers = new Headers(init?.headers);
    return new Response("{}");
  };
  try {
    configureOwnerRequestContext(null);
    for (const method of ["POST", "PATCH", "DELETE"]) {
      await apiFetch("/owner/brokerages/37?check=1", { method, headers: { "X-AEE-Owner-Action": "0" } });
      assert.equal(headers.get("X-AEE-Owner-Action"), "1");
      assert.equal(headers.has("X-AEE-Owner-Brokerage"), false);
    }
    for (const [path, method] of [
      ["/owner/status", "GET"], ["/owner/status", "HEAD"],
      ["/auth/admin/invitations", "POST"], ["/owner-other", "POST"],
    ]) {
      await apiFetch(path, { method, headers: { "X-AEE-Owner-Action": "1" } });
      assert.equal(headers.has("X-AEE-Owner-Action"), false);
    }
  } finally {
    configureOwnerRequestContext(null);
    globalThis.fetch = originalFetch;
  }
});

test("owner guard prevents operational page mounting without context and keeps owner link visible", () => {
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  assert.match(app, /ownerWithoutContext = !!user\?\.platformOwner && user\.ownerSelectedBrokerageId == null/);
  assert.match(app, /ownerWithoutContext && location !== "\/owner" \? <Redirect to="\/owner" replace/);
  assert.match(app, /user\?\.platformOwner && <Link href="\/owner"/);
  assert.match(app, /user\?\.platformOwner && <OwnerContextBanner user=\{user\}/);
  const owner = readFileSync(new URL("../owner.ts", import.meta.url), "utf8");
  assert.match(owner, /window\.location\.assign\(brokerageId === null \? "\/owner" : "\/settings\/users"\)/);
  assert.match(owner, /retry: false/);
});
