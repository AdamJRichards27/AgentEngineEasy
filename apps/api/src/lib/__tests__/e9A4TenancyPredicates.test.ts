// E-9 A4. Child tables with no brokerage_id, and parent lookups that used to
// load by id and compare brokerage in JavaScript, now carry the tenant
// predicate in SQL. A cross-brokerage id returns nothing or the same
// not-found error the route maps to 404. The caller's own rows still read
// and write.
import { createHash } from "node:crypto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { ObjectStorageProvider } from "@aee/integration-object-storage";
import { and, eq } from "drizzle-orm";
import {
  appraisalComparableSales,
  appraisalMarketCompetition,
  communicationMessages,
  communicationParticipants,
  communicationTemplates,
  communicationThreads,
  db,
  growOpportunities,
  growOpportunitySignals,
  parties,
  propertyExternalIdentifiers,
  propertyProviderObservations,
} from "@aee/db";
import { finaliseAppraisal, getOrCreateAppraisal, updateAppraisal } from "../appraisals.js";
import { AppraisalAccessError, createAppraisalFromContact, createAppraisalFromOpportunity, getAppraisalWorkspace } from "../growAppraisals.js";
import {
  addComparableSale,
  addMarketCompetitionItem,
  deleteComparableSale,
  deleteMarketCompetitionItem,
  generateAppraisalPresentation,
  generateMarketPositionDraft,
  sendAppraisal,
  updateComparableSale,
  updateMarketCompetitionItem,
} from "../growAppraisalIntegrations.js";
import { setDocumentStorageProviderForTests } from "../documentStorage.js";
import {
  addManualParticipant,
  addParticipantFromParty,
  listRecipientCandidatesForProperty,
} from "../communications/recipientResolution.js";
import {
  applyMessageTransition,
  dispatchMessage,
  evaluateAndDispatchQueuedMessage,
  queueMessage,
} from "../communications/outbox.js";
import {
  createDraftMessage,
  createThread,
  getMessage,
  getThread,
  listMessagesForThread,
  listThreadsForParty,
  listThreadsForProperty,
} from "../communications/messages.js";
import { activateTemplate, archiveTemplate, createTemplateVersion } from "../communications/templates.js";
import { processInboundWebhook } from "../communications/webhooks.js";
import { CommunicationTenancyError } from "../communications/types.js";
import { getRelationshipTimeline } from "../relationshipTimeline.js";
import { confirmMatch, proposeMatch, rejectMatch } from "../propertyIntelligence/matches.js";
import { recordObservation } from "../propertyIntelligence/observations.js";
import { dismissSignal, promoteSignal, reviewSignal } from "../propertyIntelligence/signals.js";
import { PropertyIntelligenceAccessError } from "../propertyIntelligence/observations.js";
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

const storage = new MemoryStorage();
let server: Server;
let baseUrl: string;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

