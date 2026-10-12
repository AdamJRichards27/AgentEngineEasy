// AE GROW D-5 — inbound reply threading.
//
// INBOUND_MESSAGE used to publish COMMUNICATION_MESSAGE_RECEIVED and return
// without a message row. A reply now inserts its own RECEIVED row on the
// conversation this brokerage can resolve (the prior message named by
// providerMessageId, else the sender address), and a redelivery of the same
// provider event does not insert a second row. OPT_OUT, DELIVERY_RECEIPT,
// and BOUNCE are unchanged.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  brokerages,
  communicationConsent,
  communicationMessages,
  communicationParticipants,
  communicationThreads,
  communicationWebhookEvents,
  db,
  domainEvents,
  parties,
  properties,
  users,
} from "@aee/db";
import { processInboundWebhook } from "../webhooks.js";

const databaseEnabled = Boolean(process.env.DATABASE_URL);

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
});

interface Conversation {
  brokerageId: number;
  userId: number;
  propertyId: number | null;
  partyId: number | null;
  threadId: number;
  participantId: number;
  messageId: number;
  providerMessageId: string;
}

async function createBrokerage(label: string): Promise<{ brokerageId: number; userId: number; suffix: string }> {
  const suffix = `${Date.now()}_${process.pid}_${label}_${Math.random().toString(16).slice(2)}`;
  const [brokerage] = await db.insert(brokerages).values({ name: `D5 ${label} ${suffix}` }).returning();
  const [user] = await db
    .insert(users)
    .values({
      authProviderId: `d5-${suffix}`,
      email: `d5-${suffix}@example.test`,
      firstName: "D5",
      lastName: label,
      brokerageId: brokerage.id,
    })
    .returning();
  return { brokerageId: brokerage.id, userId: user.id, suffix };
}

async function seedConversation(input: {
  label: string;
  channel: "EMAIL" | "SMS";
  destination: string;
  provider?: string;
  contactFirst?: boolean;
  subject?: string;
}): Promise<Conversation> {
  const { brokerageId, userId } = await createBrokerage(input.label);
  const provider = input.provider ?? (input.channel === "SMS" ? "sandbox_sms" : "sandbox_email");
  let propertyId: number | null = null;
  let partyId: number | null = null;
  if (input.contactFirst) {
    const [party] = await db
      .insert(parties)
      .values({
        brokerageId,
        firstName: "Cara",
        lastName: "Reply",
        email: input.channel === "EMAIL" ? input.destination : null,
        mobile: input.channel === "SMS" ? input.destination : null,
      })
      .returning();
    partyId = party.id;
  } else {
    const [property] = await db
      .insert(properties)
      .values({ brokerageId, agentId: userId, formattedAddress: `1 D5 ${input.label} St` })
      .returning();
    propertyId = property.id;
  }

  const [thread] = await db
    .insert(communicationThreads)
    .values({
      brokerageId,
      propertyId,
      partyId,
      subject: input.subject ?? "Offer update",
      createdByUserId: userId,
    })
    .returning();
  const [participant] = await db
    .insert(communicationParticipants)
    .values({
      threadId: thread.id,
      brokerageId,
      partyId,
      role: "Buyer",
      displayName: "Cara Reply",
      email: input.channel === "EMAIL" ? input.destination : null,
      mobile: input.channel === "SMS" ? input.destination : null,
      addedByUserId: userId,
    })
    .returning();
  const providerMessageId = `d5-${input.label}-${thread.id}`;
  const [message] = await db
    .insert(communicationMessages)
    .values({
      threadId: thread.id,
      brokerageId,
      propertyId,
      partyId,
      direction: "OUTBOUND",
      channel: input.channel,
      classification: "TRANSACTIONAL",
      status: "SENT",
      subject: input.subject ?? "Offer update",
      bodyText: "The offer is with the vendor.",
      recipientParticipantId: participant.id,
      recipientDisplayName: "Cara Reply",
      recipientDestination: input.destination,
      provider,
      providerMessageId,
      senderUserId: userId,
      createdByUserId: userId,
    })
    .returning();

  return {
    brokerageId,
    userId,
    propertyId,
    partyId,
    threadId: thread.id,
    participantId: participant.id,
    messageId: message.id,
    providerMessageId,
  };
}

