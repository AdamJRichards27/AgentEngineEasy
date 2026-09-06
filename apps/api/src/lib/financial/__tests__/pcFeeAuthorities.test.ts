// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage E.
//
// Integration tests for the PC fee authority authoring/activation service.
// Central scenarios: separation of duties (the drafter cannot activate
// their own authority), Section 33 sensitive-data redaction (the raw
// mandateProviderRef never appears on the object this module hands back
// to a caller building an API response), and version supersession
// (activating a new authority for an agent replaces any prior ACTIVE one).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, pcFeeAuthorities } from "@aee/db";
import { createBrokerageWithUsers, devLogin, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { createPcFeeAuthority, activatePcFeeAuthority, revokePcFeeAuthority, redactPcFeeAuthority } from "../pcFeeAuthorities.js";
import { FinancialControlError } from "../agreements.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let secondAdmin: DevLoginResult;
let otherBrokerage: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `Financial PC Fee Authority Test ${suffix}`);
  secondAdmin = await devLogin(baseUrl, {
    email: `fin-pcfee-admin2-${suffix}@example.com`,
    firstName: "Second",
    lastName: "Admin",
    brokerageName: `Financial PC Fee Authority Test ${suffix}`,
  });
  otherBrokerage = await createBrokerageWithUsers(baseUrl, `Financial PC Fee Authority Other Test ${suffix}`);
});

