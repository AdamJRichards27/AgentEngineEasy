import { db, auditLogs } from "@aee/db";
import { incrementCounter, logger } from "@aee/events";

/**
 * C-10 durable voice meter (Option A). One audit_logs row per transcription
 * that reached the provider. No new table.
 *
 * Privacy: the row stores brokerage, user, provider, outcome, audio duration
 * seconds, latency, correlation id, and the row timestamp. It never stores
 * audio bytes, an audio URL, a transcript, or any partial transcript.
 * propertyId is left null so the row is not a property-timeline candidate;
 * the timeline also filters on an action allow-list that does not include
 * AI_VOICE_TRANSCRIBED (lib/timeline.ts).
 */
export const AI_VOICE_TRANSCRIBED_ACTION = "AI_VOICE_TRANSCRIBED";
export const AI_VOICE_RECORD_TYPE = "ai_voice";

/** The only keys ever written into audit_logs.updated_value for this action. */
export const VOICE_METER_METADATA_KEYS = ["outcome", "latencyMs", "audioSeconds"] as const;

export type VoiceMeterOutcome = "success" | "provider_error" | "rejected_after_provider" | "empty_transcript";

export interface VoiceMeterInput {
  brokerageId: number;
  userId: number;
  provider: string;
  outcome: VoiceMeterOutcome;
  /** Provider-reported duration. Persisted only on success, and only when finite and non-negative. */
  audioSeconds: number | null;
  latencyMs: number;
  correlationId: string;
}

export interface VoiceMeterMetadata {
  outcome: VoiceMeterOutcome;
  latencyMs: number;
  audioSeconds?: number;
}

export function voiceMeterMetadata(input: Pick<VoiceMeterInput, "outcome" | "audioSeconds" | "latencyMs">): VoiceMeterMetadata {
  const latencyMs = Number.isFinite(input.latencyMs) ? Math.max(0, Math.round(input.latencyMs)) : 0;
  const metadata: VoiceMeterMetadata = { outcome: input.outcome, latencyMs };
  if (
    input.outcome === "success" &&
    input.audioSeconds !== null &&
    Number.isFinite(input.audioSeconds) &&
    input.audioSeconds >= 0
  ) {
    metadata.audioSeconds = input.audioSeconds;
  }
  return metadata;
}

interface VoiceMeterRow {
  brokerageId: number;
  userId: number;
  action: string;
  recordType: string;
  recordId: string;
  providerReference: string;
  updatedValue: string;
}

type VoiceMeterWriter = (row: VoiceMeterRow) => Promise<void>;

async function insertVoiceMeterRow(row: VoiceMeterRow): Promise<void> {
  await db.insert(auditLogs).values(row);
}

let writerOverride: VoiceMeterWriter | null = null;

/** Test seam. Production always inserts. A throwing writer must not fail the transcription. */
export function setVoiceMeterWriterForTests(writer: VoiceMeterWriter | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setVoiceMeterWriterForTests is only available when NODE_ENV=test");
  }
  writerOverride = writer;
}

/**
 * Best-effort. A failed insert is logged and counted, and then swallowed:
 * the caller has already paid for (or received) a transcription and must
 * still return it.
 */
export async function recordVoiceTranscriptionMeter(input: VoiceMeterInput): Promise<void> {
  const metadata = voiceMeterMetadata(input);
  const row: VoiceMeterRow = {
    brokerageId: input.brokerageId,
    userId: input.userId,
    action: AI_VOICE_TRANSCRIBED_ACTION,
    recordType: AI_VOICE_RECORD_TYPE,
    recordId: input.correlationId,
    providerReference: input.provider,
    updatedValue: JSON.stringify(metadata),
  };
  try {
    await (writerOverride ?? insertVoiceMeterRow)(row);
  } catch (err) {
    logger.error("voice_meter_write_failed", {
      brokerageId: input.brokerageId,
      userId: input.userId,
      provider: input.provider,
      outcome: input.outcome,
      correlationId: input.correlationId,
      error: err,
    });
    incrementCounter("voice_meter_write_failure_total");
  }
}
