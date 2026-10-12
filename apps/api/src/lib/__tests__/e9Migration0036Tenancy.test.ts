// E-9 migration 0036. Tenant columns, parent match, and party match.
//
// CI applies the migrations to an empty database before this suite. These
// tests do not migrate, and they do not connect to any database other than
// DATABASE_URL. A mismatched brokerage or a cross-tenant party is rejected.
// A same-brokerage row is stored. E-9 stays PARTIAL: this file does not
// apply 0036 outside CI, and it does not close the finding.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  appraisals,
  brokerages,
  communicationParticipants,
  communicationThreads,
  db,
  parties,
  properties,
  users,
} from "@aee/db";
// Operator script is plain JavaScript.
// @ts-expect-error no declaration file for the preflight script
import { e9TenantPreflightDecision, readE9TenantPreflight } from "../../../../../packages/db/scripts/preflight-migrations.mjs";
import { cleanupBrokerages } from "../../routes/__tests__/testSupport.js";

const created: number[] = [];

after(async () => {
  if (created.length > 0) await cleanupBrokerages(created);
});

test("0036 preflight reports row counts and blocks orphans and cross-tenant parties", () => {
  const clear = e9TenantPreflightDecision({
    appraisalsMissing: false,
    participantsMissing: false,
    appraisalRows: 4,
    appraisalOrphans: 0,
    appraisalNullParentBrokerage: 0,
    appraisalPartyConflicts: 0,
    appraisalBrokerageColumnPresent: false,
    appraisalNullBrokerage: 0,
    participantRows: 2,
    participantOrphans: 0,
    participantNullParentBrokerage: 0,
    participantPartyConflicts: 0,
    participantBrokerageColumnPresent: false,
    participantNullBrokerage: 0,
  });
  assert.equal(clear.outcome, "ok");
  assert.deepEqual(clear.lines, ["appraisals rows: 4", "communication_participants rows: 2"]);

  const blocked = e9TenantPreflightDecision({
    appraisalsMissing: false,
    participantsMissing: false,
    appraisalRows: 3,
    appraisalOrphans: 1,
    appraisalNullParentBrokerage: 0,
    appraisalPartyConflicts: 2,
    appraisalBrokerageColumnPresent: true,
    appraisalNullBrokerage: 1,
    participantRows: 1,
    participantOrphans: 0,
    participantNullParentBrokerage: 0,
    participantPartyConflicts: 1,
    participantBrokerageColumnPresent: false,
    participantNullBrokerage: 0,
  });
  assert.equal(blocked.outcome, "fail");
  assert.match(blocked.message, /no property parent: 1/);
  assert.match(blocked.message, /another brokerage: 2/);
  assert.match(blocked.message, /appraisals.brokerage_id is null: 1/);
  assert.match(blocked.message, /communication_participants whose party belongs to another brokerage: 1/);

  const missing = e9TenantPreflightDecision({
    appraisalsMissing: true,
    participantsMissing: true,
    appraisalRows: 0,
    appraisalOrphans: 0,
    appraisalNullParentBrokerage: 0,
    appraisalPartyConflicts: 0,
    appraisalBrokerageColumnPresent: false,
    appraisalNullBrokerage: 0,
    participantRows: 0,
    participantOrphans: 0,
    participantNullParentBrokerage: 0,
    participantPartyConflicts: 0,
    participantBrokerageColumnPresent: false,
    participantNullBrokerage: 0,
  });
  assert.equal(missing.outcome, "skip");
});

