// C-10 U2 — AI_VOICE_TRANSCRIBED is not a property-timeline action, even when
// a row is attached to a property and its payload contains transcript text.
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, auditLogs, brokerages, properties, users } from "@aee/db";
import { getPropertyTimeline } from "../timeline.js";
import { AI_VOICE_TRANSCRIBED_ACTION, recordVoiceTranscriptionMeter } from "../ai/voice/voiceMeter.js";

test("property timeline does not surface AI_VOICE_TRANSCRIBED rows", async () => {
  const tag = randomUUID();
  const [brokerage] = await db.insert(brokerages).values({ name: `C10 timeline ${tag}` }).returning();
  assert.ok(brokerage);
  const [user] = await db
    .insert(users)
    .values({
      authProviderId: `c10-timeline-${tag}`,
      email: `c10-timeline-${tag}@example.test`,
      firstName: "Timeline",
      lastName: "Agent",
      role: "Agent",
      brokerageId: brokerage.id,
      isActive: true,
    })
    .returning();
  assert.ok(user);
  const [property] = await db
    .insert(properties)
    .values({ brokerageId: brokerage.id, agentId: user.id, formattedAddress: `1 Voice Meter St ${tag}` })
    .returning();
  assert.ok(property);

  try {
    await recordVoiceTranscriptionMeter({
      brokerageId: brokerage.id,
      userId: user.id,
      provider: "mock",
      outcome: "success",
      audioSeconds: 2,
      latencyMs: 8,
      correlationId: randomUUID(),
    });
    const [realMeter] = await db.select().from(auditLogs).where(eq(auditLogs.brokerageId, brokerage.id));
    assert.ok(realMeter);
    assert.equal(realMeter.propertyId, null);
    assert.equal(realMeter.action, AI_VOICE_TRANSCRIBED_ACTION);

    await db.insert(auditLogs).values({
      brokerageId: brokerage.id,
      userId: user.id,
      action: "party_added",
      recordType: "party",
      recordId: "0",
      propertyId: property.id,
      updatedValue: JSON.stringify({ name: "Ada" }),
    });
    await db.insert(auditLogs).values({
      brokerageId: brokerage.id,
      userId: user.id,
      action: AI_VOICE_TRANSCRIBED_ACTION,
      recordType: "ai_voice",
      recordId: randomUUID(),
      propertyId: property.id,
      providerReference: "mock",
      updatedValue: JSON.stringify({
        transcript: "secret spoken words",
        audio: "base64-audio-bytes",
        audioBytes: "more-bytes",
        outcome: "success",
      }),
    });

    const items = await getPropertyTimeline(property.id, brokerage.id, true);
    assert.ok(items.some((item) => item.entryType === "party_added"));
    assert.equal(
      items.some((item) => item.entryType === AI_VOICE_TRANSCRIBED_ACTION),
      false,
    );
    const rendered = JSON.stringify(items);
    assert.equal(rendered.includes("secret spoken words"), false);
    assert.equal(rendered.includes("base64-audio-bytes"), false);
    assert.equal(rendered.includes(AI_VOICE_TRANSCRIBED_ACTION), false);
  } finally {
    await db.delete(auditLogs).where(eq(auditLogs.brokerageId, brokerage.id));
    await db.delete(properties).where(eq(properties.id, property.id));
    await db.delete(users).where(eq(users.id, user.id));
    await db.delete(brokerages).where(eq(brokerages.id, brokerage.id));
  }
});
