import { db, auditLogs } from "@aee/db";
import { logger } from "@aee/events";

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
    logger.error("log_audit_failed", { userId: input.userId, action: input.action, recordType: input.recordType, recordId: input.recordId, propertyId: input.propertyId, error: err });
  }
}
