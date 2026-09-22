// AE GROW W1-A (A-4) audit durability.
//
// recordConsent still mutates the legacy communication_consent row in place.
// The mutation and its before/after audit row must commit in one transaction:
// if the audit insert fails, the consent change rolls back and
// COMMUNICATION_CONSENT_UPDATED is not published. A successful commit
// publishes exactly one event, and only after the row and the matching
// audit evidence are visible to a new transaction.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { and, desc, eq, sql } from "drizzle-orm";
import { auditLogs, brokerages, communicationConsent, db, domainEvents, parties, users } from "@aee/db";
import { recordConsent } from "../consent.js";

type InstalledTrigger = { name: string; fn: string; table: "audit_logs" | "domain_events" };

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
});

function safeIdent(value: string): string {
  const ident = value.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) throw new Error(`unsafe SQL identifier: ${value}`);
  return ident;
}

function errorText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && !seen.has(current) && parts.length < 6) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" | ");
}

async function installTrigger(trigger: InstalledTrigger, body: string, when: string): Promise<void> {
  const name = safeIdent(trigger.name);
  const fn = safeIdent(trigger.fn);
  await db.execute(
    sql.raw(`
      create or replace function ${fn}() returns trigger as $body$
      ${body}
      $body$ language plpgsql;
    `),
  );
  await db.execute(
    sql.raw(`
      create trigger ${name}
      before insert on ${trigger.table}
      for each row
      when (${when})
      execute function ${fn}();
    `),
  );
}

async function dropTrigger(trigger: InstalledTrigger): Promise<void> {
  const name = safeIdent(trigger.name);
  const fn = safeIdent(trigger.fn);
  await db.execute(sql.raw(`drop trigger if exists ${name} on ${trigger.table};`));
  await db.execute(sql.raw(`drop function if exists ${fn}();`));
}

async function createFixture(label: string) {
  const suffix = `${Date.now()}_${process.pid}_${label}`;
  const [brokerage] = await db.insert(brokerages).values({ name: `A4 durability ${label} ${suffix}` }).returning();
  const [user] = await db
    .insert(users)
    .values({
      authProviderId: `a4-durability-${suffix}`,
      email: `a4-durability-${suffix}@example.test`,
      firstName: "A4",
      lastName: label,
      brokerageId: brokerage.id,
    })
    .returning();
  const [party] = await db
    .insert(parties)
    .values({ brokerageId: brokerage.id, firstName: "Consent", lastName: label })
    .returning();
  return { suffix, brokerage, user, party };
}

async function cleanupFixture(brokerageId: number | undefined): Promise<void> {
  if (brokerageId == null) return;
  await db.delete(domainEvents).where(eq(domainEvents.brokerageId, brokerageId));
  await db.delete(auditLogs).where(eq(auditLogs.brokerageId, brokerageId));
  await db.delete(communicationConsent).where(eq(communicationConsent.brokerageId, brokerageId));
  await db.delete(parties).where(eq(parties.brokerageId, brokerageId));
  await db.delete(users).where(eq(users.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
}

function consentEvents(brokerageId: number) {
  return db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.brokerageId, brokerageId), eq(domainEvents.eventType, "COMMUNICATION_CONSENT_UPDATED")))
    .orderBy(desc(domainEvents.recordedAt), desc(domainEvents.id));
}