before(async () => {
  setDocumentStorageProviderForTests(storage);
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `E9 A4 Tenancy A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `E9 A4 Tenancy B ${suffix}`);
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

async function createParty(cookie: string, propertyId: number, firstName: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Seller", firstName, lastName: `A4${suffix}` }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

function tenancy(err: unknown): boolean {
  return err instanceof CommunicationTenancyError && err.message === "Not found.";
}

test("property-by-id appraisal reads reject a foreign property and still finalise an own one", async () => {
  const foreignPropertyId = await createProperty(B.agent.cookie, `A4 Foreign Property Rd ${suffix}`);
  await assert.rejects(
    () => getOrCreateAppraisal({ propertyId: foreignPropertyId, userId: A.agent.user.id, brokerageId: A.brokerageId }),
    /not found/i,
  );
  await assert.rejects(
    () => finaliseAppraisal({ propertyId: foreignPropertyId, userId: A.agent.user.id, brokerageId: A.brokerageId }),
    /not found/i,
  );

  const propertyId = await createProperty(A.agent.cookie, `A4 Own Property St ${suffix}`);
  const created = await getOrCreateAppraisal({ propertyId, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.equal(created.created, true);
  await updateAppraisal({
    propertyId,
    userId: A.agent.user.id,
    brokerageId: A.brokerageId,
    priceRangeLow: "410000",
    priceRangeHigh: "450000",
  });
  const finalised = await finaliseAppraisal({ propertyId, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.equal(finalised.isFinalised, true);
  assert.equal(finalised.propertyId, propertyId);
});

test("workspace child rows stay inside the caller brokerage", async () => {
  const propertyA = await createProperty(A.agent.cookie, `A4 Workspace St ${suffix}`);
  const partyA = await createParty(A.agent.cookie, propertyA, "Nia");
  const appraisalA = await createAppraisalFromContact({
    partyId: partyA,
    propertyId: propertyA,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
  });
  const sale = await addComparableSale(appraisalA.id, A.brokerageId, { address: `Own sale ${suffix}`, displayOrder: 1 });
  const competition = await addMarketCompetitionItem(appraisalA.id, A.brokerageId, {
    address: `Own competition ${suffix}`,
    displayOrder: 1,
  });

  const propertyB = await createProperty(B.agent.cookie, `A4 Foreign Workspace Rd ${suffix}`);
  const partyB = await createParty(B.agent.cookie, propertyB, "Bea");
  const appraisalB = await createAppraisalFromContact({
    partyId: partyB,
    propertyId: propertyB,
    brokerageId: B.brokerageId,
    userId: B.agent.user.id,
  });
  const foreignSale = await addComparableSale(appraisalB.id, B.brokerageId, { address: `Foreign sale ${suffix}`, displayOrder: 1 });
  const foreignCompetition = await addMarketCompetitionItem(appraisalB.id, B.brokerageId, {
    address: `Foreign competition ${suffix}`,
    displayOrder: 1,
  });

  const workspace = await getAppraisalWorkspace(appraisalA.id, A.brokerageId);
  assert.deepEqual(workspace.comparableSales.map((row) => row.id), [sale.id]);
  assert.deepEqual(workspace.marketCompetition.map((row) => row.id), [competition.id]);
  assert.equal(workspace.comparableSales[0]?.address, `Own sale ${suffix}`);

  await assert.rejects(
    () => getAppraisalWorkspace(appraisalB.id, A.brokerageId),
    (err: unknown) => err instanceof AppraisalAccessError && err.message === "Appraisal not found",
  );

  const updated = await updateComparableSale(appraisalA.id, A.brokerageId, sale.id, { address: `Own sale edited ${suffix}` });
  assert.equal(updated.address, `Own sale edited ${suffix}`);
  await assert.rejects(
    () => updateComparableSale(appraisalA.id, A.brokerageId, foreignSale.id, { address: "stolen" }),
    (err: unknown) => err instanceof AppraisalAccessError && err.message === "Comparable sale not found.",
  );
  await assert.rejects(
    () => updateComparableSale(appraisalB.id, A.brokerageId, foreignSale.id, { address: "stolen" }),
    (err: unknown) => err instanceof AppraisalAccessError && err.message === "Appraisal not found",
  );
  const [foreignSaleAfter] = await db.select().from(appraisalComparableSales).where(eq(appraisalComparableSales.id, foreignSale.id));
  assert.equal(foreignSaleAfter?.address, `Foreign sale ${suffix}`);

  const updatedCompetition = await updateMarketCompetitionItem(appraisalA.id, A.brokerageId, competition.id, {
    address: `Own competition edited ${suffix}`,
  });
  assert.equal(updatedCompetition.address, `Own competition edited ${suffix}`);
  await assert.rejects(
    () => updateMarketCompetitionItem(appraisalA.id, A.brokerageId, foreignCompetition.id, { address: "stolen" }),
    (err: unknown) => err instanceof AppraisalAccessError && err.message === "Market competition entry not found.",
  );
  await assert.rejects(
    () => updateMarketCompetitionItem(appraisalB.id, A.brokerageId, foreignCompetition.id, { address: "stolen" }),
    (err: unknown) => err instanceof AppraisalAccessError && err.message === "Appraisal not found",
  );
  const [foreignCompetitionAfter] = await db
    .select()
    .from(appraisalMarketCompetition)
    .where(eq(appraisalMarketCompetition.id, foreignCompetition.id));
  assert.equal(foreignCompetitionAfter?.address, `Foreign competition ${suffix}`);

  await deleteComparableSale(appraisalA.id, A.brokerageId, foreignSale.id);
  await deleteComparableSale(appraisalB.id, A.brokerageId, foreignSale.id).then(
    () => assert.fail("foreign appraisal delete should 404"),
    (err: unknown) => assert.ok(err instanceof AppraisalAccessError && err.message === "Appraisal not found"),
  );
  await deleteMarketCompetitionItem(appraisalA.id, A.brokerageId, foreignCompetition.id);
  await deleteMarketCompetitionItem(appraisalB.id, A.brokerageId, foreignCompetition.id).then(
    () => assert.fail("foreign appraisal delete should 404"),
    (err: unknown) => assert.ok(err instanceof AppraisalAccessError && err.message === "Appraisal not found"),
  );
  const [saleStill] = await db.select().from(appraisalComparableSales).where(eq(appraisalComparableSales.id, foreignSale.id));
  const [competitionStill] = await db
    .select()
    .from(appraisalMarketCompetition)
    .where(eq(appraisalMarketCompetition.id, foreignCompetition.id));
  assert.equal(saleStill?.address, `Foreign sale ${suffix}`);
  assert.equal(competitionStill?.address, `Foreign competition ${suffix}`);

  await deleteComparableSale(appraisalA.id, A.brokerageId, sale.id);
  await deleteMarketCompetitionItem(appraisalA.id, A.brokerageId, competition.id);
  const afterDelete = await getAppraisalWorkspace(appraisalA.id, A.brokerageId);
  assert.deepEqual(afterDelete.comparableSales, []);
  assert.deepEqual(afterDelete.marketCompetition, []);
});

test("contact and opportunity lookups reject a foreign id and still link an own one", async () => {
  const propertyB = await createProperty(B.agent.cookie, `A4 Opp Property B ${suffix}`);
  const partyB = await createParty(B.agent.cookie, propertyB, "Bea");
  const propertyA = await createProperty(A.agent.cookie, `A4 Opp Property A ${suffix}`);
  await assert.rejects(
    () =>
      createAppraisalFromContact({
        partyId: partyB,
        propertyId: propertyA,
        brokerageId: A.brokerageId,
        userId: A.agent.user.id,
      }),
    (err: unknown) => err instanceof AppraisalAccessError && err.message === "Contact not found",
  );

  const partyA = await createParty(A.agent.cookie, propertyA, "Nia");
  const [opportunityB] = await db
    .insert(growOpportunities)
    .values({
      brokerageId: B.brokerageId,
      partyId: partyB,
      propertyId: propertyB,
      opportunityType: "Listing",
      status: "Open",
      stage: "New",
      source: "manual",
      reason: `foreign opportunity ${suffix}`,
    })
    .returning();
  await assert.rejects(
    () =>
      createAppraisalFromOpportunity({
        opportunityId: opportunityB.id,
        brokerageId: A.brokerageId,
        userId: A.agent.user.id,
      }),
    (err: unknown) => err instanceof AppraisalAccessError && err.message === "Opportunity not found",
  );
  const [opportunityBAfter] = await db.select().from(growOpportunities).where(eq(growOpportunities.id, opportunityB.id));
  assert.equal(opportunityBAfter?.stage, "New");
  assert.equal(opportunityBAfter?.convertedAppraisalId, null);

  const [opportunityA] = await db
    .insert(growOpportunities)
    .values({
      brokerageId: A.brokerageId,
      partyId: partyA,
      propertyId: propertyA,
      opportunityType: "Listing",
      status: "Open",
      stage: "New",
      source: "manual",
      reason: `own opportunity ${suffix}`,
    })
    .returning();
  const appraisal = await createAppraisalFromOpportunity({
    opportunityId: opportunityA.id,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
  });
  assert.equal(appraisal.partyId, partyA);
  assert.equal(appraisal.opportunityId, opportunityA.id);
  const [opportunityAAfter] = await db.select().from(growOpportunities).where(eq(growOpportunities.id, opportunityA.id));
  assert.equal(opportunityAAfter?.stage, "AppraisalBooked");
  assert.equal(opportunityAAfter?.convertedAppraisalId, appraisal.id);
});

test("presentation property lookup keeps the own address and 404s a foreign appraisal", async () => {
  const propertyA = await createProperty(A.agent.cookie, `A4 Presentation St ${suffix}`);
  const partyA = await createParty(A.agent.cookie, propertyA, "Nia");
  const appraisalA = await createAppraisalFromContact({
    partyId: partyA,
    propertyId: propertyA,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
  });
  const beforeKeys = new Set(storage.objects.keys());
  const presentation = await generateAppraisalPresentation({
    appraisalId: appraisalA.id,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
  });
  assert.ok(presentation.documentId > 0);
  const texts = [...storage.objects.entries()]
    .filter(([key]) => !beforeKeys.has(key))
    .map(([, bytes]) => bytes.toString("utf8"));
  assert.ok(texts.some((text) => text.includes(`A4 Presentation St ${suffix}`)));

  const propertyB = await createProperty(B.agent.cookie, `A4 Foreign Presentation Rd ${suffix}`);
  const partyB = await createParty(B.agent.cookie, propertyB, "Bea");
  const appraisalB = await createAppraisalFromContact({
    partyId: partyB,
    propertyId: propertyB,
    brokerageId: B.brokerageId,
    userId: B.agent.user.id,
  });
  await assert.rejects(
    () => generateAppraisalPresentation({ appraisalId: appraisalB.id, brokerageId: A.brokerageId, userId: A.agent.user.id }),
    (err: unknown) => err instanceof AppraisalAccessError && err.message === "Appraisal not found",
  );
  await assert.rejects(
    () =>
      generateMarketPositionDraft({
        appraisalId: appraisalB.id,
        brokerageId: A.brokerageId,
        userId: A.agent.user.id,
        userRole: "Agent",
      }),
    (err: unknown) => err instanceof AppraisalAccessError && err.message === "Appraisal not found",
  );
  await assert.rejects(
    () => sendAppraisal({ appraisalId: appraisalB.id, brokerageId: A.brokerageId, userId: A.agent.user.id }),
    (err: unknown) => err instanceof AppraisalAccessError && err.message === "Appraisal not found",
  );
});

test("recipient resolution rejects foreign property, thread, and party ids", async () => {
  const propertyA = await createProperty(A.agent.cookie, `A4 Recipients St ${suffix}`);
  const partyA = await createParty(A.agent.cookie, propertyA, "Nia");
  const propertyB = await createProperty(B.agent.cookie, `A4 Recipients Rd ${suffix}`);
  const partyB = await createParty(B.agent.cookie, propertyB, "Bea");

  await assert.rejects(() => listRecipientCandidatesForProperty(propertyB, A.brokerageId), tenancy);
  const candidates = await listRecipientCandidatesForProperty(propertyA, A.brokerageId);
  assert.ok(candidates.some((candidate) => candidate.partyId === partyA && candidate.displayName.includes("Nia")));
  assert.equal(candidates.some((candidate) => candidate.partyId === partyB), false);

  const threadA = await createThread({
    brokerageId: A.brokerageId,
    propertyId: propertyA,
    partyId: partyA,
    subject: `A4 thread ${suffix}`,
    createdByUserId: A.agent.user.id,
  });
  const threadB = await createThread({
    brokerageId: B.brokerageId,
    propertyId: propertyB,
    partyId: partyB,
    subject: `A4 foreign thread ${suffix}`,
    createdByUserId: B.agent.user.id,
  });

  await assert.rejects(
    () =>
      addParticipantFromParty({
        threadId: threadB.id,
        brokerageId: A.brokerageId,
        partyId: partyA,
        role: "Client",
        addedByUserId: A.agent.user.id,
      }),
    tenancy,
  );
  await assert.rejects(
    () =>
      addParticipantFromParty({
        threadId: threadA.id,
        brokerageId: A.brokerageId,
        partyId: partyB,
        role: "Client",
        addedByUserId: A.agent.user.id,
      }),
    tenancy,
  );
  const added = await addParticipantFromParty({
    threadId: threadA.id,
    brokerageId: A.brokerageId,
    partyId: partyA,
    role: "Client",
    addedByUserId: A.agent.user.id,
  });
  assert.equal(added.threadId, threadA.id);
  assert.equal(added.partyId, partyA);
  const participants = await db
    .select()
    .from(communicationParticipants)
    .where(eq(communicationParticipants.threadId, threadB.id));
  assert.equal(participants.length, 0);

  await assert.rejects(
    () =>
      addManualParticipant({
        threadId: threadB.id,
        brokerageId: A.brokerageId,
        displayName: "Stolen",
        role: "Supplier",
        email: `stolen-${suffix}@example.com`,
        reason: "should not attach",
        addedByUserId: A.agent.user.id,
      }),
    tenancy,
  );
  const manual = await addManualParticipant({
    threadId: threadA.id,
    brokerageId: A.brokerageId,
    displayName: `Manual ${suffix}`,
    role: "Supplier",
    email: `manual-${suffix}@example.com`,
    reason: "supplier not on the file",
    addedByUserId: A.agent.user.id,
  });
  assert.equal(manual.displayName, `Manual ${suffix}`);
  assert.equal(manual.threadId, threadA.id);
});

test("thread and message lookups reject a foreign id and hide a mismatched brokerage stamp", async () => {
  const propertyA = await createProperty(A.agent.cookie, `A4 Messages St ${suffix}`);
  const partyA = await createParty(A.agent.cookie, propertyA, "Nia");
  const propertyB = await createProperty(B.agent.cookie, `A4 Messages Rd ${suffix}`);
  const partyB = await createParty(B.agent.cookie, propertyB, "Bea");

  await assert.rejects(
    () =>
      createThread({
        brokerageId: A.brokerageId,
        propertyId: propertyB,
        subject: "nope",
        createdByUserId: A.agent.user.id,
      }),
    tenancy,
  );
  await assert.rejects(
    () =>
      createThread({
        brokerageId: A.brokerageId,
        partyId: partyB,
        subject: "nope",
        createdByUserId: A.agent.user.id,
      }),
    tenancy,
  );

  const threadA = await createThread({
    brokerageId: A.brokerageId,
    propertyId: propertyA,
    partyId: partyA,
    subject: `A4 messages ${suffix}`,
    createdByUserId: A.agent.user.id,
  });
  const threadB = await createThread({
    brokerageId: B.brokerageId,
    propertyId: propertyB,
    partyId: partyB,
    subject: `A4 foreign messages ${suffix}`,
    createdByUserId: B.agent.user.id,
  });
  await assert.rejects(() => getThread(threadB.id, A.brokerageId), tenancy);
  const loaded = await getThread(threadA.id, A.brokerageId);
  assert.equal(loaded.subject, `A4 messages ${suffix}`);

  const [stampedOnAProperty] = await db
    .insert(communicationThreads)
    .values({
      brokerageId: B.brokerageId,
      propertyId: propertyA,
      subject: `stamped foreign ${suffix}`,
      createdByUserId: B.agent.user.id,
    })
    .returning();
  const propertyThreads = await listThreadsForProperty(propertyA, A.brokerageId);
  assert.ok(propertyThreads.some((thread) => thread.id === threadA.id));
  assert.equal(propertyThreads.some((thread) => thread.id === stampedOnAProperty.id), false);
  await assert.rejects(() => listThreadsForProperty(propertyB, A.brokerageId), tenancy);

  const [stampedOnAParty] = await db
    .insert(communicationThreads)
    .values({
      brokerageId: B.brokerageId,
      partyId: partyA,
      subject: `stamped party ${suffix}`,
      createdByUserId: B.agent.user.id,
    })
    .returning();
  const partyThreads = await listThreadsForParty(partyA, A.brokerageId);
  assert.ok(partyThreads.some((thread) => thread.id === threadA.id));
  assert.equal(partyThreads.some((thread) => thread.id === stampedOnAParty.id), false);
  await assert.rejects(() => listThreadsForParty(partyB, A.brokerageId), tenancy);

  const draft = await createDraftMessage({
    threadId: threadA.id,
    brokerageId: A.brokerageId,
    channel: "EMAIL",
    classification: "TRANSACTIONAL",
    bodyText: `own draft ${suffix}`,
    senderUserId: A.agent.user.id,
    recipientDisplayName: "Nia",
    recipientDestination: `nia-${suffix}@example.com`,
    createdByUserId: A.agent.user.id,
  });
  const [foreignDraft] = await db
    .insert(communicationMessages)
    .values({
      threadId: threadB.id,
      brokerageId: B.brokerageId,
      propertyId: propertyB,
      direction: "OUTBOUND",
      channel: "EMAIL",
      classification: "TRANSACTIONAL",
      bodyText: `foreign draft ${suffix}`,
      senderUserId: B.agent.user.id,
      createdByUserId: B.agent.user.id,
    })
    .returning();
  await assert.rejects(() => getMessage(foreignDraft.id, A.brokerageId), tenancy);
  const ownMessage = await getMessage(draft.id, A.brokerageId);
  assert.equal(ownMessage.bodyText, `own draft ${suffix}`);

  const [stampedMessage] = await db
    .insert(communicationMessages)
    .values({
      threadId: threadA.id,
      brokerageId: B.brokerageId,
      propertyId: propertyA,
      direction: "OUTBOUND",
      channel: "EMAIL",
      classification: "TRANSACTIONAL",
      bodyText: `stamped message ${suffix}`,
      createdByUserId: B.agent.user.id,
    })
    .returning();
  const messages = await listMessagesForThread(threadA.id, A.brokerageId);
  assert.ok(messages.some((message) => message.id === draft.id));
  assert.equal(messages.some((message) => message.id === stampedMessage.id), false);
  await assert.rejects(() => listMessagesForThread(threadB.id, A.brokerageId), tenancy);

  await assert.rejects(
    () => applyMessageTransition({
      messageId: foreignDraft.id,
      brokerageId: A.brokerageId,
      toStatus: "AWAITING_APPROVAL",
      expectedVersion: foreignDraft.version,
      actorUserId: A.agent.user.id,
      auditAction: "communication_message_awaiting_approval",
    }),
    tenancy,
  );
  const transitioned = await applyMessageTransition({
    messageId: draft.id,
    brokerageId: A.brokerageId,
    toStatus: "AWAITING_APPROVAL",
    expectedVersion: draft.version,
    actorUserId: A.agent.user.id,
    auditAction: "communication_message_awaiting_approval",
  });
  assert.equal(transitioned.status, "AWAITING_APPROVAL");

  await assert.rejects(() => queueMessage(foreignDraft.id, A.brokerageId, A.agent.user.id, foreignDraft.version), tenancy);
  await assert.rejects(() => dispatchMessage(foreignDraft.id, A.brokerageId), tenancy);
  await assert.rejects(() => evaluateAndDispatchQueuedMessage(foreignDraft.id, A.brokerageId, A.agent.user.id), tenancy);
  await assert.rejects(
    () => dispatchMessage(draft.id, A.brokerageId),
    /QUEUED or RETRY_SCHEDULED/,
  );

  const [systemTemplate] = await db
    .insert(communicationTemplates)
    .values({
      brokerageId: null,
      templateKey: `a4-system-${suffix}`,
      name: "System",
      channel: "EMAIL",
      classification: "TRANSACTIONAL",
      category: "GENERAL",
      bodyText: `system body ${suffix}`,
      placeholders: [],
    })
    .returning();
  const [foreignTemplate] = await db
    .insert(communicationTemplates)
    .values({
      brokerageId: B.brokerageId,
      templateKey: `a4-foreign-${suffix}`,
      name: "Foreign",
      channel: "EMAIL",
      classification: "TRANSACTIONAL",
      category: "GENERAL",
      bodyText: `foreign body ${suffix}`,
      placeholders: [],
    })
    .returning();
  const fromSystem = await createDraftMessage({
    threadId: threadA.id,
    brokerageId: A.brokerageId,
    channel: "EMAIL",
    classification: "TRANSACTIONAL",
    templateId: systemTemplate.id,
    senderUserId: A.agent.user.id,
    recipientDisplayName: "Nia",
    recipientDestination: `nia-${suffix}@example.com`,
    createdByUserId: A.agent.user.id,
  });
  assert.equal(fromSystem.bodyText, `system body ${suffix}`);
  await assert.rejects(
    () =>
      createDraftMessage({
        threadId: threadA.id,
        brokerageId: A.brokerageId,
        channel: "EMAIL",
        classification: "TRANSACTIONAL",
        templateId: foreignTemplate.id,
        bodyText: "fallback",
        senderUserId: A.agent.user.id,
        createdByUserId: A.agent.user.id,
      }),
    tenancy,
  );

  await assert.rejects(
    () =>
      createTemplateVersion({
        brokerageId: A.brokerageId,
        templateId: foreignTemplate.id,
        bodyText: "rewritten",
        createdByUserId: A.agent.user.id,
      }),
    tenancy,
  );
  const [ownTemplate] = await db
    .insert(communicationTemplates)
    .values({
      brokerageId: A.brokerageId,
      templateKey: `a4-own-${suffix}`,
      name: "Own",
      channel: "EMAIL",
      classification: "TRANSACTIONAL",
      category: "GENERAL",
      status: "DRAFT",
      bodyText: `own template ${suffix}`,
      placeholders: [],
      createdByUserId: A.agent.user.id,
    })
    .returning();
  const versioned = await createTemplateVersion({
    brokerageId: A.brokerageId,
    templateId: ownTemplate.id,
    bodyText: `own template v2 ${suffix}`,
    createdByUserId: A.agent.user.id,
  });
  assert.equal(versioned.version, 2);
  assert.equal(versioned.brokerageId, A.brokerageId);
  await assert.rejects(() => activateTemplate(foreignTemplate.id, A.brokerageId, A.agent.user.id), tenancy);
  const active = await activateTemplate(versioned.id, A.brokerageId, A.agent.user.id);
  assert.equal(active.status, "ACTIVE");
  await assert.rejects(() => archiveTemplate(foreignTemplate.id, A.brokerageId, A.agent.user.id), tenancy);
  const archived = await archiveTemplate(active.id, A.brokerageId, A.agent.user.id);
  assert.equal(archived.status, "ARCHIVED");
  const [foreignTemplateAfter] = await db.select().from(communicationTemplates).where(eq(communicationTemplates.id, foreignTemplate.id));
  assert.equal(foreignTemplateAfter?.status, "DRAFT");
  assert.equal(foreignTemplateAfter?.bodyText, `foreign body ${suffix}`);
});

test("timeline party lookup returns nothing for a foreign party and still emits an own appraisal", async () => {
  const propertyA = await createProperty(A.agent.cookie, `A4 Timeline St ${suffix}`);
  const partyA = await createParty(A.agent.cookie, propertyA, "Nia");
  const appraisal = await createAppraisalFromContact({
    partyId: partyA,
    propertyId: propertyA,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
  });
  const own = await getRelationshipTimeline(A.brokerageId, partyA);
  assert.ok(own.some((event) => event.id === `appraisal:${appraisal.id}:CREATED`));

  const propertyB = await createProperty(B.agent.cookie, `A4 Timeline Rd ${suffix}`);
  const partyB = await createParty(B.agent.cookie, propertyB, "Bea");
  assert.deepEqual(await getRelationshipTimeline(A.brokerageId, partyB), []);
});

test("inbound webhook thread and idempotency lookups stay inside the webhook brokerage", async () => {
  const propertyA = await createProperty(A.agent.cookie, `A4 Webhook St ${suffix}`);
  const partyA = await createParty(A.agent.cookie, propertyA, "Nia");
  const propertyB = await createProperty(B.agent.cookie, `A4 Webhook Rd ${suffix}`);
  const threadA = await createThread({
    brokerageId: A.brokerageId,
    propertyId: propertyA,
    partyId: partyA,
    subject: `A4 webhook ${suffix}`,
    createdByUserId: A.agent.user.id,
  });
  const threadB = await createThread({
    brokerageId: B.brokerageId,
    propertyId: propertyB,
    subject: `A4 foreign webhook ${suffix}`,
    createdByUserId: B.agent.user.id,
  });
  const provider = `a4-provider-${suffix}`;
  const [anchoredOnForeignThread] = await db
    .insert(communicationMessages)
    .values({
      threadId: threadB.id,
      brokerageId: A.brokerageId,
      propertyId: propertyA,
      direction: "OUTBOUND",
      channel: "EMAIL",
      classification: "TRANSACTIONAL",
      status: "SENT",
      bodyText: `anchored ${suffix}`,
      provider,
      providerMessageId: `foreign-thread-${suffix}`,
      senderUserId: A.agent.user.id,
    })
    .returning();
  const missed = await processInboundWebhook({
    brokerageId: A.brokerageId,
    provider,
    providerEventId: `miss-${suffix}`,
    eventType: "INBOUND_MESSAGE",
    payload: {},
    providerMessageId: anchoredOnForeignThread.providerMessageId,
  });
  assert.equal(missed.status, "PROCESSED");
  assert.match(missed.detail ?? "", /no conversation/i);
  const foreignThreadMessages = await db.select().from(communicationMessages).where(eq(communicationMessages.threadId, threadB.id));
  assert.deepEqual(
    foreignThreadMessages.map((row) => row.id),
    [anchoredOnForeignThread.id],
  );

  const [ownOutbound] = await db
    .insert(communicationMessages)
    .values({
      threadId: threadA.id,
      brokerageId: A.brokerageId,
      propertyId: propertyA,
      direction: "OUTBOUND",
      channel: "EMAIL",
      classification: "TRANSACTIONAL",
      status: "SENT",
      bodyText: `outbound ${suffix}`,
      provider,
      providerMessageId: `own-thread-${suffix}`,
      senderUserId: A.agent.user.id,
    })
    .returning();
  const eventId = `collide-${suffix}`;
  const [blocker] = await db
    .insert(communicationMessages)
    .values({
      threadId: threadB.id,
      brokerageId: B.brokerageId,
      propertyId: propertyB,
      direction: "INBOUND",
      channel: "EMAIL",
      classification: "TRANSACTIONAL",
      status: "RECEIVED",
      bodyText: `blocker ${suffix}`,
      idempotencyKey: `inbound:${provider}:${eventId}`,
    })
    .returning();
  const collided = await processInboundWebhook({
    brokerageId: A.brokerageId,
    provider,
    providerEventId: eventId,
    eventType: "INBOUND_MESSAGE",
    payload: { bodyText: "should not land" },
    providerMessageId: ownOutbound.providerMessageId,
  });
  assert.equal(collided.status, "FAILED");
  assert.match(collided.detail ?? "", /could not be recorded/);
  const [blockerAfter] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, blocker.id));
  assert.equal(blockerAfter?.bodyText, `blocker ${suffix}`);
  const inboundOnA = await db
    .select()
    .from(communicationMessages)
    .where(and(eq(communicationMessages.threadId, threadA.id), eq(communicationMessages.direction, "INBOUND")));
  assert.equal(inboundOnA.length, 0);

  const recorded = await processInboundWebhook({
    brokerageId: A.brokerageId,
    provider,
    providerEventId: `ok-${suffix}`,
    eventType: "INBOUND_MESSAGE",
    payload: { bodyText: `reply ${suffix}` },
    providerMessageId: ownOutbound.providerMessageId,
  });
  assert.equal(recorded.status, "PROCESSED");
  const inboundAfter = await db
    .select()
    .from(communicationMessages)
    .where(and(eq(communicationMessages.threadId, threadA.id), eq(communicationMessages.direction, "INBOUND")));
  assert.equal(inboundAfter.length, 1);
  assert.equal(inboundAfter[0]?.brokerageId, A.brokerageId);
  assert.match(inboundAfter[0]?.bodyText ?? "", new RegExp(`reply ${suffix}`));
});

test("property intelligence id writes reject a foreign id and still update an own row", async () => {
  const propertyA = await createProperty(A.agent.cookie, `A4 Signal St ${suffix}`);
  const propertyB = await createProperty(B.agent.cookie, `A4 Signal Rd ${suffix}`);
  const partyA = await createParty(A.agent.cookie, propertyA, "Nia");

  await recordObservation({
    brokerageId: A.brokerageId,
    propertyId: propertyA,
    observationType: "sales_history",
    provider: `a4-${suffix}`,
    payload: { note: "first" },
  });
  const [ownCurrent] = await db
    .select()
    .from(propertyProviderObservations)
    .where(
      and(
        eq(propertyProviderObservations.propertyId, propertyA),
        eq(propertyProviderObservations.brokerageId, A.brokerageId),
        eq(propertyProviderObservations.isCurrent, true),
      ),
    );
  const [foreignCurrent] = await db
    .insert(propertyProviderObservations)
    .values({
      brokerageId: B.brokerageId,
      propertyId: propertyA,
      observationType: "sales_history",
      provider: `a4-${suffix}`,
      payload: { note: "foreign current" },
      isCurrent: true,
    })
    .returning();
  await recordObservation({
    brokerageId: A.brokerageId,
    propertyId: propertyA,
    observationType: "sales_history",
    provider: `a4-${suffix}`,
    payload: { note: "second" },
  });
  const [ownPrevious] = await db.select().from(propertyProviderObservations).where(eq(propertyProviderObservations.id, ownCurrent.id));
  const [foreignStill] = await db
    .select()
    .from(propertyProviderObservations)
    .where(eq(propertyProviderObservations.id, foreignCurrent.id));
  assert.equal(ownPrevious?.isCurrent, false);
  assert.equal(foreignStill?.isCurrent, true);
  assert.deepEqual(foreignStill?.payload, { note: "foreign current" });

  const [signalB] = await db
    .insert(growOpportunitySignals)
    .values({
      brokerageId: B.brokerageId,
      propertyId: propertyB,
      signalType: "long_ownership_tenure",
      title: `foreign signal ${suffix}`,
      explanation: "foreign",
      evidence: { factors: [] },
      source: "internal",
      confidenceBand: "Emerging",
      status: "Active",
      dedupeKey: `a4-foreign-signal-${suffix}`,
    })
    .returning();
  await assert.rejects(
    () => reviewSignal({ signalId: signalB.id, brokerageId: A.brokerageId, userId: A.agent.user.id }),
    (err: unknown) => err instanceof PropertyIntelligenceAccessError && err.message === "Signal not found",
  );
  await assert.rejects(
    () =>
      dismissSignal({
        signalId: signalB.id,
        brokerageId: A.brokerageId,
        userId: A.agent.user.id,
        dismissedReason: "no",
      }),
    (err: unknown) => err instanceof PropertyIntelligenceAccessError && err.message === "Signal not found",
  );
  await assert.rejects(
    () => promoteSignal({ signalId: signalB.id, brokerageId: A.brokerageId, userId: A.agent.user.id }),
    (err: unknown) => err instanceof PropertyIntelligenceAccessError && err.message === "Signal not found",
  );
  const [signalBAfter] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.id, signalB.id));
  assert.equal(signalBAfter?.status, "Active");

  const [signalA] = await db
    .insert(growOpportunitySignals)
    .values({
      brokerageId: A.brokerageId,
      partyId: partyA,
      propertyId: propertyA,
      signalType: "long_ownership_tenure",
      title: `own signal ${suffix}`,
      explanation: "own",
      evidence: { factors: [] },
      source: "internal",
      confidenceBand: "Emerging",
      status: "Active",
      dedupeKey: `a4-own-signal-${suffix}`,
    })
    .returning();
  const reviewed = await reviewSignal({ signalId: signalA.id, brokerageId: A.brokerageId, userId: A.agent.user.id });
  assert.equal(reviewed.status, "Reviewed");
  const promoted = await promoteSignal({ signalId: signalA.id, brokerageId: A.brokerageId, userId: A.agent.user.id });
  assert.equal(promoted.signal.status, "Superseded");
  assert.ok(promoted.opportunityId > 0);
  const [dismissTarget] = await db
    .insert(growOpportunitySignals)
    .values({
      brokerageId: A.brokerageId,
      partyId: partyA,
      propertyId: propertyA,
      signalType: "past_buyer_interest",
      title: `dismiss ${suffix}`,
      explanation: "own",
      evidence: { factors: [] },
      source: "internal",
      confidenceBand: "Emerging",
      status: "Active",
      dedupeKey: `a4-dismiss-${suffix}`,
    })
    .returning();
  const dismissed = await dismissSignal({
    signalId: dismissTarget.id,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
    dismissedReason: "not now",
  });
  assert.equal(dismissed.status, "Dismissed");

  const foreignMatch = await proposeMatch({
    brokerageId: B.brokerageId,
    propertyId: propertyB,
    provider: `a4-${suffix}`,
    externalId: `foreign-${suffix}`,
    matchConfidence: 0.2,
  });
  await assert.rejects(
    () => confirmMatch({ identifierId: foreignMatch.id, brokerageId: A.brokerageId, userId: A.agent.user.id }),
    (err: unknown) => err instanceof PropertyIntelligenceAccessError && err.message === "Match not found",
  );
  await assert.rejects(
    () => rejectMatch({ identifierId: foreignMatch.id, brokerageId: A.brokerageId, userId: A.agent.user.id }),
    (err: unknown) => err instanceof PropertyIntelligenceAccessError && err.message === "Match not found",
  );
  const [foreignMatchAfter] = await db
    .select()
    .from(propertyExternalIdentifiers)
    .where(eq(propertyExternalIdentifiers.id, foreignMatch.id));
  assert.equal(foreignMatchAfter?.status, "PendingReview");

  const ownMatch = await proposeMatch({
    brokerageId: A.brokerageId,
    propertyId: propertyA,
    provider: `a4-${suffix}`,
    externalId: `own-${suffix}`,
    matchConfidence: 0.4,
  });
  const refreshed = await proposeMatch({
    brokerageId: A.brokerageId,
    propertyId: propertyA,
    provider: `a4-${suffix}`,
    externalId: `own-${suffix}`,
    matchConfidence: 0.8,
  });
  assert.equal(refreshed.id, ownMatch.id);
  assert.equal(Number(refreshed.matchConfidence), 0.8);
  const confirmed = await confirmMatch({ identifierId: ownMatch.id, brokerageId: A.brokerageId, userId: A.agent.user.id });
  assert.equal(confirmed.status, "Confirmed");
  const rejectable = await proposeMatch({
    brokerageId: A.brokerageId,
    propertyId: propertyA,
    provider: `a4-${suffix}`,
    externalId: `reject-${suffix}`,
  });
  const rejected = await rejectMatch({
    identifierId: rejectable.id,
    brokerageId: A.brokerageId,
    userId: A.agent.user.id,
    rejectedReason: "wrong property",
  });
  assert.equal(rejected.status, "Rejected");
});
