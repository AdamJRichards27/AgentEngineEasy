// Agent Engine 2.0 — Workflow Automation Engine (Stage 2: Controlled
// Production Workflows).
//
// Domain service layer over automation_attention_items — backs the
// RAISE_ATTENTION_ITEM and REQUEST_ACTION_APPROVAL registered actions
// (apps/api/src/lib/ai/actions/registry.ts). This is Stage 2's smallest
// compatible interface onto the future Exception & Risk Engine (Build
// Instructions §7): a durable, tenant-scoped, auditable record that a
// workflow could not safely proceed and why — not the full
// exception-routing/escalation/ownership system a real Exception & Risk
// Engine would eventually own. See docs/stage-wf/WF3_STAGE2_CONTROLLED_WORKFLOWS.md
// §7 for the documented future integration point (packages/events'
// EXCEPTION_CREATED/EXCEPTION_RESOLVED event types already exist in the
// canonical catalogue with zero publishers — a future Exception & Risk
// Engine build is expected to both publish those events AND read/absorb
// this table, not replace it out from under existing rows).

import { and, eq } from "drizzle-orm";
import { db, automationAttentionItems, properties, type AutomationAttentionItem } from "@aee/db";
import { logAudit } from "../audit.js";
import type { AutomationAttentionReasonCode } from "./types.js";

export interface RaiseAttentionItemInput {
  brokerageId: number;
  propertyId: number;
  transactionId?: number | null;
  reasonCode: AutomationAttentionReasonCode;
  summary: string;
  detail?: Record<string, unknown> | null;
  originatingEventId?: string | null;
  originatingExecutionId?: string | null;
}

export type RaiseAttentionItemOutcome = "CREATED" | "ALREADY_OPEN";

export interface RaiseAttentionItemResult {
  item: AutomationAttentionItem;
  outcome: RaiseAttentionItemOutcome;
}

/**
 * Idempotent: "do not silently discard these conditions" (Build
 * Instructions §7) is satisfied by ensuring exactly one durable, auditable
 * OPEN row exists per (property-or-transaction, reasonCode) — not by
 * re-raising a fresh row every time the same underlying problem is
 * re-evaluated (e.g. a settlement reschedule that is STILL missing a date
 * would otherwise raise a new attention item on every SETTLEMENT_SCHEDULED
 * redelivery).
 */
export async function raiseAttentionItem(input: RaiseAttentionItemInput): Promise<RaiseAttentionItemResult> {
  const [property] = await db.select().from(properties).where(eq(properties.id, input.propertyId));
  if (!property || property.brokerageId !== input.brokerageId) {
    throw new Error("Property not found in this brokerage.");
  }

  const [existingOpen] = input.transactionId
    ? await db
        .select()
        .from(automationAttentionItems)
        .where(
          and(
            eq(automationAttentionItems.transactionId, input.transactionId),
            eq(automationAttentionItems.reasonCode, input.reasonCode),
            eq(automationAttentionItems.status, "OPEN"),
          ),
        )
    : await db
        .select()
        .from(automationAttentionItems)
        .where(
          and(
            eq(automationAttentionItems.propertyId, input.propertyId),
            eq(automationAttentionItems.reasonCode, input.reasonCode),
            eq(automationAttentionItems.status, "OPEN"),
          ),
        );

  if (existingOpen) {
    return { item: existingOpen, outcome: "ALREADY_OPEN" };
  }

  const [item] = await db
    .insert(automationAttentionItems)
    .values({
      brokerageId: input.brokerageId,
      propertyId: input.propertyId,
      transactionId: input.transactionId ?? null,
      reasonCode: input.reasonCode,
      summary: input.summary,
      detail: input.detail ?? null,
      status: "OPEN",
      originatingEventId: input.originatingEventId ?? null,
      originatingExecutionId: input.originatingExecutionId ?? null,
    })
    .returning();

  await logAudit({
    action: "automation_attention_item_raised",
    recordType: "automation_attention_item",
    recordId: item.id,
    propertyId: input.propertyId,
    updatedValue: input.summary,
  });

  return { item, outcome: "CREATED" };
}

export async function resolveAttentionItem(input: {
  brokerageId: number;
  attentionItemId: string;
  resolvedByUserId: number;
  resolutionNote?: string | null;
}): Promise<AutomationAttentionItem> {
  const [existing] = await db.select().from(automationAttentionItems).where(eq(automationAttentionItems.id, input.attentionItemId));
  if (!existing || existing.brokerageId !== input.brokerageId) {
    throw new Error("Attention item not found in this brokerage.");
  }
  if (existing.status === "RESOLVED") return existing;

  const [updated] = await db
    .update(automationAttentionItems)
    .set({
      status: "RESOLVED",
      resolvedByUserId: input.resolvedByUserId,
      resolvedAt: new Date(),
      resolutionNote: input.resolutionNote ?? null,
      updatedAt: new Date(),
    })
    .where(eq(automationAttentionItems.id, existing.id))
    .returning();

  await logAudit({
    userId: input.resolvedByUserId,
    action: "automation_attention_item_resolved",
    recordType: "automation_attention_item",
    recordId: updated.id,
    propertyId: updated.propertyId,
    updatedValue: input.resolutionNote ?? "",
  });

  return updated;
}