test("0036 stores a matching brokerage and rejects a cross-tenant parent or party", async () => {
  const stamp = `${Date.now()}-${process.pid}`;
  const [home] = await db.insert(brokerages).values({ name: `E9 home ${stamp}` }).returning();
  const [other] = await db.insert(brokerages).values({ name: `E9 other ${stamp}` }).returning();
  created.push(home.id, other.id);
  const [homeUser] = await db
    .insert(users)
    .values({
      authProviderId: `e9-home-${stamp}`,
      email: `e9-home-${stamp}@example.test`,
      firstName: "Home",
      lastName: "Agent",
      brokerageId: home.id,
    })
    .returning();
  const [otherUser] = await db
    .insert(users)
    .values({
      authProviderId: `e9-other-${stamp}`,
      email: `e9-other-${stamp}@example.test`,
      firstName: "Other",
      lastName: "Agent",
      brokerageId: other.id,
    })
    .returning();
  const [homeProperty] = await db
    .insert(properties)
    .values({ brokerageId: home.id, agentId: homeUser.id, formattedAddress: `1 Home St ${stamp}` })
    .returning();
  const [otherProperty] = await db
    .insert(properties)
    .values({ brokerageId: other.id, agentId: otherUser.id, formattedAddress: `2 Other St ${stamp}` })
    .returning();
  const [homeParty] = await db
    .insert(parties)
    .values({ brokerageId: home.id, firstName: "Ada", lastName: "Home" })
    .returning();
  const [otherParty] = await db
    .insert(parties)
    .values({ brokerageId: other.id, firstName: "Bea", lastName: "Other" })
    .returning();

  const [appraisal] = await db
    .insert(appraisals)
    .values({
      propertyId: homeProperty.id,
      brokerageId: home.id,
      partyId: homeParty.id,
      status: "DRAFT",
      shareToken: `e9-${stamp}`,
    })
    .returning();
  assert.equal(appraisal.brokerageId, home.id);

  await assert.rejects(
    () =>
      db.insert(appraisals).values({
        propertyId: homeProperty.id,
        brokerageId: other.id,
        status: "DRAFT",
        shareToken: `e9-mismatch-${stamp}`,
      }),
    (err: unknown) => constraintViolation(err, "appraisals_property_brokerage_fk"),
  );
  await assert.rejects(
    () =>
      db.insert(appraisals).values({
        propertyId: otherProperty.id,
        brokerageId: other.id,
        partyId: homeParty.id,
        status: "DRAFT",
        shareToken: `e9-party-${stamp}`,
      }),
    (err: unknown) => constraintViolation(err, "appraisals_party_brokerage_fk"),
  );

  const [homeThread] = await db
    .insert(communicationThreads)
    .values({ brokerageId: home.id, propertyId: homeProperty.id, subject: `Home ${stamp}`, createdByUserId: homeUser.id })
    .returning();
  const [otherThread] = await db
    .insert(communicationThreads)
    .values({ brokerageId: other.id, propertyId: otherProperty.id, subject: `Other ${stamp}`, createdByUserId: otherUser.id })
    .returning();

  const [manual] = await db
    .insert(communicationParticipants)
    .values({
      threadId: homeThread.id,
      brokerageId: home.id,
      partyId: null,
      role: "Other",
      displayName: "Manual",
      email: `manual-${stamp}@example.test`,
      isManualEntry: true,
      manualEntryReason: "typed",
      addedByUserId: homeUser.id,
    })
    .returning();
  assert.equal(manual.brokerageId, home.id);
  assert.equal(manual.partyId, null);

  const [linked] = await db
    .insert(communicationParticipants)
    .values({
      threadId: homeThread.id,
      brokerageId: home.id,
      partyId: homeParty.id,
      role: "Seller",
      displayName: "Ada Home",
      email: `ada-${stamp}@example.test`,
      addedByUserId: homeUser.id,
    })
    .returning();
  assert.equal(linked.partyId, homeParty.id);

  await assert.rejects(
    () =>
      db.insert(communicationParticipants).values({
        threadId: homeThread.id,
        brokerageId: other.id,
        role: "Buyer",
        displayName: "Wrong brokerage",
        isManualEntry: true,
        manualEntryReason: "mismatch",
        addedByUserId: homeUser.id,
      }),
    (err: unknown) => constraintViolation(err, "communication_participants_thread_brokerage_fk"),
  );
  await assert.rejects(
    () =>
      db.insert(communicationParticipants).values({
        threadId: otherThread.id,
        brokerageId: other.id,
        partyId: homeParty.id,
        role: "Seller",
        displayName: "Cross tenant",
        email: `cross-${stamp}@example.test`,
        addedByUserId: otherUser.id,
      }),
    (err: unknown) => constraintViolation(err, "communication_participants_party_brokerage_fk"),
  );

  const [stored] = await db.select().from(appraisals).where(eq(appraisals.id, appraisal.id));
  assert.equal(stored.brokerageId, home.id);
  assert.equal(stored.partyId, homeParty.id);

  const pool = (db as unknown as { $client: { query: (sql: string) => Promise<{ rows: unknown[] }> } }).$client;
  const preflight = e9TenantPreflightDecision(await readE9TenantPreflight(pool));
  assert.equal(preflight.outcome, "ok");
  assert.match(preflight.lines.join("\n"), /appraisals rows: /);
  assert.match(preflight.lines.join("\n"), /communication_participants rows: /);
});

function constraintViolation(err: unknown, constraint: string): boolean {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof Error) parts.push(current.message);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") parts.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  const text = parts.join(" ");
  return text.includes(constraint) || text.includes("23503");
}
