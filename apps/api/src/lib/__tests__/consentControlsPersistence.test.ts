import { test } from "node:test";
import assert from "node:assert/strict";
import { inArray, sql } from "drizzle-orm";

const databaseEnabled = Boolean(process.env.DATABASE_URL);

test(
  "consent persistence uses append order and purpose/scope, not caller capture time",
  { skip: !databaseEnabled, concurrency: false },
  async (t) => {
    const [{ db, brokerages, users, parties, auditLogs, growContactChannelConsents, growConsentDecisions, growConsentPolicyVersions }, persistence] = await Promise.all([
      import("@aee/db"),
      import("../consentControlsPersistence.js"),
    ]);
    try {
      await db.execute(sql`select 1 from grow_contact_channel_consents limit 0`);
    } catch {
      t.skip("F2 consent tables are not present in this database; run the isolated migration test target.");
      return;
    }
    const suffix = `${Date.now()}_${process.pid}`;
    const [brokerage] = await db.insert(brokerages).values({ name: `F2 persistence A ${suffix}` }).returning();
    const [user] = await db
      .insert(users)
      .values({
        authProviderId: `f2-persistence-auth-${suffix}`,
        email: `f2-persistence-${suffix}@example.test`,
        firstName: "F2",
        lastName: "Persistence",
        brokerageId: brokerage.id,
      })
      .returning();
    const [party] = await db.insert(parties).values({ brokerageId: brokerage.id, firstName: "F2", lastName: "Contact" }).returning();

    try {
      const first = await persistence.captureConsentState({
        brokerageId: brokerage.id,
        partyId: party.id,
        channel: "EMAIL",
        state: "EXPRESS",
        source: "test",
        capturedAt: new Date("2035-01-01T00:00:00.000Z"),
        captureMethod: "test",
        purpose: "outreach",
        scope: "standing",
        jurisdiction: "AU",
        recordedByUserId: user.id,
      });
      await persistence.captureConsentState({
        brokerageId: brokerage.id,
        partyId: party.id,
        channel: "EMAIL",
        state: "NONE",
        source: "test",
        capturedAt: new Date("2020-01-01T00:00:00.000Z"),
        captureMethod: "test",
        purpose: "outreach",
        scope: "standing",
        jurisdiction: "AU",
        recordedByUserId: user.id,
        supersedesConsentId: first.id,
      });

      const [latest] = await db
        .select()
        .from(growContactChannelConsents)
        .where(sql`${growContactChannelConsents.partyId} = ${party.id}`)
        .orderBy(sql`${growContactChannelConsents.id} desc`)
        .limit(1);
      assert.equal(latest.state, "NONE");
      await assert.rejects(
        persistence.captureConsentState({
          brokerageId: brokerage.id,
          partyId: party.id,
          channel: "EMAIL",
          state: "WITHDRAWN",
          source: "test",
          captureMethod: "test",
          purpose: "outreach",
          scope: "standing",
          withdrawnAt: new Date(),
          withdrawnByUserId: user.id,
          withdrawalReason: "stale supersession",
          supersedesConsentId: first.id,
          recordedByUserId: user.id,
        }),
      );

      const withdrawable = await persistence.captureConsentState({
        brokerageId: brokerage.id,
        partyId: party.id,
        channel: "EMAIL",
        state: "EXPRESS",
        source: "test",
        captureMethod: "test",
        purpose: "withdrawal",
        scope: "standing",
        jurisdiction: "AU",
        recordedByUserId: user.id,
      });
      const withdrawn = await persistence.captureConsentState({
        brokerageId: brokerage.id,
        partyId: party.id,
        channel: "EMAIL",
        state: "WITHDRAWN",
        source: "test",
        captureMethod: "test",
        purpose: "withdrawal",
        scope: "standing",
        withdrawnAt: new Date(),
        withdrawnByUserId: user.id,
        withdrawalReason: "contact request",
        supersedesConsentId: withdrawable.id,
        recordedByUserId: user.id,
      });
      assert.equal(withdrawn.state, "WITHDRAWN");
      await assert.rejects(
        persistence.captureConsentState({
          brokerageId: brokerage.id,
          partyId: party.id,
          channel: "EMAIL",
          state: "NONE",
          source: "test",
          captureMethod: "test",
          purpose: "withdrawal",
          scope: "standing",
          supersedesConsentId: withdrawn.id,
          recordedByUserId: user.id,
        }),
      );
      await assert.rejects(
        persistence.captureConsentState({
          brokerageId: brokerage.id,
          partyId: party.id,
          channel: "EMAIL",
          state: "EXPRESS",
          source: "test",
          captureMethod: "test",
          purpose: "withdrawal",
          scope: "standing",
          jurisdiction: "AU",
          recordedByUserId: user.id,
        }),
      );

      await persistence.recordConsentPolicy({
        brokerageId: brokerage.id,
        jurisdiction: "AU",
        version: "au-old",
        effectiveAt: new Date("2020-01-01T00:00:00.000Z"),
        dncrRequired: false,
        timeZone: "Etc/UTC",
        allowedHoursStart: "00:00",
        allowedHoursEnd: "23:59",
        recordedByUserId: user.id,
      });
      await persistence.recordConsentPolicy({
        brokerageId: brokerage.id,
        jurisdiction: "AU",
        version: "au-new",
        effectiveAt: new Date("2021-01-01T00:00:00.000Z"),
        dncrRequired: false,
        timeZone: "Etc/UTC",
        allowedHoursStart: "00:00",
        allowedHoursEnd: "23:59",
        recordedByUserId: user.id,
      });
      const decision = await persistence.evaluateAndRecordConsentDecision({
        brokerageId: brokerage.id,
        partyId: party.id,
        channel: "EMAIL",
        purpose: "outreach",
        scope: "standing",
        jurisdiction: "AU",
      });
      assert.equal(decision.evaluation.reasonCode, "NO_CONSENT");
      assert.equal(decision.decision.consentId, latest.id);
      assert.equal(decision.decision.policyVersion, "au-new");
    } finally {
      await db.delete(growConsentDecisions).where(sql`${growConsentDecisions.brokerageId} = ${brokerage.id}`);
      await db.delete(growContactChannelConsents).where(sql`${growContactChannelConsents.brokerageId} = ${brokerage.id}`);
      await db.delete(growConsentPolicyVersions).where(sql`${growConsentPolicyVersions.brokerageId} = ${brokerage.id}`);
      await db.delete(auditLogs).where(sql`${auditLogs.brokerageId} = ${brokerage.id}`);
      await db.delete(parties).where(sql`${parties.brokerageId} = ${brokerage.id}`);
      await db.delete(users).where(sql`${users.brokerageId} = ${brokerage.id}`);
      await db.delete(brokerages).where(sql`${brokerages.id} = ${brokerage.id}`);
    }
  },
);

