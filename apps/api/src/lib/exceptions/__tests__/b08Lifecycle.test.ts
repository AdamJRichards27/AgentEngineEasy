// B08 v2 — campaign-info findings are limited to active marketing stages.
//
// Listed and Under Offer with empty pre-marketing fields open one B08 row.
// Contract (sold), Settlement (settled), and Closed do not stay open solely
// because those fields are empty: the scheduled sweep resolves the existing
// row as SYSTEM / NO_LONGER_APPLICABLE and keeps it. Filling the fields
// still resolves as CONDITION_SATISFIED. No other rule grows this hook.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  properties,
  riskExceptions,
  riskExceptionTransitions,
  auditLogs,
  WORKFLOW_STAGES,
  type RiskException,
} from "@aee/db";
import { publishDomainEvent, newCorrelationId } from "@aee/events";
import {
  runScheduledScan,
  handleExceptionDomainEvent,
  type ScanSummary,
} from "../engine.js";
import { RISK_RULES } from "../registry.js";
import {
  B08_ACTIVE_MARKETING_STAGES,
  B08_RULE_ID,
  B08_RULE_VERSION,
  b08EvidenceWhenAbsent,
} from "../rules/listing.js";
import {
  createBrokerageWithUsers,
  cleanupBrokerages,
  type DevLoginResult,
} from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

