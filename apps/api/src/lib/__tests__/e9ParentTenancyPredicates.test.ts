// E-9 read/write hardening. Migration 0036 stores brokerage_id on appraisals
// and communication_participants, copied from the parent property or thread.
// These tests plant the row the other brokerage owns (an appraisal on B's
// property, a participant on B's thread) and call each helper as brokerage A.
// A must get null / not found and must not write. The same helpers still
// read and write A's own rows.
import { createHash, randomBytes } from "node:crypto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { ObjectStorageProvider } from "@aee/integration-object-storage";
import { eq } from "drizzle-orm";
import {
  appraisals,
  communicationMessages,
  communicationParticipants,
  communicationThreads,
  db,
  documents,
  parties,
  properties,
} from "@aee/db";
import { finaliseAppraisal, getAppraisalByProperty, getOrCreateAppraisal, updateAppraisal } from "../appraisals.js";
import {
  AppraisalAccessError,
  createAppraisalFromContact,
  recordAppraisalOutcome,
  scheduleAppraisalFollowUp,
  transitionAppraisalStatus,
  updateAppraisalWorkspace,
} from "../growAppraisals.js";
import { generateAppraisalPresentation } from "../growAppraisalIntegrations.js";
import { setDocumentStorageProviderForTests } from "../documentStorage.js";
import { createDraftMessage, listParticipants } from "../communications/messages.js";
import { assertMessageMayLeave, OutboundConsentRefused } from "../communications/outboundConsent.js";
import { CommunicationTenancyError } from "../communications/types.js";
import { getRelationshipTimeline } from "../relationshipTimeline.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

