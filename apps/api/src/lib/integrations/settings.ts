// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// Per-brokerage configuration for the integration layer — mirrors
// lib/communications/settings.ts's getOrCreateXSettings(brokerageId)
// pattern exactly (see Section 2's verification note in the completion
// report: this codebase's real "Brokerage Rules and Configuration Engine"
// is this repeated per-domain resolver convention, not one unified class).
// Created lazily on first read so no migration-time seed is required.
//
// enabled is the brokerage-level master switch registry.ts's
// resolveActiveConnection checks before anything else — a brokerage that
// has never explicitly turned integrations on cannot use one no matter how
// many ACTIVE connections exist (Section 4: "no connection without ...
// brokerage enablement").

import { eq } from "drizzle-orm";
import { db, integrationSettings, type IntegrationSettings } from "@aee/db";

export async function getOrCreateIntegrationSettings(brokerageId: number): Promise<IntegrationSettings> {
  const [existing] = await db.select().from(integrationSettings).where(eq(integrationSettings.brokerageId, brokerageId));
  if (existing) return existing;

  const [inserted] = await db.insert(integrationSettings).values({ brokerageId }).onConflictDoNothing().returning();
  if (inserted) return inserted;

  // Someone else's insert won the race between our SELECT and our INSERT
  // (mirrors getOrCreateCommunicationSettings' own race handling).
  const [raceWinner] = await db.select().from(integrationSettings).where(eq(integrationSettings.brokerageId, brokerageId));
  if (!raceWinner) throw new Error("Failed to create or load integration settings.");
  return raceWinner;
}

export interface UpdateIntegrationSettingsInput {
  enabled?: boolean;
  maxActiveConnections?: number;
}

export async function updateIntegrationSettings(brokerageId: number, patch: UpdateIntegrationSettingsInput): Promise<IntegrationSettings> {
  await getOrCreateIntegrationSettings(brokerageId);
  const [updated] = await db
    .update(integrationSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(integrationSettings.brokerageId, brokerageId))
    .returning();
  return updated;
}
