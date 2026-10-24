// CC #34, Owner direction t113u D8 ("writes are conditional on the current
// state; there are no lost updates"). An offer leaves `Received` exactly once:
// accept, decline and withdraw are conditional on the row still being
// Received, and every loser gets 409 { code: "OFFER_STATUS_CONFLICT" }.
//
// The races are made deterministic rather than left to timing: the test holds
// a row lock on the contested offer from its own connection, starts both
// requests, waits until Postgres reports both blocked behind that lock
// (pg_blocking_pids), then releases it. Before the fix, both requests returned
// success and the later unconditional UPDATE silently overwrote the first.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, entitlementGrants, offers, pool, properties, transactions } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let seq = 0;

type Res = { status: number; body: Record<string, unknown> };

async function call(method: "GET" | "POST", path: string, cookie: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: body !== undefined ? { cookie, "content-type": "application/json" } : { cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function newProperty(): Promise<number> {
  seq += 1;
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, {
    address: `${seq} Integrity St ${suffix}, Testville`,
    sellerEmail: `seller-integrity-${seq}-${suffix}@example.com`,
  });
  return propertyId;
}

async function newOffer(propertyId: number, priceCents: number): Promise<number> {
  const res = await call("POST", `/offers/by-property/${propertyId}`, A.agent.cookie, {
    offerPriceCents: priceCents,
    conditions: { conditions: "Subject to finance" },
    buyer: { firstName: "Synthetic", lastName: `Buyer${priceCents}`, email: `b-${priceCents}-${seq}-${suffix}@example.com` },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return (res.body.offer as { id: number }).id;
}

async function offerStatus(offerId: number): Promise<string> {
  const [row] = await db.select({ status: offers.status }).from(offers).where(eq(offers.id, offerId));
  return row.status;
}

async function transactionCount(propertyId: number): Promise<number> {
  return (await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.propertyId, propertyId))).length;
}

function isSuccess(r: Res): boolean {
  return r.status === 200 || r.status === 201;
}

function assertConflict(r: Res, label: string): void {
  assert.equal(r.status, 409, `${label}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, "OFFER_STATUS_CONFLICT", label);
  assert.equal(typeof r.body.error, "string", label);
  assert.equal(typeof r.body.currentStatus, "string", label);
}

/**
 * Holds `SELECT ... FOR UPDATE` on one offer row from a dedicated connection,
 * runs `start` (which must fire requests that will block on that row), waits
 * until `expectedWaiters` backends are blocked behind the holder, then commits.
 */
async function raceBehindRowLock(offerId: number, starters: Array<() => Promise<Res>>): Promise<Res[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM offers WHERE id = $1 FOR UPDATE", [offerId]);
    const holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const pending: Array<Promise<Res>> = [];
    for (let i = 0; i < starters.length; i += 1) {
      pending.push(starters[i]());
      await waitForBlocked(holderPid, i + 1);
    }
    await client.query("COMMIT");
    return await Promise.all(pending);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function waitForBlocked(holderPid: number, n: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
      [holderPid],
    );
    // Waiters can also queue behind an earlier waiter instead of the holder,
    // so count anything transitively waiting on the contested row.
    const { rows: chained } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity a
        WHERE cardinality(pg_blocking_pids(a.pid)) > 0
          AND a.datname = current_database()
          AND a.query ILIKE '%offers%'`,
    );
    if (Number(rows[0].n) >= n || (Number(rows[0].n) >= 1 && Number(chained[0].n) >= n)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} blocked request(s) behind pid ${holderPid}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `Offer Integrity A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Offer Integrity B ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("transitions only leave Received: a second decision gets 409 OFFER_STATUS_CONFLICT and changes nothing", async () => {
  const propertyId = await newProperty();
  const declined = await newOffer(propertyId, 70_000_000);
  const withdrawn = await newOffer(propertyId, 71_000_000);
  assert.equal((await call("POST", `/offers/${declined}/decline`, A.admin.cookie)).status, 200);
  assert.equal((await call("POST", `/offers/${withdrawn}/withdraw`, A.admin.cookie)).status, 200);

  const cases: Array<[string, string, number, string]> = [
    ["withdraw a Declined offer", `/offers/${declined}/withdraw`, declined, "Declined"],
    ["decline a Declined offer", `/offers/${declined}/decline`, declined, "Declined"],
    ["accept a Declined offer", `/offers/${declined}/accept`, declined, "Declined"],
    ["decline a Withdrawn offer", `/offers/${withdrawn}/decline`, withdrawn, "Withdrawn"],
    ["withdraw a Withdrawn offer", `/offers/${withdrawn}/withdraw`, withdrawn, "Withdrawn"],
    ["accept a Withdrawn offer", `/offers/${withdrawn}/accept`, withdrawn, "Withdrawn"],
  ];
  for (const [label, path, id, expected] of cases) {
    const r = await call("POST", path, A.agent.cookie);
    assertConflict(r, label);
    assert.equal(r.body.currentStatus, expected, label);
    assert.equal(await offerStatus(id), expected, `${label}: status unchanged`);
  }
  assert.equal(await transactionCount(propertyId), 0);

  // An Accepted offer cannot then be withdrawn or declined.
  const accepted = await newOffer(await newProperty(), 72_000_000);
  assert.equal((await call("POST", `/offers/${accepted}/accept`, A.admin.cookie)).status, 201);
  for (const verb of ["withdraw", "decline"]) {
    const r = await call("POST", `/offers/${accepted}/${verb}`, A.agent.cookie);
    assertConflict(r, `${verb} an Accepted offer`);
    assert.equal(r.body.currentStatus, "Accepted");
  }
  assert.equal(await offerStatus(accepted), "Accepted");
});

test("withdraw vs decline on the same offer: exactly one wins, the other gets 409", async () => {
  const propertyId = await newProperty();
  const offerId = await newOffer(propertyId, 73_000_000);
  const [w, d] = await raceBehindRowLock(offerId, [
    () => call("POST", `/offers/${offerId}/withdraw`, A.agent.cookie),
    () => call("POST", `/offers/${offerId}/decline`, A.admin.cookie),
  ]);
  assert.equal([w, d].filter(isSuccess).length, 1, `exactly one wins: withdraw ${w.status}, decline ${d.status}`);
  const winner = isSuccess(w) ? "Withdrawn" : "Declined";
  assertConflict(isSuccess(w) ? d : w, "loser");
  assert.equal(await offerStatus(offerId), winner, "the stored status is the winner's");
});

for (const loserVerb of ["withdraw", "decline"] as const) {
  test(`accept vs ${loserVerb} on the same offer: exactly one wins, no transaction survives a lost accept`, async () => {
    const propertyId = await newProperty();
    const offerId = await newOffer(propertyId, 74_000_000);
    const [acc, other] = await raceBehindRowLock(offerId, [
      () => call("POST", `/offers/${offerId}/accept`, A.admin.cookie),
      () => call("POST", `/offers/${offerId}/${loserVerb}`, A.agent.cookie),
    ]);
    assert.equal([acc, other].filter(isSuccess).length, 1, `exactly one wins: accept ${acc.status}, ${loserVerb} ${other.status}`);
    const status = await offerStatus(offerId);
    const [property] = await db.select({ stage: properties.workflowStage }).from(properties).where(eq(properties.id, propertyId));
    if (isSuccess(acc)) {
      assertConflict(other, loserVerb);
      assert.equal(status, "Accepted");
      assert.equal(await transactionCount(propertyId), 1);
      assert.equal(property.stage, "Under Offer");
    } else {
      assertConflict(acc, "accept");
      assert.equal(status, loserVerb === "withdraw" ? "Withdrawn" : "Declined");
      assert.equal(await transactionCount(propertyId), 0, "a rolled-back accept leaves no transaction");
      assert.equal(property.stage, "Listed");
    }
  });
}

test("accept vs withdraw of a sibling: the sibling ends Declined (auto) or Withdrawn, never both", async () => {
  const propertyId = await newProperty();
  const winnerId = await newOffer(propertyId, 75_000_000);
  const siblingId = await newOffer(propertyId, 76_000_000);
  const [acc, wd] = await raceBehindRowLock(siblingId, [
    () => call("POST", `/offers/${winnerId}/accept`, A.admin.cookie),
    () => call("POST", `/offers/${siblingId}/withdraw`, A.agent.cookie),
  ]);
  assert.equal(acc.status, 201, JSON.stringify(acc.body));
  assert.equal(await offerStatus(winnerId), "Accepted");
  const siblingStatus = await offerStatus(siblingId);
  const autoDeclineAudits = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "offer_auto_declined"), eq(auditLogs.recordId, String(siblingId))));
  if (isSuccess(wd)) {
    assert.equal(siblingStatus, "Withdrawn");
    assert.equal(autoDeclineAudits.length, 0, "no auto-decline audit for an offer that was withdrawn first");
  } else {
    assertConflict(wd, "withdraw after auto-decline");
    assert.equal(wd.body.currentStatus, "Declined");
    assert.equal(siblingStatus, "Declined");
    assert.equal(autoDeclineAudits.length, 1);
  }
});

test("two different offers accepted at once: one 201, the other 409; one transaction", async () => {
  const propertyId = await newProperty();
  const first = await newOffer(propertyId, 77_000_000);
  const second = await newOffer(propertyId, 78_000_000);
  const [r1, r2] = await Promise.all([
    call("POST", `/offers/${first}/accept`, A.admin.cookie),
    call("POST", `/offers/${second}/accept`, A.agent.cookie),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
  assertConflict(r1.status === 409 ? r1 : r2, "second accept");
  assert.equal(await transactionCount(propertyId), 1);
});

test("the same offer accepted twice at once stays idempotent: 201 + 200 created:false, one transaction", async () => {
  const propertyId = await newProperty();
  const offerId = await newOffer(propertyId, 79_000_000);
  const [r1, r2] = await Promise.all([
    call("POST", `/offers/${offerId}/accept`, A.admin.cookie),
    call("POST", `/offers/${offerId}/accept`, A.agent.cookie),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 201]);
  assert.equal((r1.status === 200 ? r1 : r2).body.created, false);
  assert.equal(await transactionCount(propertyId), 1);
});

test("tenant 404 and run.access 403 still come before any status check", async () => {
  const propertyId = await newProperty();
  const offerId = await newOffer(propertyId, 80_000_000);
  for (const verb of ["accept", "decline", "withdraw"]) {
    const r = await call("POST", `/offers/${offerId}/${verb}`, B.admin.cookie);
    assert.equal(r.status, 404, verb);
    assert.deepEqual(r.body, { error: "Not found" });
  }
  await db
    .update(entitlementGrants)
    .set({ status: "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, A.brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(A.brokerageId);
  try {
    for (const verb of ["accept", "decline", "withdraw"]) {
      const r = await call("POST", `/offers/${offerId}/${verb}`, A.admin.cookie);
      assert.equal(r.status, 403, verb);
      assert.equal(r.body.entitlementKey, "run.access");
    }
  } finally {
    await db
      .update(entitlementGrants)
      .set({ status: "Active" })
      .where(and(eq(entitlementGrants.brokerageId, A.brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
    invalidateEntitlementCache(A.brokerageId);
  }
  assert.equal(await offerStatus(offerId), "Received", "no 404/403 path changed the offer");
});