test(
  "A-4 durability: a successful commit publishes exactly one consent-update event after the row and audit evidence exist",
  { concurrency: false },
  async () => {
    const fixture = await createFixture("commit");
    const ordering: InstalledTrigger = {
      name: `a4_consent_event_order_${fixture.suffix}`,
      fn: `a4_consent_event_order_${fixture.suffix}_fn`,
      table: "domain_events",
    };
    const destination = `a4-commit-${fixture.suffix}@example.com`;
    try {
      // The event insert runs on the pool, outside recordConsent's
      // transaction. This BEFORE INSERT trigger therefore sees the consent
      // row and its audit evidence only after that transaction has committed.
      // Publishing from inside the still-open transaction would fail the check.
      await installTrigger(
        ordering,
        `
          declare
            consent_id integer;
            expected_audit text;
          begin
            consent_id := (new.payload->>'consentId')::integer;
            if not exists (
              select 1 from communication_consent
              where id = consent_id
                and brokerage_id = new.brokerage_id
                and party_id is not distinct from new.party_id
            ) then
              raise exception 'consent event published before the committed consent row';
            end if;
            expected_audit := 'marketingOptIn=' || (new.payload->>'marketingOptIn')
              || ',transactionalOptOut=' || (new.payload->>'transactionalOptOut');
            if not exists (
              select 1 from audit_logs
              where brokerage_id = new.brokerage_id
                and action = 'communication_consent_updated'
                and record_type = 'communication_consent'
                and record_id = consent_id::text
                and updated_value = expected_audit
                and previous_value is not null
            ) then
              raise exception 'consent event published before the committed audit evidence';
            end if;
            return new;
          end;
        `,
        `new.event_type = 'COMMUNICATION_CONSENT_UPDATED' and new.brokerage_id = ${fixture.brokerage.id}`,
      );

      const created = await recordConsent({
        brokerageId: fixture.brokerage.id,
        partyId: fixture.party.id,
        channel: "EMAIL",
        destination,
        marketingOptIn: true,
        source: "MANUAL",
        recordedByUserId: fixture.user.id,
        notes: "granted",
      });
      assert.equal(created.partyId, fixture.party.id);
      assert.equal(created.brokerageId, fixture.brokerage.id);
      assert.equal(created.marketingOptIn, true);
      assert.equal(created.transactionalOptOut, false);

      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.recordType, "communication_consent"), eq(auditLogs.recordId, String(created.id))))
        .orderBy(desc(auditLogs.id));
      assert.ok(audit, "the committed consent row must have audit evidence");
      assert.equal(audit.previousValue, "none");
      assert.equal(audit.updatedValue, "marketingOptIn=true,transactionalOptOut=false");
      assert.equal(audit.brokerageId, fixture.brokerage.id);

      const createdEvents = await consentEvents(fixture.brokerage.id);
      assert.equal(createdEvents.length, 1, "a successful commit publishes exactly one COMMUNICATION_CONSENT_UPDATED");
      const createdEvent = createdEvents[0]!;
      assert.equal(createdEvent.partyId, created.partyId);
      assert.equal(createdEvent.brokerageId, fixture.brokerage.id);
      assert.equal(createdEvent.actorType, "USER");
      assert.equal(createdEvent.actorId, fixture.user.id);
      assert.equal(createdEvent.source, "communications:consent:manual");
      const createdPayload = createdEvent.payload as { consentId: number; channel: string; marketingOptIn: boolean; transactionalOptOut: boolean };
      assert.equal(createdPayload.consentId, created.id);
      assert.equal(createdPayload.channel, "EMAIL");
      assert.equal(createdPayload.marketingOptIn, true);
      assert.equal(createdPayload.transactionalOptOut, false);

      // Webhook STOP still withdraws in place, keeps the committed party, and
      // publishes one SYSTEM event only after that update and its audit commit.
      const stopped = await recordConsent({
        brokerageId: fixture.brokerage.id,
        channel: "EMAIL",
        destination,
        marketingOptIn: false,
        transactionalOptOut: true,
        source: "WEBHOOK_REPLY_STOP",
      });
      assert.equal(stopped.id, created.id, "STOP still updates the same legacy row");
      assert.equal(stopped.partyId, fixture.party.id);
      assert.equal(stopped.marketingOptIn, false);
      assert.equal(stopped.transactionalOptOut, true);
      assert.equal(stopped.source, "WEBHOOK_REPLY_STOP");
      assert.equal(stopped.recordedByUserId, null);

      const audits = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.recordType, "communication_consent"), eq(auditLogs.recordId, String(created.id))))
        .orderBy(auditLogs.id);
      assert.equal(audits.length, 2);
      assert.equal(audits[1]!.previousValue, "marketingOptIn=true,transactionalOptOut=false");
      assert.equal(audits[1]!.updatedValue, "marketingOptIn=false,transactionalOptOut=true");
      assert.equal(audits[1]!.previousValue, audits[0]!.updatedValue);

      const stoppedEvents = await consentEvents(fixture.brokerage.id);
      assert.equal(stoppedEvents.length, 2, "the STOP commit publishes exactly one more event");
      const stoppedEvent = stoppedEvents.find((event) => event.source === "communications:consent:webhook_reply_stop");
      assert.ok(stoppedEvent, "the STOP commit publishes the webhook consent event");
      assert.equal(stoppedEvents.filter((event) => event.source === "communications:consent:manual").length, 1);
      assert.equal(stoppedEvent.partyId, stopped.partyId);
      assert.equal(stoppedEvent.brokerageId, fixture.brokerage.id);
      assert.equal(stoppedEvent.actorType, "SYSTEM");
      assert.equal(stoppedEvent.actorId, null);
      assert.equal(stoppedEvent.source, "communications:consent:webhook_reply_stop");
      const stoppedPayload = stoppedEvent.payload as { consentId: number; marketingOptIn: boolean; transactionalOptOut: boolean };
      assert.equal(stoppedPayload.consentId, stopped.id);
      assert.equal(stoppedPayload.marketingOptIn, false);
      assert.equal(stoppedPayload.transactionalOptOut, true);
    } finally {
      await dropTrigger(ordering);
      await cleanupFixture(fixture.brokerage.id);
    }
  },
);