after(async () => {
  const ids = [A?.brokerageId, otherBrokerage?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("createPcFeeAuthority", () => {
  test("drafts version 1 as PENDING with no mandate on file", async () => {
    const authority = await createPcFeeAuthority({ brokerageId: A.brokerageId, agentUserId: A.agent.user.id, rateBps: 690, createdByUserId: secondAdmin.user.id });
    assert.equal(authority.version, 1);
    assert.equal(authority.status, "PENDING");
    assert.equal(authority.mandateProviderRef, null);
  });

  test("defaults authorisedPaymentMethod to GENERAL_ACCOUNT_DEBIT_MANDATE when omitted", async () => {
    const authority = await createPcFeeAuthority({ brokerageId: A.brokerageId, agentUserId: A.agent.user.id, rateBps: 690, createdByUserId: secondAdmin.user.id });
    assert.equal(authority.authorisedPaymentMethod, "GENERAL_ACCOUNT_DEBIT_MANDATE");
  });

  // Critical Blocker Remediation, Phase 10 — custody-boundary lock
  // (docs/gate-evidence/PHASE6_FINANCIAL_AND_BILLING_AUDIT.md §16: "AE must
  // not receive, hold, transfer or disburse trust money" was true in effect
  // but not technically enforced — authorisedPaymentMethod was unvalidated
  // free text). This proves the enforcement, not just that the default is
  // correct (the test above already covered that).
  test("rejects any authorisedPaymentMethod other than GENERAL_ACCOUNT_DEBIT_MANDATE", async () => {
    await assert.rejects(
      () =>
        createPcFeeAuthority({
          brokerageId: A.brokerageId,
          agentUserId: A.agent.user.id,
          rateBps: 690,
          createdByUserId: secondAdmin.user.id,
          authorisedPaymentMethod: "TRUST_ACCOUNT_DEBIT",
        }),
      (err: unknown) => err instanceof FinancialControlError && err.reason === "CUSTODY_BOUNDARY_VIOLATION",
    );
  });

  test("accepts an explicit GENERAL_ACCOUNT_DEBIT_MANDATE (the only allowed non-default value, which is also the default)", async () => {
    const authority = await createPcFeeAuthority({
      brokerageId: A.brokerageId,
      agentUserId: A.agent.user.id,
      rateBps: 690,
      createdByUserId: secondAdmin.user.id,
      authorisedPaymentMethod: "GENERAL_ACCOUNT_DEBIT_MANDATE",
    });
    assert.equal(authority.authorisedPaymentMethod, "GENERAL_ACCOUNT_DEBIT_MANDATE");
  });
});

describe("activatePcFeeAuthority — separation of duties and sensitive-data protection", () => {
  test("rejects the drafter activating their own authority", async () => {
    const authority = await createPcFeeAuthority({ brokerageId: A.brokerageId, agentUserId: A.agent.user.id, rateBps: 690, createdByUserId: A.admin.user.id });
    await assert.rejects(
      () => activatePcFeeAuthority(authority.id, A.brokerageId, A.admin.user.id, "sandbox-mandate-ref-1", "sandbox"),
      (err: unknown) => err instanceof FinancialControlError && err.reason === "SEPARATION_OF_DUTIES",
    );
  });

  test("rejects activation with an empty mandate reference", async () => {
    const authority = await createPcFeeAuthority({ brokerageId: A.brokerageId, agentUserId: A.agent.user.id, rateBps: 690, createdByUserId: A.admin.user.id });
    await assert.rejects(
      () => activatePcFeeAuthority(authority.id, A.brokerageId, secondAdmin.user.id, "   ", "sandbox"),
      (err: unknown) => err instanceof FinancialControlError && err.reason === "INVALID_STATUS",
    );
  });

  test("a different activator succeeds, and the redacted view never carries the raw mandateProviderRef", async () => {
    const authority = await createPcFeeAuthority({ brokerageId: A.brokerageId, agentUserId: A.agent.user.id, rateBps: 690, createdByUserId: A.admin.user.id });
    const activated = await activatePcFeeAuthority(authority.id, A.brokerageId, secondAdmin.user.id, "sandbox-mandate-ref-2", "sandbox");
    assert.equal(activated.status, "ACTIVE");
    assert.equal(activated.mandateProviderRef, "sandbox-mandate-ref-2");

    const redacted = redactPcFeeAuthority(activated);
    assert.equal(redacted.hasMandate, true);
    assert.equal((redacted as unknown as { mandateProviderRef?: string }).mandateProviderRef, undefined);
    assert.equal(JSON.stringify(redacted).includes("sandbox-mandate-ref-2"), false);
  });

  test("activating a new authority for the same agent supersedes the prior ACTIVE one", async () => {
    const replacement = await createPcFeeAuthority({ brokerageId: A.brokerageId, agentUserId: A.agent.user.id, rateBps: 700, createdByUserId: A.admin.user.id });
    const activatedReplacement = await activatePcFeeAuthority(replacement.id, A.brokerageId, secondAdmin.user.id, "sandbox-mandate-ref-3", "sandbox");
    assert.equal(activatedReplacement.status, "ACTIVE");

    const priorActiveRows = await db
      .select()
      .from(pcFeeAuthorities)
      .where(eq(pcFeeAuthorities.mandateProviderRef, "sandbox-mandate-ref-2"));
    assert.equal(priorActiveRows[0]?.status, "REPLACED");
  });

  test("a cross-tenant id reads as not found", async () => {
    const foreign = await createPcFeeAuthority({ brokerageId: otherBrokerage.brokerageId, agentUserId: otherBrokerage.agent.user.id, rateBps: 690, createdByUserId: otherBrokerage.admin.user.id });
    await assert.rejects(
      () => activatePcFeeAuthority(foreign.id, A.brokerageId, secondAdmin.user.id, "ref", "sandbox"),
      (err: unknown) => err instanceof FinancialControlError && err.reason === "NOT_FOUND",
    );
  });
});

describe("revokePcFeeAuthority", () => {
  test("revokes an ACTIVE authority and rejects revoking it twice", async () => {
    const authority = await createPcFeeAuthority({ brokerageId: A.brokerageId, agentUserId: A.agent.user.id, rateBps: 690, createdByUserId: A.admin.user.id });
    const activated = await activatePcFeeAuthority(authority.id, A.brokerageId, secondAdmin.user.id, "sandbox-mandate-ref-4", "sandbox");
    const revoked = await revokePcFeeAuthority(activated.id, A.brokerageId, secondAdmin.user.id, "Agent left the brokerage");
    assert.equal(revoked.status, "REVOKED");
    assert.equal(revoked.revokeReason, "Agent left the brokerage");

    await assert.rejects(
      () => revokePcFeeAuthority(activated.id, A.brokerageId, secondAdmin.user.id, "Again"),
      (err: unknown) => err instanceof FinancialControlError && err.reason === "INVALID_STATUS",
    );
  });
});