test(
  "consent persistence rolls back source rows on strict audit failure and rejects cross-tenant references",
  { skip: !databaseEnabled, concurrency: false },
  async (t) => {
    const [{ db, brokerages, users, parties, auditLogs, growContactChannelConsents, growConsentDecisions }, persistence] = await Promise.all([
      import("@aee/db"),
      import("../consentControlsPersistence.js"),
    ]);
    try {
      await db.execute(sql`select 1 from grow_contact_channel_consents limit 0`);
    } catch {
      t.skip("F2 consent tables are not present in this database; run the isolated migration test target.");
      return;
    }
    const suffix = `${Date.now()}_${process.pid}`;
    const [brokerageA, brokerageB] = await db
      .insert(brokerages)
      .values([{ name: `F2 rollback A ${suffix}` }, { name: `F2 rollback B ${suffix}` }])
      .returning();
    const [userA] = await db
      .insert(users)
      .values({
        authProviderId: `f2-rollback-auth-a-${suffix}`,
        email: `f2-rollback-a-${suffix}@example.test`,
        firstName: "F2",
        lastName: "A",
        brokerageId: brokerageA.id,
      })
      .returning();
    const [userB] = await db
      .insert(users)
      .values({
        authProviderId: `f2-rollback-auth-b-${suffix}`,
        email: `f2-rollback-b-${suffix}@example.test`,
        firstName: "F2",
        lastName: "B",
        brokerageId: brokerageB.id,
      })
      .returning();
    const [partyA] = await db.insert(parties).values({ brokerageId: brokerageA.id, firstName: "A" }).returning();
    const [partyB] = await db.insert(parties).values({ brokerageId: brokerageB.id, firstName: "B" }).returning();
    const triggerName = `f2_consent_audit_fault_${suffix.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    const functionName = `${triggerName}_fn`;

    try {
      await db.execute(
        sql.raw(`
          create or replace function ${functionName}() returns trigger as $body$
          begin
            raise exception 'f2 audit rollback test';
          end;
          $body$ language plpgsql;
        `),
      );
      await db.execute(
        sql.raw(`
          create trigger ${triggerName}
          before insert on audit_logs
          for each row
          when (new.action = 'grow_consent_state_captured')
          execute function ${functionName}();
        `),
      );

      await assert.rejects(
        persistence.captureConsentState({
          brokerageId: brokerageA.id,
          partyId: partyA.id,
          channel: "EMAIL",
          state: "NONE",
          source: "rollback-test",
          captureMethod: "test",
          purpose: "rollback",
          scope: "one-off",
          recordedByUserId: userA.id,
        }),
      );
      const [afterRollback] = await db
        .select({ count: sql<number>`count(*)` })
        .from(growContactChannelConsents)
        .where(sql`${growContactChannelConsents.brokerageId} = ${brokerageA.id}`);
      assert.equal(Number(afterRollback.count), 0);
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ${triggerName} on audit_logs;`));
      await db.execute(sql.raw(`drop function if exists ${functionName}();`));
    }

    const decisionTriggerName = `${triggerName}_decision`;
    const decisionFunctionName = `${functionName}_decision`;
    try {
      await db.execute(
        sql.raw(`
          create or replace function ${decisionFunctionName}() returns trigger as $body$
          begin
            raise exception 'f2 decision audit rollback test';
          end;
          $body$ language plpgsql;
        `),
      );
      await db.execute(
        sql.raw(`
          create trigger ${decisionTriggerName}
          before insert on audit_logs
          for each row
          when (new.action = 'grow_consent_decision_recorded')
          execute function ${decisionFunctionName}();
        `),
      );
      await assert.rejects(
        persistence.evaluateAndRecordConsentDecision({
          brokerageId: brokerageA.id,
          partyId: partyA.id,
          channel: "EMAIL",
          purpose: "audit-rollback",
          scope: "one-off",
          jurisdiction: "AU",
        }),
      );
      const [afterDecisionRollback] = await db
        .select({ count: sql<number>`count(*)` })
        .from(growConsentDecisions)
        .where(sql`${growConsentDecisions.brokerageId} = ${brokerageA.id}`);
      assert.equal(Number(afterDecisionRollback.count), 0);
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ${decisionTriggerName} on audit_logs;`));
      await db.execute(sql.raw(`drop function if exists ${decisionFunctionName}();`));
    }

    try {
      await assert.rejects(
        persistence.captureConsentState({
          brokerageId: brokerageA.id,
          partyId: partyB.id,
          channel: "EMAIL",
          state: "NONE",
          source: "tenant-test",
          captureMethod: "test",
          purpose: "outreach",
          scope: "standing",
          recordedByUserId: userA.id,
        }),
        persistence.ConsentControlsNotFoundError,
      );
      const foreign = await persistence.captureConsentState({
        brokerageId: brokerageB.id,
        partyId: partyB.id,
        channel: "EMAIL",
        state: "NONE",
        source: "tenant-test",
        captureMethod: "test",
        purpose: "outreach",
        scope: "standing",
        recordedByUserId: userB.id,
      });
      await assert.rejects(
        persistence.captureConsentState({
          brokerageId: brokerageA.id,
          partyId: partyA.id,
          channel: "EMAIL",
          state: "WITHDRAWN",
          source: "tenant-test",
          captureMethod: "test",
          purpose: "outreach",
          scope: "standing",
          withdrawnAt: new Date(),
          withdrawnByUserId: userA.id,
          withdrawalReason: "test",
          supersedesConsentId: foreign.id,
          recordedByUserId: userA.id,
        }),
        persistence.ConsentControlsNotFoundError,
      );

      const trustedBefore = Date.now();
      const trustedDecision = await persistence.evaluateAndRecordConsentDecision({
        brokerageId: brokerageA.id,
        partyId: partyA.id,
        channel: "EMAIL",
        purpose: "trusted-time",
        scope: "one-off",
        jurisdiction: "AU",
      });
      const trustedAfter = Date.now();
      assert.ok(trustedDecision.decision.evaluatedAt.getTime() >= trustedBefore - 1_000);
      assert.ok(trustedDecision.decision.evaluatedAt.getTime() <= trustedAfter + 1_000);
    } finally {
      await db.delete(growConsentDecisions).where(inArray(growConsentDecisions.brokerageId, [brokerageA.id, brokerageB.id]));
      await db.delete(auditLogs).where(inArray(auditLogs.brokerageId, [brokerageA.id, brokerageB.id]));
      await db.delete(growContactChannelConsents).where(inArray(growContactChannelConsents.brokerageId, [brokerageA.id, brokerageB.id]));
      await db.delete(parties).where(inArray(parties.brokerageId, [brokerageA.id, brokerageB.id]));
      await db.delete(users).where(inArray(users.brokerageId, [brokerageA.id, brokerageB.id]));
      await db.delete(brokerages).where(inArray(brokerages.id, [brokerageA.id, brokerageB.id]));
    }
  },
);