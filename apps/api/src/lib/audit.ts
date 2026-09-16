import { db, auditLogs } from "@aee/db";
import { logger } from "@aee/events";

export interface AuditLogInput {
  brokerageId?: number;
  userId?: number;
  userEmail?: string;
  action: string;
  recordType: string;
  recordId: string;
  propertyId?: number;
  previousValue?: string;
  updatedValue?: string;
  providerReference?: string;
}

export interface AuditLogOptions {
  /**
   * Existing callers retain best-effort audit semantics. Transactional
   * consent-control writes opt into strict mode so an audit failure aborts
   * the surrounding transaction instead of leaving an unaudited source row.
   */
  strict?: boolean;
  /**
   * A transaction-owned writer. Keeping the writer injectable lets the audit
   * row participate in the same database transaction as the source/decision
   * row without changing existing callers.
   */
  write?: (input: AuditLogInput) => Promise<void>;
}

// Ported pattern from Agent Engine Staging's lib/audit.ts — used across
// every route that mutates something, feeds the Property Timeline.
export async function logAudit(input: AuditLogInput, options: AuditLogOptions = {}): Promise<void> {
  try {
    if (options.write) {
      await options.write(input);
    } else {
      await db.insert(auditLogs).values(input);
    }
  } catch (err) {
    // Historical callers remain best-effort; transactional controls opt into
    // strict mode below so their source row and audit row commit together.
    logger.error("log_audit_failed", {
      brokerageId: input.brokerageId,
      userId: input.userId,
      action: input.action,
      recordType: input.recordType,
      recordId: input.recordId,
      propertyId: input.propertyId,
      error: err,
    });
    if (options.strict) throw err;
  }
}