async function cleanup(brokerageIds: number[], eventIds: string[]): Promise<void> {
  if (eventIds.length > 0) {
    await db.delete(communicationWebhookEvents).where(inArray(communicationWebhookEvents.providerEventId, eventIds));
  }
  for (const brokerageId of brokerageIds) {
    await db.delete(domainEvents).where(eq(domainEvents.brokerageId, brokerageId));
    await db.delete(auditLogs).where(eq(auditLogs.brokerageId, brokerageId));
    await db.delete(communicationConsent).where(eq(communicationConsent.brokerageId, brokerageId));
    await db
      .delete(communicationMessages)
      .where(and(eq(communicationMessages.brokerageId, brokerageId), eq(communicationMessages.direction, "INBOUND")));
    await db.delete(communicationMessages).where(eq(communicationMessages.brokerageId, brokerageId));
    const threads = await db
      .select({ id: communicationThreads.id })
      .from(communicationThreads)
      .where(eq(communicationThreads.brokerageId, brokerageId));
    const threadIds = threads.map((thread) => thread.id);
    if (threadIds.length > 0) {
      await db.delete(communicationParticipants).where(inArray(communicationParticipants.threadId, threadIds));
    }
    await db.delete(communicationThreads).where(eq(communicationThreads.brokerageId, brokerageId));
    await db.delete(properties).where(eq(properties.brokerageId, brokerageId));
    await db.delete(parties).where(eq(parties.brokerageId, brokerageId));
    await db.delete(users).where(eq(users.brokerageId, brokerageId));
    await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
  }
}

function inboundRows(threadId: number) {
  return db
    .select()
    .from(communicationMessages)
    .where(and(eq(communicationMessages.threadId, threadId), eq(communicationMessages.direction, "INBOUND")));
}

