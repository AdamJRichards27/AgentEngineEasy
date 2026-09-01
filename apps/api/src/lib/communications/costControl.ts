// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// SMS cost/usage controls (Section 21): soft and hard thresholds, metered
// independently per brokerage (tenant-wide) and per user (agent-level),
// independent of any AI action allowance/entitlement — this ledger has
// nothing to do with apps/api/src/lib/ai/entitlements.ts's AI usage
// metering, deliberately, since an agent manually sending SMS must be
// governed the same way whether or not AI assisted in drafting it.
//
// A hard-threshold breach blocks the send outright (BLOCKED_BY_COST_CONTROL,
// Section 9); a soft-threshold breach is recorded but does not block —
// callers (outbox.ts) surface the warning so a Brokerage Administrator can
// see spend trending toward the cap before it bites.

import { and, eq } from "drizzle-orm";
import { db, communicationCostLedger, type CommunicationCostLedgerRow } from "@aee/db";
import { getOrCreateCommunicationSettings } from "./settings.js";

// A conservative flat per-segment estimate for the sandbox/dev provider —
// real per-message cost is provider- and destination-country-specific;
// this is a planning estimate only, never presented as a real invoiced
// amount (Section 21, Section 42 — "must not fabricate ... a false sense
// of certainty").
export const SMS_ESTIMATED_COST_CENTS_PER_MESSAGE = 8;

export function currentPeriodKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function getLedgerRow(
  brokerageId: number,
  scopeType: "BROKERAGE" | "USER",
  scopeId: number,
  periodKey: string,
  channel: string,
): Promise<CommunicationCostLedgerRow | null> {
  const [row] = await db
    .select()
    .from(communicationCostLedger)
    .where(
      and(
        eq(communicationCostLedger.brokerageId, brokerageId),
        eq(communicationCostLedger.scopeType, scopeType),
        eq(communicationCostLedger.scopeId, scopeId),
        eq(communicationCostLedger.periodKey, periodKey),
        eq(communicationCostLedger.channel, channel),
      ),
    );
  return row ?? null;
}

export interface CostControlCheckResult {
  allowed: boolean;
  reason: string | null;
  softWarning: boolean;
  estimatedCostCents: number;
}

/** Section 20 step 2 (validate) / step 4 (cost check) before a channel-metered send is queued. Currently only SMS is metered — EMAIL has no per-message cost control in this build. */
export async function checkCostControl(
  brokerageId: number,
  userId: number | null,
  channel: string,
): Promise<CostControlCheckResult> {
  if (channel !== "SMS") {
    return { allowed: true, reason: null, softWarning: false, estimatedCostCents: 0 };
  }

  const settings = await getOrCreateCommunicationSettings(brokerageId);
  const periodKey = currentPeriodKey();
  const estimate = SMS_ESTIMATED_COST_CENTS_PER_MESSAGE;

  const brokerageRow = await getLedgerRow(brokerageId, "BROKERAGE", brokerageId, periodKey, "SMS");
  const brokerageProjected = (brokerageRow?.costEstimateCents ?? 0) + estimate;
  if (brokerageProjected > settings.smsHardThresholdCents) {
    return {
      allowed: false,
      reason: `Sending this SMS would exceed the brokerage's monthly SMS cost limit ($${(settings.smsHardThresholdCents / 100).toFixed(2)}).`,
      softWarning: false,
      estimatedCostCents: estimate,
    };
  }

  let userProjected = 0;
  if (userId != null) {
    const userRow = await getLedgerRow(brokerageId, "USER", userId, periodKey, "SMS");
    userProjected = (userRow?.costEstimateCents ?? 0) + estimate;
    if (userProjected > settings.smsHardThresholdCents) {
      return {
        allowed: false,
        reason: `Sending this SMS would exceed your monthly SMS cost limit ($${(settings.smsHardThresholdCents / 100).toFixed(2)}).`,
        softWarning: false,
        estimatedCostCents: estimate,
      };
    }
  }

  const softWarning = brokerageProjected > settings.smsSoftThresholdCents || userProjected > settings.smsSoftThresholdCents;
  return { allowed: true, reason: null, softWarning, estimatedCostCents: estimate };
}

/** Called once a send actually happens (outbox.ts) — records against both the brokerage-wide and the sending user's own ledger rows for the current period. */
export async function recordCost(brokerageId: number, userId: number | null, channel: string, costCents: number): Promise<void> {
  if (channel !== "SMS" || costCents <= 0) return;
  const periodKey = currentPeriodKey();

  await upsertLedger(brokerageId, "BROKERAGE", brokerageId, periodKey, "SMS", costCents);
  if (userId != null) {
    await upsertLedger(brokerageId, "USER", userId, periodKey, "SMS", costCents);
  }
}

async function upsertLedger(
  brokerageId: number,
  scopeType: "BROKERAGE" | "USER",
  scopeId: number,
  periodKey: string,
  channel: string,
  costCents: number,
): Promise<void> {
  const existing = await getLedgerRow(brokerageId, scopeType, scopeId, periodKey, channel);
  if (existing) {
    await db
      .update(communicationCostLedger)
      .set({
        messageCount: existing.messageCount + 1,
        costEstimateCents: existing.costEstimateCents + costCents,
        updatedAt: new Date(),
      })
      .where(eq(communicationCostLedger.id, existing.id));
    return;
  }
  await db
    .insert(communicationCostLedger)
    .values({ brokerageId, scopeType, scopeId, periodKey, channel, messageCount: 1, costEstimateCents: costCents })
    .onConflictDoNothing();
}

export async function getCostSummary(brokerageId: number, userId: number | null): Promise<{
  periodKey: string;
  brokerage: { messageCount: number; costEstimateCents: number };
  user: { messageCount: number; costEstimateCents: number } | null;
  softThresholdCents: number;
  hardThresholdCents: number;
}> {
  const settings = await getOrCreateCommunicationSettings(brokerageId);
  const periodKey = currentPeriodKey();
  const brokerageRow = await getLedgerRow(brokerageId, "BROKERAGE", brokerageId, periodKey, "SMS");
  const userRow = userId != null ? await getLedgerRow(brokerageId, "USER", userId, periodKey, "SMS") : null;
  return {
    periodKey,
    brokerage: { messageCount: brokerageRow?.messageCount ?? 0, costEstimateCents: brokerageRow?.costEstimateCents ?? 0 },
    user: userId != null ? { messageCount: userRow?.messageCount ?? 0, costEstimateCents: userRow?.costEstimateCents ?? 0 } : null,
    softThresholdCents: settings.smsSoftThresholdCents,
    hardThresholdCents: settings.smsHardThresholdCents,
  };
}
