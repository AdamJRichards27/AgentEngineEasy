// Per-brokerage WAITING_ON detection policy. Rows are optional: a brokerage
// with no row uses the code defaults. Communication Hub time zone is read
// only when this row has none of its own — it is not copied, and a missing
// communication settings row is not created.

import { eq } from "drizzle-orm";
import { communicationSettings, db, pitCrewWaitingOnSweepSettings, type PitCrewWaitingOnSweepSettings } from "@aee/db";
import {
  resolvePitCrewWaitingOnSweepSettings,
  type ResolvedPitCrewWaitingOnSweepSettings,
} from "./waitingOnDetection.js";

export interface PitCrewWaitingOnSweepSettingsPatch {
  cadenceMs?: number;
  windowStart?: string;
  windowEnd?: string;
  windowWeekdays?: string;
  timeZone?: string | null;
  attentionThresholdHours?: number;
  elevatedThresholdHours?: number;
  lastDetectionAt?: Date | null;
}

export async function loadPitCrewWaitingOnSweepSettings(
  brokerageId: number,
): Promise<ResolvedPitCrewWaitingOnSweepSettings> {
  const [row] = await db
    .select()
    .from(pitCrewWaitingOnSweepSettings)
    .where(eq(pitCrewWaitingOnSweepSettings.brokerageId, brokerageId));

  let communicationTimeZone: string | null = null;
  if (!row?.timeZone?.trim()) {
    const [comms] = await db
      .select({ timeZone: communicationSettings.timeZone })
      .from(communicationSettings)
      .where(eq(communicationSettings.brokerageId, brokerageId));
    communicationTimeZone = comms?.timeZone ?? null;
  }
  return resolvePitCrewWaitingOnSweepSettings(row ?? null, communicationTimeZone);
}

function definedPatch(patch: PitCrewWaitingOnSweepSettingsPatch): PitCrewWaitingOnSweepSettingsPatch {
  const defined: PitCrewWaitingOnSweepSettingsPatch = {};
  if (patch.cadenceMs !== undefined) defined.cadenceMs = patch.cadenceMs;
  if (patch.windowStart !== undefined) defined.windowStart = patch.windowStart;
  if (patch.windowEnd !== undefined) defined.windowEnd = patch.windowEnd;
  if (patch.windowWeekdays !== undefined) defined.windowWeekdays = patch.windowWeekdays;
  if (patch.timeZone !== undefined) defined.timeZone = patch.timeZone;
  if (patch.attentionThresholdHours !== undefined) defined.attentionThresholdHours = patch.attentionThresholdHours;
  if (patch.elevatedThresholdHours !== undefined) defined.elevatedThresholdHours = patch.elevatedThresholdHours;
  if (patch.lastDetectionAt !== undefined) defined.lastDetectionAt = patch.lastDetectionAt;
  return defined;
}

/** Insert or replace the supplied fields. Omitted fields keep the stored value, or the column default on insert. */
export async function upsertPitCrewWaitingOnSweepSettings(
  brokerageId: number,
  patch: PitCrewWaitingOnSweepSettingsPatch,
): Promise<PitCrewWaitingOnSweepSettings> {
  const now = new Date();
  const defined = definedPatch(patch);
  const [row] = await db
    .insert(pitCrewWaitingOnSweepSettings)
    .values({ brokerageId, ...defined, updatedAt: now })
    .onConflictDoUpdate({
      target: pitCrewWaitingOnSweepSettings.brokerageId,
      set: { ...defined, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error("Failed to store Pit Crew waiting-on sweep settings.");
  return row;
}

/**
 * Record that a detection run finished for this brokerage. Does not change
 * cadence, window, or thresholds on an existing row. A missing row is
 * inserted with the column defaults plus this timestamp.
 */
export async function markPitCrewWaitingOnSweepRan(brokerageId: number, now: Date): Promise<void> {
  await db
    .insert(pitCrewWaitingOnSweepSettings)
    .values({ brokerageId, lastDetectionAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: pitCrewWaitingOnSweepSettings.brokerageId,
      set: { lastDetectionAt: now, updatedAt: now },
    });
}
