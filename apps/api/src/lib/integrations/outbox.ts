// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// The transactional outbox (Section 5): enqueue -> dispatch -> record ->
// retry-or-dead-letter, mirroring lib/communications/outbox.ts's own
// dispatchMessage/dispatchDueMessages flow and financial_payment_outbox's
// attempts/backoff convention. Every dispatch goes through
// registry.ts's resolveActiveConnection first — there is no path from
// "a command sits in this table" to "a provider call happens" that skips
// the fail-closed connection check (Section 4).

import { and, eq, isNull, lte, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, integrationOutbox, integrationOutboxAttempts, type IntegrationOutboxRow } from "@aee/db";
import { publishDomainEvent, currentCorrelationId, runWithCorrelationId, logger, incrementCounter } from "@aee/events";
import { resolveActiveConnection, getAdapter } from "./registry.js";
import { writeDeadLetter, markReplayed, loadDeadLetterInBrokerage } from "./deadLetters.js";
import { isRetryableIntegrationFailure, IntegrationError, type IntegrationCapability } from "./types.js";

export interface EnqueueCommandInput {
  brokerageId: number;
  connectionId: string;
  capability: IntegrationCapability;
  commandPayload: Record<string, unknown>;
  idempotencyKey: string;
  sourceRecordType: string;
  sourceRecordId: string;
  correlationId?: string;
  causationId?: string | null;
}

/**
 * Idempotent by idempotencyKey (Section 5) — a re-enqueue with the same
 * key returns the existing row rather than creating a duplicate command,
 * mirroring launchPlans' own unique-index-plus-23505-catch idempotency
 * pattern (lib/launch/model.ts's getOrCreateLaunchPlan).
 */
export async function enqueueCommand(input: EnqueueCommandInput): Promise<IntegrationOutboxRow> {
  try {
    const [created] = await db
      .insert(integrationOutbox)
      .values({
        brokerageId: input.brokerageId,
        connectionId: input.connectionId,
        capability: input.capability,
        commandPayload: input.commandPayload,
        idempotencyKey: input.idempotencyKey,
        sourceRecordType: input.sourceRecordType,
        sourceRecordId: input.sourceRecordId,
        correlationId: input.correlationId ?? currentCorrelationId(),
        causationId: input.causationId ?? null,
      })
      .returning();
    return created;
  } catch (err: any) {
    if (err?.code === "23505") {
      const [existing] = await db.select().from(integrationOutbox).where(eq(integrationOutbox.idempotencyKey, input.idempotencyKey));
      if (existing) return existing;
    }
    throw err;
  }
}

const MAX_BACKOFF_MS = 30 * 60_000;
function backoffMs(attemptNumber: number): number {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (attemptNumber - 1));
}

/**
 * One dispatch attempt for a PENDING/RETRY_SCHEDULED command. Step 2
 * hardening: re-establishes the command's OWN stored correlationId (set at
 * enqueue time — see enqueueCommand above) as the ambient context for this
 * entire attempt, via runWithCorrelationId. This is what makes the
 * "Retry-to-dead-letter" and "Authorised replay" proof flows work: a
 * command enqueued under correlationId X keeps that same X on every
 * retry attempt and on its eventual dead-letter/replay outcome, however
 * many attempts and however much backoff happens in between — the whole
 * lifecycle of one command is one traceable chain, not a new disconnected
 * id per attempt.
 */
export async function dispatchCommand(outboxId: string): Promise<IntegrationOutboxRow> {
  const [existing] = await db.select().from(integrationOutbox).where(eq(integrationOutbox.id, outboxId));
  if (!existing) throw new IntegrationError("NOT_FOUND", "Outbox command not found.");
  if (existing.status !== "PENDING" && existing.status !== "RETRY_SCHEDULED") {
    throw new IntegrationError("INVALID_STATUS", `Cannot dispatch a command in status ${existing.status}.`);
  }
  return runWithCorrelationId(existing.correlationId, () => dispatchCommandInner(outboxId));
}