class MemoryStorage implements ObjectStorageProvider {
  readonly objects = new Map<string, Buffer>();
  async putObject(key: string, content: string | Buffer) {
    this.objects.set(key, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content));
    return { key };
  }
  async getObject(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) {
      const error = new Error(`Missing object ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return Buffer.from(bytes);
  }
  async headObject(key: string) {
    const bytes = await this.getObject(key);
    return { key, size: bytes.length, checksumSha256: createHash("sha256").update(bytes).digest("hex") };
  }
  async deleteObject(key: string) {
    this.objects.delete(key);
  }
  async createSignedDownload(key: string, expiresInSeconds = 300) {
    await this.headObject(key);
    return { url: `memory://${encodeURIComponent(key)}`, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }
  async verifyIntegrity(key: string) {
    const bytes = await this.getObject(key);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    return { valid: true, expectedChecksum: checksum, actualChecksum: checksum };
  }
  async checkReadiness() {
    return { ready: true };
  }
}

let server: Server;
let baseUrl: string;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

before(async () => {
  setDocumentStorageProviderForTests(new MemoryStorage());
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `E9 Parent Tenancy A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `E9 Parent Tenancy B ${suffix}`);
});

after(async () => {
  setDocumentStorageProviderForTests(null);
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function createParty(cookie: string, propertyId: number, overrides: Record<string, unknown> = {}): Promise<number> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Seller", firstName: "Ada", lastName: "Tenant", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

async function insertAppraisal(propertyId: number, patch: Record<string, unknown> = {}) {
  const [property] = await db
    .select({ brokerageId: properties.brokerageId })
    .from(properties)
    .where(eq(properties.id, propertyId));
  if (!property) throw new Error(`property ${propertyId} missing`);
  const [row] = await db
    .insert(appraisals)
    .values({
      propertyId,
      status: "DRAFT",
      priceRangeLow: "410000.00",
      priceRangeHigh: "450000.00",
      pricingCommentary: `foreign commentary ${suffix}`,
      shareToken: randomBytes(16).toString("hex"),
      ...patch,
      brokerageId: property.brokerageId,
    })
    .returning();
  return row;
}

async function reloadAppraisal(id: number) {
  const [row] = await db.select().from(appraisals).where(eq(appraisals.id, id));
  if (!row) throw new Error(`appraisal ${id} missing`);
  return row;
}

function tracked(row: {
  status: string;
  partyId: number | null;
  priceRangeLow: string | null;
  pricingCommentary: string | null;
  isFinalised: boolean;
  followUpAt: Date | null;
  outcome: string | null;
  presentationDocumentId: number | null;
  updatedAt: Date;
}) {
  return {
    status: row.status,
    partyId: row.partyId,
    priceRangeLow: row.priceRangeLow,
    pricingCommentary: row.pricingCommentary,
    isFinalised: row.isFinalised,
    followUpAt: row.followUpAt?.toISOString() ?? null,
    outcome: row.outcome,
    presentationDocumentId: row.presentationDocumentId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

test("brokerage A cannot read or update an appraisal on brokerage B's property", async () => {
  const propertyId = await createProperty(B.agent.cookie, `9 Foreign Appraisal Rd ${suffix}`);
  const partyId = await createParty(A.agent.cookie, await createProperty(A.agent.cookie, `9 Party Anchor St ${suffix}`), {
    firstName: "Ada",
    lastName: `Cross${suffix}`,
  });
  const foreign = await insertAppraisal(propertyId);
  const before = tracked(foreign);
  const docsBefore = await db.select({ id: documents.id }).from(documents).where(eq(documents.propertyId, propertyId));

  assert.equal(await getAppraisalByProperty(propertyId, A.brokerageId), null);

  await assert.rejects(
    () => getOrCreateAppraisal({ propertyId, userId: A.agent.user.id, brokerageId: A.brokerageId }),
    /not found/i,
  );
  await assert.rejects(
    () =>
      updateAppraisal({
        propertyId,
        userId: A.agent.user.id,
        brokerageId: A.brokerageId,
        priceRangeLow: "999999",
      }),
    /not found/i,
  );
  await assert.rejects(
    () => finaliseAppraisal({ propertyId, userId: A.agent.user.id, brokerageId: A.brokerageId }),
    /not found/i,
  );
  await assert.rejects(
    () =>
      createAppraisalFromContact({
        partyId,
        propertyId,
        brokerageId: A.brokerageId,
        userId: A.agent.user.id,
      }),
    /not found/i,
  );
  for (const call of [
    () =>
      updateAppraisalWorkspace({
        appraisalId: foreign.id,
        brokerageId: A.brokerageId,
        userId: A.agent.user.id,
        pricingCommentary: "rewritten by A",
      }),
    () =>
      transitionAppraisalStatus({
        appraisalId: foreign.id,
        brokerageId: A.brokerageId,
        userId: A.agent.user.id,
        toStatus: "PREPARING",
      }),
    () =>
      recordAppraisalOutcome({
        appraisalId: foreign.id,
        brokerageId: A.brokerageId,
        userId: A.agent.user.id,
        outcome: "LOST",
        outcomeReason: "timing_delayed",
      }),
    () =>
      scheduleAppraisalFollowUp({
        appraisalId: foreign.id,
        brokerageId: A.brokerageId,
        userId: A.agent.user.id,
        followUpAt: "2026-12-01T00:00:00.000Z",
        followUpNotes: "from A",
      }),
    () =>
      generateAppraisalPresentation({
        appraisalId: foreign.id,
        brokerageId: A.brokerageId,
        userId: A.agent.user.id,
      }),
  ]) {
    await assert.rejects(call, (err: unknown) => err instanceof AppraisalAccessError && err.message === "Appraisal not found");
  }

  const after = tracked(await reloadAppraisal(foreign.id));
  assert.deepEqual(after, before);
  const siblings = await db.select({ id: appraisals.id }).from(appraisals).where(eq(appraisals.propertyId, propertyId));
  assert.deepEqual(siblings.map((row) => row.id), [foreign.id]);
  const docsAfter = await db.select({ id: documents.id }).from(documents).where(eq(documents.propertyId, propertyId));
  assert.deepEqual(docsAfter, docsBefore);
});

test("brokerage A still reads and updates an appraisal on its own property", async () => {
  const propertyId = await createProperty(A.agent.cookie, `4 Own Appraisal St ${suffix}`);
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Nia", lastName: `Own${suffix}` });

  const created = await createAppraisalFromContact({
    partyId,
    propertyId,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
  });
  assert.equal(created.partyId, partyId);
  assert.equal(created.propertyId, propertyId);

  const loaded = await getAppraisalByProperty(propertyId, A.brokerageId);
  assert.equal(loaded?.id, created.id);
  assert.equal(await getAppraisalByProperty(propertyId, B.brokerageId), null);

  const again = await getOrCreateAppraisal({ propertyId, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.equal(again.created, false);
  assert.equal(again.appraisal.id, created.id);

  const priced = await updateAppraisal({
    propertyId,
    userId: A.agent.user.id,
    brokerageId: A.brokerageId,
    priceRangeLow: "500000",
    priceRangeHigh: "540000",
  });
  assert.equal(priced.priceRangeLow, "500000.00");
  assert.equal(priced.priceRangeHigh, "540000.00");

  const workspace = await updateAppraisalWorkspace({
    appraisalId: created.id,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
    pricingCommentary: `own commentary ${suffix}`,
  });
  assert.equal(workspace.pricingCommentary, `own commentary ${suffix}`);

  const presentation = await generateAppraisalPresentation({
    appraisalId: created.id,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
  });
  const withDocument = await reloadAppraisal(created.id);
  assert.equal(withDocument.presentationDocumentId, presentation.documentId);

  const preparing = await transitionAppraisalStatus({
    appraisalId: created.id,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
    toStatus: "PREPARING",
  });
  assert.equal(preparing.status, "PREPARING");

  const followedUp = await scheduleAppraisalFollowUp({
    appraisalId: created.id,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
    followUpAt: "2026-12-01T00:00:00.000Z",
    followUpNotes: "call back",
  });
  assert.ok(followedUp.followUpAt);
  assert.equal(followedUp.followUpNotes, "call back");

  await transitionAppraisalStatus({
    appraisalId: created.id,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
    toStatus: "APPOINTMENT_SCHEDULED",
  });
  await transitionAppraisalStatus({
    appraisalId: created.id,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
    toStatus: "PRESENTED",
  });
  const lost = await recordAppraisalOutcome({
    appraisalId: created.id,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
    outcome: "LOST",
    outcomeReason: "timing_delayed",
  });
  assert.equal(lost.status, "LOST");
  assert.equal(lost.outcome, "LOST");

  const finalised = await finaliseAppraisal({ propertyId, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.equal(finalised.isFinalised, true);
  assert.equal(finalised.id, created.id);
});

test("brokerage A cannot read a participant on brokerage B's thread, and its own participant still resolves", async () => {
  const ownPropertyId = await createProperty(A.agent.cookie, `8 Own Thread St ${suffix}`);
  const foreignPropertyId = await createProperty(B.agent.cookie, `8 Foreign Thread St ${suffix}`);
  const partyId = await createParty(A.agent.cookie, ownPropertyId, { firstName: "Cara", lastName: `Participant${suffix}` });
  const ownEmail = `own-participant-${suffix}@example.com`;
  const foreignEmail = `foreign-participant-${suffix}@example.com`;
  const foreignName = `Foreign Participant ${suffix}`;
  const ownSubject = `Own thread subject ${suffix}`;
  const foreignSubject = `Foreign thread subject ${suffix}`;

  const [ownThread] = await db
    .insert(communicationThreads)
    .values({
      brokerageId: A.brokerageId,
      propertyId: ownPropertyId,
      subject: "Own thread",
      createdByUserId: A.agent.user.id,
    })
    .returning();
  const [foreignThread] = await db
    .insert(communicationThreads)
    .values({
      brokerageId: B.brokerageId,
      propertyId: foreignPropertyId,
      subject: "Foreign thread",
      createdByUserId: B.agent.user.id,
    })
    .returning();
  const [foreignParty] = await db
    .insert(parties)
    .values({
      brokerageId: B.brokerageId,
      partyType: "Person",
      firstName: "Bea",
      lastName: `Foreign${suffix}`,
    })
    .returning();
  const [ownManual] = await db
    .insert(communicationParticipants)
    .values({
      threadId: ownThread.id,
      brokerageId: ownThread.brokerageId,
      partyId: null,
      role: "Other",
      displayName: `Own Manual ${suffix}`,
      email: ownEmail,
      isManualEntry: true,
      manualEntryReason: "typed at the desk",
      addedByUserId: A.agent.user.id,
    })
    .returning();
  const [ownPartyParticipant] = await db
    .insert(communicationParticipants)
    .values({
      threadId: ownThread.id,
      brokerageId: ownThread.brokerageId,
      partyId,
      role: "Seller",
      displayName: `Own Party ${suffix}`,
      email: `own-party-${suffix}@example.com`,
      addedByUserId: A.agent.user.id,
    })
    .returning();
  const [foreignParticipant] = await db
    .insert(communicationParticipants)
    .values({
      threadId: foreignThread.id,
      brokerageId: foreignThread.brokerageId,
      partyId: foreignParty.id,
      role: "Seller",
      displayName: foreignName,
      email: foreignEmail,
      mobile: `+61400${suffix.replace(/\D/g, "").slice(-6)}`,
      addedByUserId: B.agent.user.id,
    })
    .returning();

  await assert.rejects(
    () => listParticipants(foreignThread.id, A.brokerageId),
    (err: unknown) => err instanceof CommunicationTenancyError,
  );
  const ownListed = await listParticipants(ownThread.id, A.brokerageId);
  assert.ok(ownListed.some((row) => row.id === ownManual.id && row.email === ownEmail));
  assert.equal(ownListed.some((row) => row.email === foreignEmail || row.displayName === foreignName), false);
  const foreignListed = await listParticipants(foreignThread.id, B.brokerageId);
  assert.ok(foreignListed.some((row) => row.id === foreignParticipant.id && row.email === foreignEmail));

  await assert.rejects(
    () =>
      createDraftMessage({
        threadId: ownThread.id,
        brokerageId: A.brokerageId,
        channel: "EMAIL",
        classification: "TRANSACTIONAL",
        bodyText: "should not copy the foreign participant",
        recipientParticipantId: foreignParticipant.id,
        senderUserId: A.agent.user.id,
        createdByUserId: A.agent.user.id,
      }),
    (err: unknown) => err instanceof CommunicationTenancyError,
  );
  const leaked = await db
    .select({ id: communicationMessages.id })
    .from(communicationMessages)
    .where(eq(communicationMessages.recipientDestination, foreignEmail));
  assert.equal(leaked.length, 0);

  const draft = await createDraftMessage({
    threadId: ownThread.id,
    brokerageId: A.brokerageId,
    channel: "EMAIL",
    classification: "TRANSACTIONAL",
    bodyText: "in tenant draft",
    recipientParticipantId: ownManual.id,
    senderUserId: A.agent.user.id,
    createdByUserId: A.agent.user.id,
  });
  assert.equal(draft.recipientDestination, ownEmail);
  assert.equal(draft.recipientDisplayName, ownManual.displayName);
  assert.equal(draft.brokerageId, A.brokerageId);

  const [consentMessage] = await db
    .insert(communicationMessages)
    .values({
      threadId: ownThread.id,
      brokerageId: A.brokerageId,
      propertyId: ownPropertyId,
      partyId: null,
      direction: "OUTBOUND",
      channel: "EMAIL",
      classification: "TRANSACTIONAL",
      status: "DRAFT",
      bodyText: "consent gate",
      recipientParticipantId: ownManual.id,
      recipientDestination: ownEmail,
      recipientDisplayName: ownManual.displayName,
      senderUserId: A.agent.user.id,
      createdByUserId: A.agent.user.id,
    })
    .returning();
  await assertMessageMayLeave(consentMessage, A.agent.user.id);
  await assert.rejects(
    () => assertMessageMayLeave({ ...consentMessage, recipientParticipantId: foreignParticipant.id }, A.agent.user.id),
    (err: unknown) => err instanceof CommunicationTenancyError,
  );
  await assert.rejects(
    () =>
      assertMessageMayLeave(
        { ...consentMessage, threadId: foreignThread.id, recipientParticipantId: foreignParticipant.id },
        A.agent.user.id,
      ),
    (err: unknown) => err instanceof CommunicationTenancyError,
  );
  await assert.rejects(
    () => assertMessageMayLeave({ ...consentMessage, recipientParticipantId: ownPartyParticipant.id }, A.agent.user.id),
    (err: unknown) => err instanceof OutboundConsentRefused && err.code === "CONSENT_REQUIRED",
  );

  await db.insert(communicationMessages).values({
    threadId: ownThread.id,
    brokerageId: A.brokerageId,
    propertyId: ownPropertyId,
    partyId: null,
    direction: "OUTBOUND",
    channel: "EMAIL",
    classification: "TRANSACTIONAL",
    status: "SENT",
    subject: ownSubject,
    bodyText: "sent to own participant",
    recipientParticipantId: ownPartyParticipant.id,
    recipientDisplayName: ownPartyParticipant.displayName,
    sentAt: new Date("2026-10-02T00:00:00.000Z"),
    senderUserId: A.agent.user.id,
    createdByUserId: A.agent.user.id,
  });
  await db.insert(communicationMessages).values({
    threadId: foreignThread.id,
    brokerageId: B.brokerageId,
    propertyId: foreignPropertyId,
    partyId,
    direction: "OUTBOUND",
    channel: "EMAIL",
    classification: "TRANSACTIONAL",
    status: "SENT",
    subject: foreignSubject,
    bodyText: "sent on the foreign thread",
    recipientParticipantId: foreignParticipant.id,
    recipientDisplayName: foreignName,
    recipientDestination: foreignEmail,
    sentAt: new Date("2026-10-03T00:00:00.000Z"),
    senderUserId: B.agent.user.id,
    createdByUserId: B.agent.user.id,
  });

  const timeline = await getRelationshipTimeline(A.brokerageId, partyId);
  const text = JSON.stringify(timeline);
  assert.equal(text.includes(ownSubject), true);
  assert.equal(text.includes(foreignSubject), false);
  assert.equal(text.includes(foreignEmail), false);
  assert.equal(text.includes(foreignName), false);
});
