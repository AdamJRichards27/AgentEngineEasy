import { db, auditLogs } from "@aee/db";

// Ported pattern from Agent Engine Staging's lib/audit.ts — used across
// every route that mutates something, feeds the Property Timeline.
export async function logAudit(input: {
  userId?: number;
  userEmail?: string;
  action: string;
  recordType: string;
  recordId: string;
  propertyId?: number;
  previousValue?: string;
  updatedValue?: string;
  providerReference?: string;
}): Promise<void> {
  try {
    await db.insert(auditLogs).values(input);
  } catch (err) {
    // Never let audit logging break the business transaction it's describing.
    console.error("logAudit failed", err);
  }
}