test(
  "D-5: an inbound reply is one RECEIVED row on the named outbound's thread, and a redelivery does not insert another",
  { skip: !databaseEnabled, concurrency: false },
  async () => {
    const conversation = await seedConversation({
      label: "named",
      channel: "EMAIL",
      destination: "Buyer@Example.com",
    });
    const other = await createBrokerage("other");
    const eventId = `d5-named-${conversation.threadId}`;
    const crossEventId = `d5-named-cross-${conversation.threadId}`;
    const receiptEventId = `d5-named-receipt-${conversation.threadId}`;
    const brokerageIds = [conversation.brokerageId, other.brokerageId];
    const eventIds = [eventId, crossEventId, receiptEventId];
    try {
      const input = {
        brokerageId: conversation.brokerageId,
        provider: "sandbox_email",
        providerEventId: eventId,
        eventType: "INBOUND_MESSAGE" as const,
        payload: {
          bodyText: "Thanks, we accept.",
          threadId: 999_999,
          brokerageId: other.brokerageId,
        },
        providerMessageId: conversation.providerMessageId,
        destination: "  buyer@example.com  ",
        destinationChannel: "EMAIL" as const,
      };

      const first = await processInboundWebhook(input);
      assert.equal(first.status, "PROCESSED");
      assert.match(first.detail ?? "", /Inbound reply recorded as message/);

      const rows = await inboundRows(conversation.threadId);
      assert.equal(rows.length, 1);
      const inbound = rows[0]!;
      assert.equal(inbound.brokerageId, conversation.brokerageId);
      assert.equal(inbound.threadId, conversation.threadId);
      assert.equal(inbound.propertyId, conversation.propertyId);
      assert.equal(inbound.replyToMessageId, conversation.messageId);
      assert.equal(inbound.direction, "INBOUND");
      assert.equal(inbound.status, "RECEIVED");
      assert.equal(inbound.channel, "EMAIL");
      assert.equal(inbound.subject, "Re: Offer update");
      assert.equal(inbound.bodyText, "Thanks, we accept.");
      assert.equal(inbound.provider, "sandbox_email");
      assert.equal(inbound.providerMessageId, null);
      assert.equal(inbound.idempotencyKey, `inbound:sandbox_email:${eventId}`);

      const [outbound] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, conversation.messageId));
      assert.equal(outbound?.status, "SENT");

      const [webhookEvent] = await db
        .select()
        .from(communicationWebhookEvents)
        .where(and(eq(communicationWebhookEvents.provider, "sandbox_email"), eq(communicationWebhookEvents.providerEventId, eventId)));
      assert.equal(webhookEvent?.processingStatus, "PROCESSED");
      assert.equal(webhookEvent?.relatedMessageId, inbound.id);

      const receivedEvents = await db
        .select()
        .from(domainEvents)
        .where(and(eq(domainEvents.brokerageId, conversation.brokerageId), eq(domainEvents.eventType, "COMMUNICATION_MESSAGE_RECEIVED")));
      assert.equal(receivedEvents.length, 1);
      const payload = receivedEvents[0]?.payload as { messageId?: number; threadId?: number };
      assert.equal(payload.messageId, inbound.id);
      assert.equal(payload.threadId, conversation.threadId);

      const duplicate = await processInboundWebhook(input);
      assert.equal(duplicate.status, "DUPLICATE");
      assert.equal((await inboundRows(conversation.threadId)).length, 1, "a redelivered inbound webhook must not insert a second message");
      assert.equal(
        (
          await db
            .select()
            .from(communicationWebhookEvents)
            .where(and(eq(communicationWebhookEvents.provider, "sandbox_email"), eq(communicationWebhookEvents.providerEventId, eventId)))
        ).length,
        1,
      );
      assert.equal(
        (
          await db
            .select()
            .from(domainEvents)
            .where(and(eq(domainEvents.brokerageId, conversation.brokerageId), eq(domainEvents.eventType, "COMMUNICATION_MESSAGE_RECEIVED")))
        ).length,
        1,
      );

      const crossTenant = await processInboundWebhook({
        ...input,
        brokerageId: other.brokerageId,
        providerEventId: crossEventId,
        payload: { bodyText: "This must not attach." },
      });
      assert.equal(crossTenant.status, "PROCESSED");
      assert.match(crossTenant.detail ?? "", /no conversation in this brokerage/);
      assert.equal((await inboundRows(conversation.threadId)).length, 1);
      const otherMessages = await db.select().from(communicationMessages).where(eq(communicationMessages.brokerageId, other.brokerageId));
      assert.equal(otherMessages.length, 0);

      const receipt = await processInboundWebhook({
        brokerageId: conversation.brokerageId,
        provider: "sandbox_email",
        providerEventId: receiptEventId,
        eventType: "DELIVERY_RECEIPT",
        payload: { eventType: "DELIVERY_RECEIPT" },
        providerMessageId: conversation.providerMessageId,
      });
      assert.equal(receipt.status, "PROCESSED");
      assert.match(receipt.detail ?? "", /DELIVERED/);
      const [afterReceipt] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, conversation.messageId));
      assert.equal(afterReceipt?.status, "DELIVERED");
      const [inboundAfter] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, inbound.id));
      assert.equal(inboundAfter?.status, "RECEIVED");
      assert.equal((await inboundRows(conversation.threadId)).length, 1);
    } finally {
      await cleanup(brokerageIds, eventIds);
    }
  },
);