async function dispatchCommandInner(outboxId: string): Promise<IntegrationOutboxRow> {
  const [dispatching] = await db.update(integrationOutbox).set({ status: "DISPATCHING", updatedAt: new Date() }).where(eq(integrationOutbox.id, outboxId)).returning();
  const attemptNumber = dispatching.attempts + 1;
  logger.info("integration_outbox_dispatch_attempt_started", { outboxId, attemptNumber, capability: dispatching.capability, connectionId: dispatching.connectionId, brokerageId: dispatching.brokerageId });

  let resolved;
  try {
    resolved = await resolveActiveConnection(dispatching.brokerageId, dispatching.connectionId, dispatching.capability as IntegrationCapability);
  } catch (err) {
    // A connection that stopped being usable mid-flight (suspended/revoked
    // between enqueue and dispatch) is a PERMANENT stop, never retried —
    // fail-closed applies to dispatch time, not just enqueue time.
    return failCommand(dispatching, attemptNumber, "PERMANENT_REJECTION", err instanceof Error ? err.message : "Connection is no longer usable.", false);
  }

  const adapter = getAdapter(resolved.connection.providerId);
  if (!adapter) {
    return failCommand(dispatching, attemptNumber, "PERMANENT_REJECTION", `No adapter registered for provider ${resolved.connection.providerId}.`, false);
  }

  let result;
  try {
    result = await adapter.send(dispatching.capability as IntegrationCapability, dispatching.commandPayload as Record<string, unknown>, {
      connectionId: dispatching.connectionId,
      brokerageId: dispatching.brokerageId,
      idempotencyKey: dispatching.idempotencyKey,
    });
  } catch (err) {
    result = {
      status: "FAILED" as const,
      providerReference: null,
      failureCategory: "TRANSIENT_PROVIDER_ERROR" as const,
      failureDetail: err instanceof Error ? err.message : "Adapter threw an unexpected error.",
      responseSummary: "Adapter threw.",
    };
  }

  await db.insert(integrationOutboxAttempts).values({
    outboxId,
    attemptNumber,
    status: result.status,
    providerResponseSummary: result.responseSummary.slice(0, 500),
    errorDetail: result.status === "FAILED" ? result.failureDetail : null,
  });

  if (result.status === "SENT") {
    const [sent] = await db.update(integrationOutbox).set({ status: "SENT", attempts: attemptNumber, dispatchedAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(integrationOutbox.id, outboxId)).returning();
    logger.info("integration_outbox_dispatch_sent", { outboxId, attemptNumber });
    incrementCounter("integration_outbox_dispatch_total", { capability: dispatching.capability as string, outcome: "success" });
    return sent;
  }

  const retryable = isRetryableIntegrationFailure(result.failureCategory) && attemptNumber < dispatching.maxAttempts;
  if (retryable) {
    const [rescheduled] = await db
      .update(integrationOutbox)
      .set({ status: "RETRY_SCHEDULED", attempts: attemptNumber, lastError: result.failureDetail, nextAttemptAt: new Date(Date.now() + backoffMs(attemptNumber)), updatedAt: new Date() })
      .where(eq(integrationOutbox.id, outboxId))
      .returning();
    logger.warn("integration_outbox_retry_scheduled", { outboxId, attemptNumber, nextAttemptAt: rescheduled.nextAttemptAt, failureCategory: result.failureCategory, failureDetail: result.failureDetail });
    incrementCounter("integration_outbox_dispatch_total", { capability: dispatching.capability as string, outcome: "retry_scheduled" });
    return rescheduled;
  }

  return failCommand(dispatching, attemptNumber, result.failureCategory ?? "PERMANENT_REJECTION", result.failureDetail ?? "Permanent failure.", true);
}

async function failCommand(command: IntegrationOutboxRow, attemptNumber: number, reason: string, detail: string, alreadyRecordedAttempt: boolean): Promise<IntegrationOutboxRow> {
  if (!alreadyRecordedAttempt) {
    await db.insert(integrationOutboxAttempts).values({ outboxId: command.id, attemptNumber, status: "FAILED", errorDetail: detail });
  }
  const [failed] = await db.update(integrationOutbox).set({ status: "DEAD_LETTERED", attempts: attemptNumber, lastError: detail, updatedAt: new Date() }).where(eq(integrationOutbox.id, command.id)).returning();
  await writeDeadLetter({
    brokerageId: command.brokerageId,
    connectionId: command.connectionId,
    sourceType: "OUTBOX",
    sourceId: command.id,
    reason: `${reason}: ${detail}`,
    payloadSnapshot: { capability: command.capability, commandPayload: command.commandPayload, sourceRecordType: command.sourceRecordType, sourceRecordId: command.sourceRecordId },
  });
  await publishDomainEvent({
    eventType: "INTEGRATION_COMMAND_DEAD_LETTERED" as any,
    occurredAt: new Date(),
    propertyId: null,
    transactionId: null,
    partyId: null,
    brokerageId: command.brokerageId,
    agentId: null,
    actorType: "SYSTEM",
    actorId: null,
    source: "integrations:outbox",
    correlationId: command.correlationId ?? currentCorrelationId(),
    causationId: command.causationId ?? null,
    // Includes attemptNumber, not just the outbox row id: a replay
    // (replayDeadLetteredCommand below) that fails again permanently calls
    // failCommand a second time for the SAME outbox row. attempts is never
    // reset across a replay (only status/nextAttemptAt are), so
    // attemptNumber strictly increases across the row's whole lifetime —
    // using it here keeps each real dead-lettering occurrence as its own
    // event instead of silently colliding with (and losing) the first one
    // on domain_events' idempotency-key uniqueness constraint.
    idempotencyKey: `INTEGRATION_COMMAND_DEAD_LETTERED:${command.id}:${attemptNumber}`,
    payload: { outboxId: command.id, connectionId: command.connectionId, capability: command.capability, reason },
    metadata: {},
  }).catch((err) => logger.error("publish_domain_event_failed", { eventType: "INTEGRATION_COMMAND_DEAD_LETTERED", error: err instanceof Error ? err.message : String(err) }));
  logger.error("integration_outbox_dead_lettered", { outboxId: command.id, attemptNumber, reason, detail });
  incrementCounter("integration_outbox_dispatch_total", { capability: command.capability as string, outcome: "failure" });
  incrementCounter("integration_dead_letter_total", { source_type: "OUTBOX" });
  return failed;
}

/** Boot-time / on-demand sweep — every PENDING or RETRY_SCHEDULED command whose nextAttemptAt has elapsed gets one dispatch attempt (mirrors dispatchDueMessages). */
export async function dispatchDueOutbox(now: Date = new Date()): Promise<{ dispatchedCount: number; errorCount: number }> {
  const due = await db
    .select()
    .from(integrationOutbox)
    .where(and(or(eq(integrationOutbox.status, "PENDING"), eq(integrationOutbox.status, "RETRY_SCHEDULED")), lte(integrationOutbox.nextAttemptAt, now)));

  let dispatchedCount = 0;
  let errorCount = 0;
  for (const command of due) {
    try {
      await dispatchCommand(command.id);
      dispatchedCount++;
    } catch (err) {
      errorCount++;
      logger.error("integration_outbox_dispatch_due_failed", { outboxId: command.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { dispatchedCount, errorCount };
}

/**
 * Controlled replay (Section 7) — re-enters dispatchCommand exactly, the
 * same function every normal dispatch uses. The dead-lettered row itself
 * is reset to PENDING first so dispatchCommand's own status guard accepts
 * it, then dispatched for real (not a simulated/short-circuited "replay
 * result").
 */
export async function replayDeadLetteredCommand(deadLetterId: string, brokerageId: number, actor: { id: number }): Promise<IntegrationOutboxRow> {
  const letter = await loadDeadLetterInBrokerage(deadLetterId, brokerageId);
  if (letter.sourceType !== "OUTBOX") throw new IntegrationError("VALIDATION", "This dead letter is not an outbox command.");

  const [reset] = await db
    .update(integrationOutbox)
    .set({ status: "PENDING", nextAttemptAt: new Date(), updatedAt: new Date() })
    .where(and(eq(integrationOutbox.id, letter.sourceId), eq(integrationOutbox.status, "DEAD_LETTERED")))
    .returning();
  if (!reset) throw new IntegrationError("INVALID_STATUS", "The original outbox command is not currently dead-lettered.");

  try {
    // dispatchCommand re-establishes reset.correlationId (== the original
    // command's correlationId, untouched by the DEAD_LETTERED -> PENDING
    // reset above) as the ambient context for this attempt — so this
    // replay's dispatch, and its SENT/DEAD_LETTERED outcome, land under the
    // exact same correlationId as the command's original enqueue and every
    // prior attempt. See dispatchCommand's own comment.
    const result = await dispatchCommand(reset.id);
    await markReplayed(deadLetterId, actor.id, result.status === "SENT" ? "SUCCESS" : "FAILED", result.status === "SENT" ? null : result.lastError);
    logger.info("integration_outbox_replayed", { deadLetterId, outboxId: reset.id, actorId: actor.id, outcome: result.status === "SENT" ? "SUCCESS" : "FAILED", correlationId: reset.correlationId });
    incrementCounter("integration_replay_total", { outcome: result.status === "SENT" ? "success" : "failure" });
    return result;
  } catch (err) {
    await markReplayed(deadLetterId, actor.id, "FAILED", err instanceof Error ? err.message : "Replay threw an unexpected error.");
    logger.error("integration_outbox_replay_failed", { deadLetterId, outboxId: reset.id, actorId: actor.id, error: err instanceof Error ? err.message : String(err), correlationId: reset.correlationId });
    incrementCounter("integration_replay_total", { outcome: "failure" });
    throw err;
  }
}

export function mintIdempotencyKey(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}