describe("B08 v2 marketing-stage lifecycle", { concurrency: false }, () => {
  let server: Server;
  let baseUrl: string;
  const suffix = Date.now();
  let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
  let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

  before(async () => {
    const { configureEvents } = await import("../../events.js");
    configureEvents();
    const { createApp } = await import("../../../app.js");
    const app = createApp();
    server = app.listen(0);
    await new Promise<void>((resolve) =>
      server.once("listening", () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("unexpected server address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    A = await createBrokerageWithUsers(baseUrl, `B08 Lifecycle A ${suffix}`);
    B = await createBrokerageWithUsers(baseUrl, `B08 Lifecycle B ${suffix}`);
  });

  after(async () => {
    const ids = [A?.brokerageId, B?.brokerageId].filter(
      (id): id is number => typeof id === "number",
    );
    await cleanupBrokerages(ids);
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  async function createProperty(
    cookie: string,
    address: string,
  ): Promise<number> {
    const res = await fetch(`${baseUrl}/api/properties`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        formattedAddress: address,
        state: "NSW",
        suburb: "Testville",
        postcode: "2000",
      }),
    });
    if (res.status !== 201)
      throw new Error(
        `create property failed: ${res.status} ${await res.text()}`,
      );
    const { property } = (await res.json()) as { property: { id: number } };
    return property.id;
  }

  async function scanOrRetry(brokerageIds: number[]): Promise<ScanSummary> {
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await runScheduledScan("MANUAL", { brokerageIds });
      if (result.ok) return result.summary;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      "runScheduledScan did not succeed after retries — another scan kept the lock held throughout",
    );
  }

  async function b08Rows(propertyId: number): Promise<RiskException[]> {
    return db
      .select()
      .from(riskExceptions)
      .where(
        and(
          eq(riskExceptions.propertyId, propertyId),
          eq(riskExceptions.ruleId, B08_RULE_ID),
        ),
      );
  }

  async function setStage(
    propertyId: number,
    workflowStage: string,
  ): Promise<void> {
    await db
      .update(properties)
      .set({ workflowStage, updatedAt: new Date() })
      .where(eq(properties.id, propertyId));
  }

  async function fillCampaign(propertyId: number): Promise<void> {
    await db
      .update(properties)
      .set({
        salesMethod: "Auction",
        priceDisplay: "Auction — Guide $750,000",
        campaignStartDate: new Date("2026-06-01T00:00:00.000Z"),
        campaignEndDate: new Date("2026-06-21T00:00:00.000Z"),
        updatedAt: new Date(),
      })
      .where(eq(properties.id, propertyId));
  }

  const EMPTY_CAMPAIGN = {
    salesMethod: null,
    priceDisplay: null,
    campaignStartDate: null,
    campaignEndDate: null,
  };

  test("B08 absent-finding evidence follows the marketing-stage window", () => {
    const filled = {
      salesMethod: "Auction",
      priceDisplay: "Auction",
      campaignStartDate: new Date("2026-06-01T00:00:00.000Z"),
      campaignEndDate: new Date("2026-06-21T00:00:00.000Z"),
    };
    for (const stage of WORKFLOW_STAGES) {
      const active = (
        B08_ACTIVE_MARKETING_STAGES as readonly string[]
      ).includes(stage);
      const missing = b08EvidenceWhenAbsent(
        { workflowStage: stage, ...EMPTY_CAMPAIGN },
        B08_RULE_VERSION,
      );
      const present = b08EvidenceWhenAbsent(
        { workflowStage: stage, ...filled },
        B08_RULE_VERSION,
      );
      assert.equal(
        present,
        null,
        `${stage} with campaign fields present is a real clear, not a stage exit`,
      );
      if (active) {
        assert.equal(missing, null, `${stage} is inside the marketing window`);
      } else {
        assert.deepEqual(missing, {
          kind: "NO_LONGER_APPLICABLE",
          ruleCode: B08_RULE_ID,
          ruleVersion: B08_RULE_VERSION,
          workflowStage: stage,
        });
      }
    }
    assert.deepEqual(
      [...B08_ACTIVE_MARKETING_STAGES],
      ["Listed", "Under Offer"],
    );
  });

  test("only B08 explains an absent finding; B07 stays version 1", () => {
    const hooked = RISK_RULES.filter(
      (rule) => rule.resolutionEvidenceWhenAbsent,
    ).map((rule) => rule.ruleId);
    assert.deepEqual(hooked, [B08_RULE_ID]);
    const b07 = RISK_RULES.find(
      (rule) => rule.ruleId === "B07_LISTING_LIVE_MISSING_REQUIRED_INFO",
    );
    const b08 = RISK_RULES.find((rule) => rule.ruleId === B08_RULE_ID);
    assert.equal(b07?.version, 1);
    assert.equal(b07?.resolutionEvidenceWhenAbsent, undefined);
    assert.equal(b08?.version, B08_RULE_VERSION);
  });

  test("active marketing stages open B08; sold, settled, and closed stages resolve it without deleting the row", async () => {
    const propertyId = await createProperty(
      A.agent.cookie,
      `${suffix} Active Marketing Rd`,
    );

    await scanOrRetry([A.brokerageId]);
    assert.equal(
      (await b08Rows(propertyId)).length,
      0,
      "Appraisal is before the marketing window",
    );

    await setStage(propertyId, "Ready to List");
    await scanOrRetry([A.brokerageId]);
    assert.equal(
      (await b08Rows(propertyId)).length,
      0,
      "Ready to List is before the marketing window",
    );

    await setStage(propertyId, "Listed");
    await scanOrRetry([A.brokerageId]);
    const opened = await b08Rows(propertyId);
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.status, "OPEN");
    assert.equal(opened[0]!.ruleVersion, B08_RULE_VERSION);
    assert.equal(opened[0]!.severity, "ATTENTION");
    assert.equal(opened[0]!.dismissible, false);
    assert.equal(opened[0]!.brokerageId, A.brokerageId);
    const openedId = opened[0]!.id;
    const dedupKey = opened[0]!.dedupKey;

    await setStage(propertyId, "Under Offer");
    await scanOrRetry([A.brokerageId]);
    const stillMarketed = await b08Rows(propertyId);
    assert.equal(stillMarketed.length, 1);
    assert.equal(stillMarketed[0]!.id, openedId);
    assert.equal(
      stillMarketed[0]!.status,
      "OPEN",
      "Under Offer is the inclusive marketing-stage upper limit",
    );

    await setStage(propertyId, "Contract");
    const event = await publishDomainEvent({
      eventType: "LISTING_LIVE",
      occurredAt: new Date(),
      propertyId,
      transactionId: null,
      partyId: null,
      brokerageId: A.brokerageId,
      agentId: A.agent.user.id,
      actorType: "USER",
      actorId: A.agent.user.id,
      source: "test:b08-lifecycle",
      correlationId: newCorrelationId(),
      causationId: null,
      idempotencyKey: `test-b08-lifecycle:${randomUUID()}`,
      payload: { propertyId },
      metadata: {},
    });
    await handleExceptionDomainEvent(event);
    const afterEvent = (await b08Rows(propertyId))[0]!;
    assert.equal(afterEvent.id, openedId);
    assert.equal(
      afterEvent.status,
      "OPEN",
      "the event-driven path must not resolve a stage exit",
    );

    await scanOrRetry([A.brokerageId]);
    const resolved = (await b08Rows(propertyId))[0]!;
    assert.equal(
      resolved.id,
      openedId,
      "the historical finding is the same row",
    );
    assert.equal(resolved.status, "RESOLVED");
    assert.notEqual(resolved.status, "DISMISSED");
    assert.equal(resolved.resolutionMethod, "AUTO");
    assert.equal(resolved.resolvedByUserId, null);
    assert.equal(
      resolved.title,
      "Live listing is missing campaign or sales-method information",
    );
    assert.deepEqual(resolved.resolutionEvidence, {
      kind: "NO_LONGER_APPLICABLE",
      ruleCode: B08_RULE_ID,
      ruleVersion: B08_RULE_VERSION,
      record: {
        brokerageId: A.brokerageId,
        propertyId,
        transactionId: null,
        closedAt: null,
        workflowStage: "Contract",
        scope: "STAGE_EXIT",
        sourceRecordType: "property",
        sourceRecordId: String(propertyId),
        dedupKey,
      },
    });

    const transitions = await db
      .select()
      .from(riskExceptionTransitions)
      .where(eq(riskExceptionTransitions.exceptionId, openedId));
    const resolvedTransition = transitions.find(
      (row) => row.transitionType === "RESOLVED",
    );
    assert.ok(resolvedTransition, "expected a RESOLVED audit transition");
    assert.equal(resolvedTransition.actorType, "SYSTEM");
    assert.equal(resolvedTransition.actorUserId, null);
    assert.equal(resolvedTransition.fromValue, "OPEN");
    assert.equal(resolvedTransition.toValue, "RESOLVED");
    assert.equal(resolvedTransition.brokerageId, A.brokerageId);
    const metadata = resolvedTransition.metadata as {
      evidence?: { kind?: string };
    } | null;
    assert.equal(metadata?.evidence?.kind, "NO_LONGER_APPLICABLE");

    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.recordType, "risk_exception"),
          eq(auditLogs.recordId, openedId),
          eq(auditLogs.action, "risk_exception_auto_resolved"),
        ),
      );
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.userId, null);
    assert.equal(audits[0]!.propertyId, propertyId);

    await scanOrRetry([A.brokerageId]);
    const afterRescan = await b08Rows(propertyId);
    assert.equal(
      afterRescan.length,
      1,
      "a later sweep must not open a duplicate or a stale second occurrence",
    );
    assert.equal(afterRescan[0]!.id, openedId);
    assert.equal(afterRescan[0]!.status, "RESOLVED");
    assert.equal(afterRescan[0]!.dedupKey, dedupKey);

    await setStage(propertyId, "Settlement");
    await scanOrRetry([A.brokerageId]);
    await setStage(propertyId, "Closed");
    await scanOrRetry([A.brokerageId]);
    const finished = await b08Rows(propertyId);
    assert.equal(finished.length, 1);
    assert.equal(finished[0]!.status, "RESOLVED");
    assert.equal(
      (finished[0]!.resolutionEvidence as { kind?: string }).kind,
      "NO_LONGER_APPLICABLE",
    );
  });

  test("a property that is already settled or closed never opens B08 for empty campaign fields", async () => {
    const settledId = await createProperty(
      A.agent.cookie,
      `${suffix} Already Settled Rd`,
    );
    const closedId = await createProperty(
      A.agent.cookie,
      `${suffix} Already Closed Rd`,
    );
    await setStage(settledId, "Settlement");
    await setStage(closedId, "Closed");

    await scanOrRetry([A.brokerageId]);

    assert.equal((await b08Rows(settledId)).length, 0);
    assert.equal((await b08Rows(closedId)).length, 0);
  });

  test("filling campaign fields on a live listing resolves B08 as cleared, including when the stage also moves on", async () => {
    const liveId = await createProperty(
      A.agent.cookie,
      `${suffix} Fields Filled Rd`,
    );
    await setStage(liveId, "Listed");
    await fillCampaign(liveId);
    await scanOrRetry([A.brokerageId]);
    assert.equal(
      (await b08Rows(liveId)).length,
      0,
      "a marketed listing with campaign fields does not open B08",
    );

    const clearedId = await createProperty(
      A.agent.cookie,
      `${suffix} Then Filled Rd`,
    );
    await setStage(clearedId, "Listed");
    await scanOrRetry([A.brokerageId]);
    const opened = (await b08Rows(clearedId))[0];
    assert.ok(opened);
    assert.equal(opened.status, "OPEN");

    await fillCampaign(clearedId);
    await scanOrRetry([A.brokerageId]);
    const cleared = (await b08Rows(clearedId))[0]!;
    assert.equal(cleared.id, opened.id);
    assert.equal(cleared.status, "RESOLVED");
    const clearedEvidence = cleared.resolutionEvidence as {
      kind: string;
      ruleCode: string;
      ruleVersion: number;
      record: { scope: string; workflowStage: string | null; propertyId: number };
    };
    assert.equal(clearedEvidence.kind, "CONDITION_SATISFIED");
    assert.equal(clearedEvidence.ruleCode, B08_RULE_ID);
    assert.equal(clearedEvidence.ruleVersion, B08_RULE_VERSION);
    assert.equal(clearedEvidence.record.scope, "IN_SCOPE");
    assert.equal(clearedEvidence.record.workflowStage, "Listed");
    assert.equal(clearedEvidence.record.propertyId, clearedId);

    const movedId = await createProperty(
      A.agent.cookie,
      `${suffix} Filled And Sold Rd`,
    );
    await setStage(movedId, "Listed");
    await scanOrRetry([A.brokerageId]);
    const movedOpen = (await b08Rows(movedId))[0];
    assert.ok(movedOpen);
    await fillCampaign(movedId);
    await setStage(movedId, "Closed");
    await scanOrRetry([A.brokerageId]);
    const moved = (await b08Rows(movedId))[0]!;
    assert.equal(moved.id, movedOpen.id);
    assert.equal(moved.status, "RESOLVED");
    assert.equal(
      (moved.resolutionEvidence as { kind?: string }).kind,
      "CONDITION_SATISFIED",
    );
  });

  test("a scan of one brokerage does not resolve another brokerage's open B08", async () => {
    const propertyId = await createProperty(
      B.agent.cookie,
      `${suffix} Other Tenant Rd`,
    );
    await setStage(propertyId, "Listed");
    await scanOrRetry([B.brokerageId]);
    const opened = (await b08Rows(propertyId))[0];
    assert.ok(opened);
    assert.equal(opened.brokerageId, B.brokerageId);
    assert.equal(opened.status, "OPEN");

    await scanOrRetry([A.brokerageId]);
    const untouched = (await b08Rows(propertyId))[0]!;
    assert.equal(untouched.id, opened.id);
    assert.equal(untouched.status, "OPEN");
    assert.equal(untouched.brokerageId, B.brokerageId);
  });

  test("a failed B08 stage-exit explanation does not resolve the exception", async () => {
    const propertyId = await createProperty(
      A.agent.cookie,
      `${suffix} Explanation Failed Rd`,
    );
    await setStage(propertyId, "Listed");
    await scanOrRetry([A.brokerageId]);
    const opened = (await b08Rows(propertyId))[0];
    assert.ok(opened);

    await setStage(propertyId, "Closed");
    const rule = RISK_RULES.find(
      (candidate) => candidate.ruleId === B08_RULE_ID,
    );
    assert.ok(rule?.resolutionEvidenceWhenAbsent);
    const original = rule.resolutionEvidenceWhenAbsent;
    rule.resolutionEvidenceWhenAbsent = async () => {
      throw new Error("b08 explanation unavailable");
    };
    try {
      const summary = await scanOrRetry([A.brokerageId]);
      assert.ok(summary.errors >= 1);
      const stillOpen = (await b08Rows(propertyId))[0]!;
      assert.equal(stillOpen.id, opened.id);
      assert.equal(stillOpen.status, "OPEN");
      assert.equal(stillOpen.resolutionEvidence, null);
      const transitions = await db
        .select()
        .from(riskExceptionTransitions)
        .where(eq(riskExceptionTransitions.exceptionId, opened.id));
      const failure = transitions.find(
        (row) => row.transitionType === "EVALUATION_FAILED",
      );
      assert.ok(failure);
      assert.equal(failure.actorType, "SYSTEM");
      assert.match(failure.reason ?? "", /b08 explanation unavailable/);
    } finally {
      rule.resolutionEvidenceWhenAbsent = original;
    }

    await scanOrRetry([A.brokerageId]);
    const resolved = (await b08Rows(propertyId))[0]!;
    assert.equal(resolved.id, opened.id);
    assert.equal(resolved.status, "RESOLVED");
    const evidence = resolved.resolutionEvidence as {
      kind?: string;
      record?: { workflowStage?: string; scope?: string };
    };
    assert.equal(evidence.kind, "NO_LONGER_APPLICABLE");
    assert.equal(evidence.record?.scope, "STAGE_EXIT");
    assert.equal(evidence.record?.workflowStage, "Closed");
  });

  test("B07 still opens on a closed property with a missing address field", async () => {
    const propertyId = await createProperty(
      A.agent.cookie,
      `${suffix} Closed Address Rd`,
    );
    await setStage(propertyId, "Closed");
    await db
      .update(properties)
      .set({ suburb: null, updatedAt: new Date() })
      .where(eq(properties.id, propertyId));

    await scanOrRetry([A.brokerageId]);

    const rows = await db
      .select()
      .from(riskExceptions)
      .where(eq(riskExceptions.propertyId, propertyId));
    const b07 = rows.find(
      (row) => row.ruleId === "B07_LISTING_LIVE_MISSING_REQUIRED_INFO",
    );
    const b08 = rows.find((row) => row.ruleId === B08_RULE_ID);
    assert.ok(b07, "B07 is not limited by the B08 marketing window");
    assert.equal(b07.status, "OPEN");
    assert.equal(b07.ruleVersion, 1);
    assert.equal(b08, undefined);
  });
});