test(
  "D-5: a reply with no provider message id threads by sender address, including a contact-first thread, and an unknown sender inserts nothing",
  { skip: !databaseEnabled, concurrency: false },
  async () => {
    const email = await seedConversation({
      label: "address",
      channel: "EMAIL",
      destination: "Buyer@Example.com",
      contactFirst: true,
    });
    const sms = await seedConversation({
      label: "sms",
      channel: "SMS",
      destination: "0400 123 456",
      provider: "sandbox_sms",
    });
    const eventIds = [`d5-address-${email.threadId}`, `d5-sms-${sms.threadId}`, `d5-unknown-${email.threadId}`];
    try {
      const byAddress = await processInboundWebhook({
        brokerageId: email.brokerageId,
        provider: "sandbox_email",
        providerEventId: eventIds[0]!,
        eventType: "INBOUND_MESSAGE",
        payload: { body: "Replying without a provider message id." },
        destination: "buyer@example.com",
        destinationChannel: "EMAIL",
      });
      assert.equal(byAddress.status, "PROCESSED");
      const emailRows = await inboundRows(email.threadId);
      assert.equal(emailRows.length, 1);
      assert.equal(emailRows[0]?.replyToMessageId, email.messageId);
      assert.equal(emailRows[0]?.partyId, email.partyId);
      assert.equal(emailRows[0]?.propertyId, null);
      assert.equal(emailRows[0]?.bodyText, "Replying without a provider message id.");
      assert.equal(emailRows[0]?.brokerageId, email.brokerageId);

      const addressDuplicate = await processInboundWebhook({
        brokerageId: email.brokerageId,
        provider: "sandbox_email",
        providerEventId: eventIds[0]!,
        eventType: "INBOUND_MESSAGE",
        payload: { body: "Replying without a provider message id." },
        destination: "buyer@example.com",
        destinationChannel: "EMAIL",
      });
      assert.equal(addressDuplicate.status, "DUPLICATE");
      assert.equal((await inboundRows(email.threadId)).length, 1);

      const bySms = await processInboundWebhook({
        brokerageId: sms.brokerageId,
        provider: "sandbox_sms",
        providerEventId: eventIds[1]!,
        eventType: "INBOUND_MESSAGE",
        payload: { text: "On my way." },
        destination: "0400123456",
        destinationChannel: "SMS",
      });
      assert.equal(bySms.status, "PROCESSED");
      const smsRows = await inboundRows(sms.threadId);
      assert.equal(smsRows.length, 1);
      assert.equal(smsRows[0]?.channel, "SMS");
      assert.equal(smsRows[0]?.bodyText, "On my way.");
      assert.equal(smsRows[0]?.replyToMessageId, sms.messageId);
      assert.equal((await inboundRows(email.threadId)).length, 1, "an SMS reply must not attach to the email thread");

      const unknown = await processInboundWebhook({
        brokerageId: email.brokerageId,
        provider: "sandbox_email",
        providerEventId: eventIds[2]!,
        eventType: "INBOUND_MESSAGE",
        payload: { bodyText: "Who is this?" },
        destination: "nobody-d5@example.com",
        destinationChannel: "EMAIL",
      });
      assert.equal(unknown.status, "PROCESSED");
      assert.match(unknown.detail ?? "", /no conversation in this brokerage/);
      const unknownDuplicate = await processInboundWebhook({
        brokerageId: email.brokerageId,
        provider: "sandbox_email",
        providerEventId: eventIds[2]!,
        eventType: "INBOUND_MESSAGE",
        payload: { bodyText: "Who is this?" },
        destination: "nobody-d5@example.com",
        destinationChannel: "EMAIL",
      });
      assert.equal(unknownDuplicate.status, "DUPLICATE");
      assert.equal((await inboundRows(email.threadId)).length, 1, "an unresolved redelivery must not invent a message row");
      const emailMessages = await db.select().from(communicationMessages).where(eq(communicationMessages.brokerageId, email.brokerageId));
      assert.equal(emailMessages.filter((message) => message.direction === "INBOUND").length, 1);
    } finally {
      await cleanup([email.brokerageId, sms.brokerageId], eventIds);
    }
  },
);

