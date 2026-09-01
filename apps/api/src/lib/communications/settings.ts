// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// Per-brokerage configuration (cost thresholds, quiet hours, the
// transactional opt-out exemption knob — Sections 16, 21, 22). Created
// lazily on first read so no migration-time seed is required for every
// existing brokerage; every subsequent read/write goes through this one
// module so the row is never raced into existing twice.

import { eq } from "drizzle-orm";
import { db, communicationSettings, type CommunicationSettings } from "@aee/db";

export async function getOrCreateCommunicationSettings(brokerageId: number): Promise<CommunicationSettings> {
  const [existing] = await db.select().from(communicationSettings).where(eq(communicationSettings.brokerageId, brokerageId));
  if (existing) return existing;

  const [inserted] = await db
    .insert(communicationSettings)
    .values({ brokerageId })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;

  // Someone else's insert won the race between our SELECT and our INSERT.
  const [raceWinner] = await db.select().from(communicationSettings).where(eq(communicationSettings.brokerageId, brokerageId));
  if (!raceWinner) throw new Error("Failed to create or load communication settings.");
  return raceWinner;
}

export interface UpdateCommunicationSettingsInput {
  timeZone?: string | null;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  smsSoftThresholdCents?: number;
  smsHardThresholdCents?: number;
  transactionalOptOutAllowed?: boolean;
}

export async function updateCommunicationSettings(
  brokerageId: number,
  patch: UpdateCommunicationSettingsInput,
): Promise<CommunicationSettings> {
  await getOrCreateCommunicationSettings(brokerageId);
  const [updated] = await db
    .update(communicationSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(communicationSettings.brokerageId, brokerageId))
    .returning();
  return updated;
}
