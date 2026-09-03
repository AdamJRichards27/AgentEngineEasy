// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// Dead-letter storage (Section 7). This module owns writes to
// integration_dead_letters only — the actual REPLAY of a dead-lettered
// item re-enters the real code path in the module that owns that path
// (outbox.ts's replayDeadLetteredCommand for OUTBOX-sourced letters,
// webhooks.ts's replayDeadLetteredWebhook for INBOX-sourced ones), which
// then calls markReplayed here. Splitting it this way avoids a circular
// import (outbox.ts/webhooks.ts both need to WRITE a dead letter; a dead-
// letter module that also imported them back to replay would create a
// cycle) while keeping "replay re-enters the exact same code path, never a
// shortcut" (Section 7) literally true — there is no dead-letter-specific
// re-implementation of a dispatch or webhook-processing effect anywhere.

import { and, eq } from "drizzle-orm";
import { db, integrationDeadLetters, type IntegrationDeadLetter } from "@aee/db";
import { logAudit } from "../audit.js";

export interface WriteDeadLetterInput {
  brokerageId: number;
  connectionId: string;
  sourceType: "OUTBOX" | "INBOX";
  sourceId: string;
  reason: string;
  payloadSnapshot: Record<string, unknown>;
}

export async function writeDeadLetter(input: WriteDeadLetterInput): Promise<IntegrationDeadLetter> {
  const [row] = await db
    .insert(integrationDeadLetters)
    .values({
      brokerageId: input.brokerageId,
      connectionId: input.connectionId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      reason: input.reason,
      payloadSnapshot: input.payloadSnapshot,
    })
    .returning();
  await logAudit({ action: "integration_dead_letter_created", recordType: "integration_dead_letter", recordId: row.id, updatedValue: input.reason });
  return row;
}

export async function loadDeadLetterInBrokerage(id: string, brokerageId: number): Promise<IntegrationDeadLetter> {
  const [row] = await db.select().from(integrationDeadLetters).where(eq(integrationDeadLetters.id, id));
  if (!row || row.brokerageId !== brokerageId) throw new Error("Dead letter not found.");
  return row;
}

export async function markReplayed(id: string, actorUserId: number, result: "SUCCESS" | "FAILED", error?: string | null): Promise<void> {
  await db
    .update(integrationDeadLetters)
    .set({ replayedAt: new Date(), replayedBy: actorUserId, replayResult: result, replayError: error ?? null })
    .where(eq(integrationDeadLetters.id, id));
  await logAudit({ userId: actorUserId, action: "integration_dead_letter_replayed", recordType: "integration_dead_letter", recordId: id, updatedValue: result });
}

export async function listDeadLettersForBrokerage(brokerageId: number): Promise<IntegrationDeadLetter[]> {
  return db.select().from(integrationDeadLetters).where(eq(integrationDeadLetters.brokerageId, brokerageId));
}
