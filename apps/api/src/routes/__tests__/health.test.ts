// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// Proves the liveness/readiness/degraded split in routes/health.ts:
//   - GET /api/health/live never depends on the database and always
//     answers ok — this is the whole point of separating it from readiness.
//   - GET /api/health/ready and the backward-compatible GET /api/health
//     both report "ok" against a genuinely healthy database.
//   - checkReadiness() itself correctly classifies all three states
//     (ok / degraded / unavailable), including the two states that are
//     impractical to trigger through a real Postgres connection in a test
//     environment (a slow-but-successful query, a hard failure) — proved
//     here by temporarily substituting db.execute for the duration of one
//     assertion and restoring it immediately after, rather than skipped.
//   - the pre-Step-2 combined GET /api/health response shape
//     ({status, service} / 503 {status, service, database}) is preserved
//     byte-for-byte so nothing already depending on it breaks.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { db } from "@aee/db";
import { checkReadiness } from "../health.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";

let server: Server;
let baseUrl: string;

before(async () => {
  const { createApp } = await import("../../app.js");
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

type DbExecute = typeof db.execute;
type RawExecute = (...args: unknown[]) => unknown;

/**
 * Temporarily replaces db.execute for the duration of fn, always restoring
 * the original afterward (even on failure) — the only practical way to
 * exercise the degraded/unavailable branches of checkReadiness() without a
 * real broken or artificially-slow Postgres connection in this test
 * environment.
 *
 * `makeReplacement` receives the TRUE original db.execute, captured BEFORE
 * patching. This matters: a replacement that wants to delegate to "the real
 * query" (e.g. the degraded case — delay, then actually run it) must close
 * over this captured original, never re-read `db.execute` from inside the
 * replacement itself, since by the time it runs, `db.execute` has already
 * been reassigned to that very replacement — re-reading it there is
 * infinite self-recursion, not a call to the real implementation.
 */
async function withPatchedDbExecute<T>(makeReplacement: (original: RawExecute) => DbExecute, fn: () => Promise<T>): Promise<T> {
  const original = db.execute.bind(db) as RawExecute;
  (db as { execute: DbExecute }).execute = makeReplacement(original);
  try {
    return await fn();
  } finally {
    (db as { execute: DbExecute }).execute = original as DbExecute;
  }
}

function alwaysThrows(message: string): (original: RawExecute) => DbExecute {
  return () =>
    (async () => {
      throw new Error(message);
    }) as unknown as DbExecute;
}

function slowButSucceeds(delayMs: number): (original: RawExecute) => DbExecute {
  return (original) =>
    (async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return original(...args);
    }) as unknown as DbExecute;
}

interface HealthBody {
  status: string;
  service?: string;
  reasons?: string[];
  database?: string;
}

async function readJson(res: Response): Promise<HealthBody> {
  return (await res.json()) as HealthBody;
}

test("GET /api/health/live always returns 200 ok and never touches the database", async () => {
  const res = await fetch(`${baseUrl}/api/health/live`);
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body.status, "ok");
  assert.equal(body.service, "agent-engine-easy-api");
});

test("GET /api/health/live returns 200 even while the database check would fail", async () => {
  await withPatchedDbExecute(alwaysThrows("simulated connection failure"), async () => {
    const res = await fetch(`${baseUrl}/api/health/live`);
    assert.equal(res.status, 200);
  });
});

test("GET /api/health/ready returns 200 with status ok against a healthy database", async () => {
  const res = await fetch(`${baseUrl}/api/health/ready`);
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body.status, "ok");
  assert.equal(body.service, "agent-engine-easy-api");
  assert.deepEqual(body.reasons, []);
});

test("GET /api/health/ready returns 503 with status unavailable when the database check fails", async () => {
  await withPatchedDbExecute(alwaysThrows("simulated connection failure"), async () => {
    const res = await fetch(`${baseUrl}/api/health/ready`);
    assert.equal(res.status, 503);
    const body = await readJson(res);
    assert.equal(body.status, "unavailable");
    assert.deepEqual(body.reasons, ["database unreachable"]);
  });
});

test("GET /api/health/ready returns 200 with status degraded (not 503) when the database is slow but succeeds", async () => {
  await withPatchedDbExecute(slowButSucceeds(550), async () => {
    const res = await fetch(`${baseUrl}/api/health/ready`);
    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.equal(body.status, "degraded");
    assert.ok((body.reasons ?? []).length > 0);
  });
});

test("GET /api/health (backward-compatible combined endpoint) returns {status:'ok'} against a healthy database", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.deepEqual(body, { status: "ok", service: "agent-engine-easy-api" });
});

test("GET /api/health folds a degraded-but-successful check into 'ok' (200) rather than exposing the three-state distinction — that is /ready's job, not the legacy endpoint's", async () => {
  await withPatchedDbExecute(slowButSucceeds(550), async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.deepEqual(body, { status: "ok", service: "agent-engine-easy-api" });
  });
});

test("GET /api/health returns 503 with the pre-Step-2 shape ({status:'degraded', database:'unreachable'}) when the database is unreachable", async () => {
  await withPatchedDbExecute(alwaysThrows("simulated connection failure"), async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 503);
    const body = await readJson(res);
    assert.deepEqual(body, { status: "degraded", service: "agent-engine-easy-api", database: "unreachable" });
  });
});

test("checkReadiness() classifies a fast, successful check as 'ok'", async () => {
  const result = await checkReadiness();
  assert.equal(result.status, "ok");
  assert.deepEqual(result.reasons, []);
  assert.ok(result.durationMs >= 0);
});

test("checkReadiness() classifies a slow-but-successful check as 'degraded', with a human-readable reason", async () => {
  await withPatchedDbExecute(slowButSucceeds(550), async () => {
    const result = await checkReadiness();
    assert.equal(result.status, "degraded");
    assert.ok(result.durationMs > 500);
    assert.equal(result.reasons.length, 1);
    assert.match(result.reasons[0], /database query took .+ms/);
  });
});

test("checkReadiness() classifies a throwing check as 'unavailable', with a fixed non-leaky reason (never the raw error message)", async () => {
  await withPatchedDbExecute(alwaysThrows('Connection terminated unexpectedly: password authentication failed for user "postgres"'), async () => {
    const result = await checkReadiness();
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.reasons, ["database unreachable"]);
  });
});
