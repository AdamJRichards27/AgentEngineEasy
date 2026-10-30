// Settlement billing with one ACTIVE PC fee authority per agent (Owner t183u, t201u: "one card
// authority only"). handleSettlementCompleted bills the agent's ACTIVE authority. With exactly one,
// it bills that one. If corrupt legacy data has more than one, it must fail closed and bill nothing:
// it used to take whichever row the database returned first, so the rate charged was arbitrary.
// Synthetic data, local throwaway test DB only.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db, commissionAgreements, financialPaymentRequests, pcFeeAuthorities, transactions } from "@aee/db";
import type { DomainEvent } from "@aee/events";
import { createBrokerageWithUsers, createTransactionFromListedProperty, devLogin, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { createPcFeeAuthority, activatePcFeeAuthority } from "../pcFeeAuthorities.js";
import { handleSettlementCompleted } from "../bootstrap.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageIds: number[] = [];

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await cleanupBrokerages(brokerageIds);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

/** A brokerage whose agent has a transaction with an APPROVED commission agreement, ready to settle. */
async function settleableWorld(tag: string) {
  const name = `PCF Settle One Active ${tag} ${suffix}`;
  const B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number } = await createBrokerageWithUsers(baseUrl, name);
  brokerageIds.push(B.brokerageId);
  const activator = await devLogin(baseUrl, { email: `pcf-settle-${tag}-${suffix}@example.com`, firstName: "Second", lastName: "Admin", brokerageName: name });
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, B.agent.cookie, { address: `${tag} One Active St ${suffix}` });
  await db.update(transactions).set({ purchasePriceCents: 80_000_000 }).where(eq(transactions.id, transactionId));
  await db.insert(commissionAgreements).values({ brokerageId: B.brokerageId, propertyId, transactionId, version: 1, method: "PERCENTAGE", rateBps: 250, status: "APPROVED" });
  const draft = () => createPcFeeAuthority({ brokerageId: B.brokerageId, agentUserId: B.agent.user.id, rateBps: 690, createdByUserId: B.admin.user.id });
  const settle = () =>
    handleSettlementCompleted({ eventType: "SETTLEMENT_COMPLETED", transactionId, brokerageId: B.brokerageId, propertyId, correlationId: `settle-${tag}-${suffix}` } as unknown as DomainEvent);
  const requests = () => db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.transactionId, transactionId));
  return { B, activator, draft, settle, requests };
}

describe("settlement bills the agent's single ACTIVE PC fee authority", () => {
  test("one ACTIVE authority (after a replacement): the fee request is raised against the ACTIVE one, not the replaced one", async () => {
    const w = await settleableWorld("single");
    const first = await w.draft();
    await activatePcFeeAuthority(first.id, w.B.brokerageId, w.activator.user.id, `settle-single-1-${suffix}`, "sandbox");
    const second = await w.draft();
    await activatePcFeeAuthority(second.id, w.B.brokerageId, w.activator.user.id, `settle-single-2-${suffix}`, "sandbox");
    await w.settle();
    const reqs = await w.requests();
    assert.equal(reqs.length, 1, JSON.stringify(reqs));
    assert.equal(reqs[0]!.pcFeeAuthorityId, second.id);
  });

  test("corrupt data with two ACTIVE authorities: fails closed, no fee request raised against either", async (t) => {
    const w = await settleableWorld("dup");
    const a = await w.draft();
    const b = await w.draft();
    try {
      // Legacy/raced state, forced directly; activation can no longer produce it.
      await db.update(pcFeeAuthorities).set({ status: "ACTIVE", mandateProviderRef: "sandbox-legacy", mandateProvider: "sandbox" }).where(inArray(pcFeeAuthorities.id, [a.id, b.id]));
    } catch (err) {
      // With the proposed partial unique index in place, the database refuses this state outright.
      assert.match(String((err as { cause?: unknown }).cause ?? err), /pc_fee_authorities_one_active_per_agent_idx/);
      t.skip("the one-ACTIVE-per-agent unique index refuses the duplicate state");
      return;
    }
    await w.settle();
    assert.deepEqual(await w.requests(), []);
  });
});
