// AE GROW Pilot Readiness WP2a — loadSession must not log users out during a
// database blip. A cryptographically valid session whose user row cannot be
// LOADED answers 503 (retryable); genuinely invalid/unknown sessions still
// answer 401. Exercised over real HTTP against the real app.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { db } from "@aee/db";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";

let server: Server;
let baseUrl: string;
let validCookieForUnknownUser: string;

before(async () => {
  const { createApp } = await import("../../app.js");
  const { createSessionToken } = await import("../../lib/session.js");
  // A correctly signed, unexpired token for a user id that does not exist.
  validCookieForUnknownUser = `aee_session=${encodeURIComponent(createSessionToken(2_147_000_001, 0))}`;
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

type DbSelect = typeof db.select;

async function withFailingDbSelect<T>(fn: () => Promise<T>): Promise<T> {
  const original = db.select;
  (db as { select: DbSelect }).select = (() => {
    throw new Error('simulated outage: connection to "postgres://user:pw@db/aee" terminated');
  }) as unknown as DbSelect;
  try {
    return await fn();
  } finally {
    (db as { select: DbSelect }).select = original;
  }
}

test("a valid session whose user lookup fails with a database error gets 503 (not 401), without leaking the error", async () => {
  await withFailingDbSelect(async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: validCookieForUnknownUser } });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");
    const text = await res.text();
    assert.doesNotMatch(text, /simulated outage|postgres:\/\//);
    assert.match(text, /could not be verified/);
  });
});

test("the same valid-signature session for a user that does not exist still gets 401 once the database is healthy", async () => {
  const res = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: validCookieForUnknownUser } });
  assert.equal(res.status, 401);
});

test("a forged/invalid session token is 401 even while the database is failing (never reaches the lookup)", async () => {
  await withFailingDbSelect(async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: "aee_session=forged.signature" } });
    assert.equal(res.status, 401);
  });
});

test("no cookie at all is ordinary unauthenticated traffic: 401 on protected routes, public routes unaffected during a DB outage", async () => {
  await withFailingDbSelect(async () => {
    const protectedRes = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(protectedRes.status, 401);
    const live = await fetch(`${baseUrl}/api/health/live`);
    assert.equal(live.status, 200);
  });
});

test("a malformed Cookie header (invalid percent-escape) is treated as unauthenticated (401), not a 500/503", async () => {
  const res = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: "aee_session=%E0%A4%A" } });
  assert.equal(res.status, 401);
});