test(
  "D-5: a participant-only thread still receives the reply, and a provider mismatch does not steal another channel's message",
  { skip: !databaseEnabled, concurrency: false },
  async () => {
    const { brokerageId, userId } = await createBrokerage("participant");
    const [property] = await db
      .insert(properties)
      .values({ brokerageId, agentId: userId, formattedAddress: "2 D5 Participant St" })
      .returning();
    const [thread] = await db
      .insert(communicationThreads)
      .values({ brokerageId, propertyId: property.id, subject: "Inspection", createdByUserId: userId })
      .returning();
    await db.insert(communicationParticipants).values({
      threadId: thread.id,
      brokerageId,
      role: "Buyer",
      displayName: "Pat Buyer",
      email: "pat.buyer@example.com",
      isManualEntry: true,
      manualEntryReason: "D-5 fixture",
      addedByUserId: userId,
    });
    const named = await seedConversation({ label: "mismatch", channel: "EMAIL", destination: "other.buyer@example.com" });
    const eventIds = [`d5-participant-${thread.id}`, `d5-mismatch-${named.messageId}`];
    try {
      const reply = await processInboundWebhook({
        brokerageId,
        provider: "sandbox_email",
        providerEventId: eventIds[0]!,
        eventType: "INBOUND_MESSAGE",
        payload: { subject: "Saturday works", bodyText: "See you then." },
        destination: "Pat.Buyer@example.com",
        destinationChannel: "EMAIL",
      });
      assert.equal(reply.status, "PROCESSED");
      const rows = await inboundRows(thread.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.replyToMessageId, null);
      assert.equal(rows[0]?.subject, "Saturday works");
      assert.equal(rows[0]?.status, "RECEIVED");
      assert.equal(rows[0]?.propertyId, property.id);
      assert.equal(rows[0]?.brokerageId, brokerageId);

      const mismatch = await processInboundWebhook({
        brokerageId: named.brokerageId,
        provider: "sandbox_sms",
        providerEventId: eventIds[1]!,
        eventType: "INBOUND_MESSAGE",
        payload: { text: "wrong pipe" },
        providerMessageId: named.providerMessageId,
        destination: "0400999888",
        destinationChannel: "SMS",
      });
      assert.equal(mismatch.status, "PROCESSED");
      assert.match(mismatch.detail ?? "", /no conversation in this brokerage/);
      assert.equal((await inboundRows(named.threadId)).length, 0);
      const namedMessages = await db.select().from(communicationMessages).where(eq(communicationMessages.brokerageId, named.brokerageId));
      assert.equal(namedMessages.length, 1);
      assert.equal(namedMessages[0]?.status, "SENT");
    } finally {
      await cleanup([brokerageId, named.brokerageId], eventIds);
    }
  },
);

test(
  "D-5: OPT_OUT, BOUNCE, and an already-covered delivery receipt do not create an inbound message",
  { skip: !databaseEnabled, concurrency: false },
  async () => {
    const conversation = await seedConversation({
      label: "effects",
      channel: "EMAIL",
      destination: "effects-buyer@example.com",
    });
    const eventIds = [`d5-bounce-${conversation.messageId}`, `d5-optout-${conversation.brokerageId}`];
    try {
      const bounce = await processInboundWebhook({
        brokerageId: conversation.brokerageId,
        provider: "sandbox_email",
        providerEventId: eventIds[0]!,
        eventType: "BOUNCE",
        payload: {},
        providerMessageId: conversation.providerMessageId,
      });
      assert.equal(bounce.status, "PROCESSED");
      assert.match(bounce.detail ?? "", /BOUNCED/);
      const [bounced] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, conversation.messageId));
      assert.equal(bounced?.status, "BOUNCED");
      assert.equal(bounced?.failureCategory, "UNDELIVERABLE_BOUNCE");
      assert.equal((await inboundRows(conversation.threadId)).length, 0);

      const optOut = await processInboundWebhook({
        brokerageId: conversation.brokerageId,
        provider: "sandbox_email",
        providerEventId: eventIds[1]!,
        eventType: "OPT_OUT",
        payload: {},
        destination: "effects-buyer@example.com",
        destinationChannel: "EMAIL",
      });
      assert.equal(optOut.status, "PROCESSED");
      assert.match(optOut.detail ?? "", /opt-out/i);
      const [consent] = await db
        .select()
        .from(communicationConsent)
        .where(and(eq(communicationConsent.brokerageId, conversation.brokerageId), eq(communicationConsent.channel, "EMAIL")));
      assert.equal(consent?.marketingOptIn, false);
      assert.equal(consent?.transactionalOptOut, true);
      assert.equal(consent?.source, "WEBHOOK_REPLY_STOP");
      const messages = await db.select().from(communicationMessages).where(eq(communicationMessages.brokerageId, conversation.brokerageId));
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.direction, "OUTBOUND");
    } finally {
      await cleanup([conversation.brokerageId], eventIds);
    }
  },
);
