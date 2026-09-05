// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// Proves the AsyncLocalStorage-based ambient correlation context actually
// propagates across await boundaries (the entire point of using it instead
// of threading an id through every function signature by hand), stays
// isolated between concurrent contexts, supports nested re-entry (a retry
// or replay establishing its own chain), and degrades gracefully when
// nothing has established a context at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithCorrelationId, getActiveCorrelationId, getActiveCausationId, currentCorrelationId } from "../context.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("currentCorrelationId() returns a fresh id when no context is active", () => {
  const a = currentCorrelationId();
  const b = currentCorrelationId();
  assert.notEqual(a, b, "two calls outside any context should each mint a fresh id, not share one");
});

test("getActiveCorrelationId()/getActiveCausationId() are undefined/null outside any context", () => {
  assert.equal(getActiveCorrelationId(), undefined);
  assert.equal(getActiveCausationId(), null);
});

test("runWithCorrelationId establishes the id for the synchronous extent of fn", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const seen = runWithCorrelationId(id, () => getActiveCorrelationId());
  assert.equal(seen, id);
});

test("the ambient correlationId survives multiple awaited hops inside fn", async () => {
  const id = "22222222-2222-2222-2222-222222222222";
  const seen = await runWithCorrelationId(id, async () => {
    await delay(5);
    async function nested(): Promise<string | undefined> {
      await delay(5);
      return currentCorrelationId();
    }
    const inner = await nested();
    await delay(5);
    return { top: getActiveCorrelationId(), inner };
  });
  assert.equal(seen.top, id);
  assert.equal(seen.inner, id);
});

test("currentCorrelationId() (not just getActiveCorrelationId()) also returns the ambient id when a context is active", async () => {
  const id = "33333333-3333-3333-3333-333333333333";
  const seen = await runWithCorrelationId(id, async () => {
    await delay(1);
    return currentCorrelationId();
  });
  assert.equal(seen, id);
});

test("two concurrent runWithCorrelationId calls never leak into each other's context", async () => {
  const results: Record<string, string | undefined> = {};
  await Promise.all([
    runWithCorrelationId("aaaaaaaa-0000-0000-0000-000000000000", async () => {
      await delay(20);
      results.a = getActiveCorrelationId();
    }),
    runWithCorrelationId("bbbbbbbb-0000-0000-0000-000000000000", async () => {
      await delay(5);
      results.b = getActiveCorrelationId();
    }),
  ]);
  assert.equal(results.a, "aaaaaaaa-0000-0000-0000-000000000000");
  assert.equal(results.b, "bbbbbbbb-0000-0000-0000-000000000000");
});

test("causationId defaults to null when not provided", () => {
  const seen = runWithCorrelationId("44444444-4444-4444-4444-444444444444", () => getActiveCausationId());
  assert.equal(seen, null);
});

test("causationId is carried alongside correlationId when provided", () => {
  const seen = runWithCorrelationId(
    "55555555-5555-5555-5555-555555555555",
    () => ({ correlationId: getActiveCorrelationId(), causationId: getActiveCausationId() }),
    "predecessor-event-id",
  );
  assert.equal(seen.correlationId, "55555555-5555-5555-5555-555555555555");
  assert.equal(seen.causationId, "predecessor-event-id");
});

test("a nested runWithCorrelationId call establishes its own chain and restores the outer one on return", async () => {
  const outerId = "66666666-6666-6666-6666-666666666666";
  const innerId = "77777777-7777-7777-7777-777777777777";
  const seen: string[] = [];
  await runWithCorrelationId(outerId, async () => {
    seen.push(getActiveCorrelationId()!);
    await runWithCorrelationId(innerId, async () => {
      await delay(1);
      seen.push(getActiveCorrelationId()!);
    });
    await delay(1);
    seen.push(getActiveCorrelationId()!);
  });
  assert.deepEqual(seen, [outerId, innerId, outerId]);
});

test("context does not leak after runWithCorrelationId returns", async () => {
  await runWithCorrelationId("88888888-8888-8888-8888-888888888888", async () => {
    await delay(1);
  });
  assert.equal(getActiveCorrelationId(), undefined);
});