test(
  "A-4 durability: an audit insert failure rolls back the consent mutation and publishes no consent-update event",
  { concurrency: false },
  async () => {
    const fixture = await createFixture("rollback");
    const fault: InstalledTrigger = {
      name: `a4_consent_audit_fault_${fixture.suffix}`,
      fn: `a4_consent_audit_fault_${fixture.suffix}_fn`,
      table: "audit_logs",
    };
    const destination = `a4-rollback-${fixture.suffix}@example.com`;
    const freshDestination = `a4-rollback-new-${fixture.suffix}@example.com`;
    try {
      const created = await recordConsent({
        brokerageId: fixture.brokerage.id,
        partyId: fixture.party.id,
        channel: "EMAIL",
        destination,
        marketingOptIn: true,
        source: "MANUAL",
        recordedByUserId: fixture.user.id,
        notes: "granted",
      });
      const [before] = await db.select().from(communicationConsent).where(eq(communicationConsent.id, created.id));
      assert.ok(before);
      const eventsBefore = await consentEvents(fixture.brokerage.id);
      const auditsBefore = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(and(eq(auditLogs.brokerageId, fixture.brokerage.id), eq(auditLogs.action, "communication_consent_updated")));
      assert.equal(eventsBefore.length, 1);
      assert.equal(auditsBefore.length, 1);

      await installTrigger(
        fault,
        `
          begin
            raise exception 'a4_consent_audit_fault';
          end;
        `,
        `new.action = 'communication_consent_updated' and new.brokerage_id = ${fixture.brokerage.id}`,
      );

      await assert.rejects(
        () =>
          recordConsent({
            brokerageId: fixture.brokerage.id,
            channel: "EMAIL",
            destination,
            marketingOptIn: false,
            transactionalOptOut: true,
            source: "WEBHOOK_REPLY_STOP",
            notes: "should-not-stick",
          }),
        (err: unknown) => {
          assert.match(errorText(err), /a4_consent_audit_fault/);
          return true;
        },
      );

      const [afterUpdate] = await db.select().from(communicationConsent).where(eq(communicationConsent.id, created.id));
      assert.ok(afterUpdate);
      assert.equal(afterUpdate.id, before.id);
      assert.equal(afterUpdate.partyId, before.partyId);
      assert.equal(afterUpdate.marketingOptIn, before.marketingOptIn);
      assert.equal(afterUpdate.transactionalOptOut, before.transactionalOptOut);
      assert.equal(afterUpdate.source, before.source);
      assert.equal(afterUpdate.recordedByUserId, before.recordedByUserId);
      assert.equal(afterUpdate.notes, before.notes);
      assert.equal(new Date(afterUpdate.updatedAt).toISOString(), new Date(before.updatedAt).toISOString());

      await assert.rejects(
        () =>
          recordConsent({
            brokerageId: fixture.brokerage.id,
            partyId: fixture.party.id,
            channel: "EMAIL",
            destination: freshDestination,
            marketingOptIn: true,
            source: "MANUAL",
            recordedByUserId: fixture.user.id,
          }),
        (err: unknown) => {
          assert.match(errorText(err), /a4_consent_audit_fault/);
          return true;
        },
      );

      const freshRows = await db
        .select({ id: communicationConsent.id })
        .from(communicationConsent)
        .where(and(eq(communicationConsent.brokerageId, fixture.brokerage.id), eq(communicationConsent.destination, freshDestination)));
      assert.equal(freshRows.length, 0, "a failed audit insert must not leave a new consent row");

      const eventsAfter = await consentEvents(fixture.brokerage.id);
      const auditsAfter = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(and(eq(auditLogs.brokerageId, fixture.brokerage.id), eq(auditLogs.action, "communication_consent_updated")));
      assert.equal(eventsAfter.length, eventsBefore.length, "a rolled-back consent mutation must not publish COMMUNICATION_CONSENT_UPDATED");
      assert.deepEqual(
        eventsAfter.map((event) => event.id).sort(),
        eventsBefore.map((event) => event.id).sort(),
      );
      assert.equal(auditsAfter.length, auditsBefore.length);
    } finally {
      await dropTrigger(fault);
      await cleanupFixture(fixture.brokerage.id);
    }
  },
);
