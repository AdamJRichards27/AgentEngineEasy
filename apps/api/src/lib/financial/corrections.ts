// Owner t211u item 1: the ONLY path that may change a finalised financial
// record (ledger events, issued statements, receipts, payment-authority
// terms after activation, waiver and write-off records). Migration 0044's
// triggers refuse every other UPDATE (and every DELETE).
//
// A Brokerage Administrator of the record's own brokerage supplies a
// justification. In ONE transaction this service writes the audit row first
// (before/after values and the justification), sets the transaction-local
// flag aee.financial_correction_audit_id to that row's id, makes the update,
// and clears the flag. The database honours the flag only for the table and
// row the audit row names, and only when the audit row was written by the
// same transaction.
// Owner t212u item 2: exposed to Brokerage Administrators at POST /financial/corrections (screen on
// the Financial page). Supporting evidence is required: an evidence reference, or upload metadata
// (file name, sha256, size). The evidence is stored on the audit row.
import { and, desc, eq, sql } from "drizzle-orm";
import { auditLogs, db } from "@aee/db";

export const CORRECTABLE_TABLES = ["financial_ledger_events", "financial_receipts", "settlement_statements", "pc_fee_authorities", "financial_payment_requests"] as const;
export type CorrectableTable = (typeof CORRECTABLE_TABLES)[number];
const PROTECTED_COLUMNS = new Set(["id", "brokerage_id", "created_at"]);
const BA_ROLE = "Brokerage Administrator";
const MAX_JUSTIFICATION = 2000;

export type FinancialCorrectionCode =
  | "CORRECTION_FORBIDDEN"
  | "CORRECTION_JUSTIFICATION_REQUIRED"
  | "CORRECTION_TABLE_NOT_ALLOWED"
  | "CORRECTION_COLUMN_NOT_ALLOWED"
  | "CORRECTION_NOT_FOUND"
  | "CORRECTION_EMPTY"
  | "CORRECTION_EVIDENCE_REQUIRED";

export type CorrectionEvidence =
  | { kind: "reference"; ref: string }
  | { kind: "upload"; fileName: string; sha256: string; sizeBytes: number };

/** Validates the supporting evidence (reference OR upload metadata). Throws CORRECTION_EVIDENCE_REQUIRED. */
export function correctionEvidenceFrom(input: { evidenceRef?: unknown; evidenceUpload?: unknown }): CorrectionEvidence {
  const ref = typeof input.evidenceRef === "string" ? input.evidenceRef.trim() : "";
  if (ref.length >= 3 && ref.length <= 500) return { kind: "reference", ref };
  const u = input.evidenceUpload as { fileName?: unknown; sha256?: unknown; sizeBytes?: unknown } | undefined;
  if (u && typeof u === "object") {
    const fileName = typeof u.fileName === "string" ? u.fileName.trim() : "";
    const sha256 = typeof u.sha256 === "string" ? u.sha256.trim().toLowerCase() : "";
    const sizeBytes = typeof u.sizeBytes === "number" ? u.sizeBytes : NaN;
    if (fileName.length >= 1 && fileName.length <= 255 && /^[0-9a-f]{64}$/.test(sha256) && Number.isSafeInteger(sizeBytes) && sizeBytes > 0) {
      return { kind: "upload", fileName, sha256, sizeBytes };
    }
  }
  throw new FinancialCorrectionRefusal("CORRECTION_EVIDENCE_REQUIRED", "Supporting evidence is required: an evidence reference, or upload metadata (file name, sha256, size).");
}

export class FinancialCorrectionRefusal extends Error {
  constructor(
    readonly code: FinancialCorrectionCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CorrectionActor {
  id: number;
  role: string;
  brokerageId: number;
}
export type CorrectionValue = string | number | boolean | null;

export async function correctFinancialRecord(
  actor: CorrectionActor,
  input: { table: CorrectableTable; id: number; patch: Record<string, CorrectionValue>; justification: string; evidence: CorrectionEvidence },
): Promise<{ auditId: number }> {
  if (actor.role !== BA_ROLE || !Number.isSafeInteger(actor.id) || actor.id <= 0) {
    throw new FinancialCorrectionRefusal("CORRECTION_FORBIDDEN", "Only a Brokerage Administrator can correct a finalised financial record.");
  }
  const justification = (input.justification ?? "").trim();
  if (!justification || justification.length > MAX_JUSTIFICATION) {
    throw new FinancialCorrectionRefusal("CORRECTION_JUSTIFICATION_REQUIRED", "A justification (1-2000 characters) is required.");
  }
  const evidence = correctionEvidenceFrom(input.evidence?.kind === "reference" ? { evidenceRef: input.evidence.ref } : { evidenceUpload: input.evidence });
  if (!(CORRECTABLE_TABLES as readonly string[]).includes(input.table)) {
    throw new FinancialCorrectionRefusal("CORRECTION_TABLE_NOT_ALLOWED", "That record type cannot be corrected here.");
  }
  if (!Number.isSafeInteger(input.id) || input.id <= 0) throw new FinancialCorrectionRefusal("CORRECTION_NOT_FOUND", "Not found.");
  const columns = Object.keys(input.patch ?? {});
  if (columns.length === 0) throw new FinancialCorrectionRefusal("CORRECTION_EMPTY", "Nothing to correct.");

  return db.transaction(async (tx) => {
    const known = await tx.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${input.table}`,
    );
    const knownSet = new Set(known.rows.map((r) => r.column_name));
    for (const c of columns) {
      if (PROTECTED_COLUMNS.has(c) || !knownSet.has(c)) {
        throw new FinancialCorrectionRefusal("CORRECTION_COLUMN_NOT_ALLOWED", `Column ${c} cannot be corrected.`);
      }
    }
    const table = sql.identifier(input.table);
    const selectCols = sql.join(columns.map((c) => sql.identifier(c)), sql`, `);
    const current = await tx.execute<Record<string, unknown>>(sql`select ${selectCols} from ${table} where id = ${input.id} and brokerage_id = ${actor.brokerageId} for update`);
    const before = current.rows[0];
    if (!before) throw new FinancialCorrectionRefusal("CORRECTION_NOT_FOUND", "Not found.");

    const [audit] = await tx
      .insert(auditLogs)
      .values({
        brokerageId: actor.brokerageId,
        userId: actor.id,
        action: "financial_record_correction",
        recordType: input.table,
        recordId: String(input.id),
        previousValue: JSON.stringify(before),
        updatedValue: JSON.stringify({ patch: input.patch, justification, evidence, correctedByRole: actor.role }),
      })
      .returning({ id: auditLogs.id });

    await tx.execute(sql`select set_config('aee.financial_correction_audit_id', ${String(audit!.id)}, true)`);
    const assignments = sql.join(columns.map((c) => sql`${sql.identifier(c)} = ${input.patch[c]}`), sql`, `);
    await tx.execute(sql`update ${table} set ${assignments} where id = ${input.id} and brokerage_id = ${actor.brokerageId}`);
    await tx.execute(sql`select set_config('aee.financial_correction_audit_id', '', true)`);
    return { auditId: audit!.id };
  });
}

/** BA-only list of corrections for the actor's own brokerage (newest first). */
export async function listFinancialCorrections(actor: CorrectionActor) {
  if (actor.role !== BA_ROLE) throw new FinancialCorrectionRefusal("CORRECTION_FORBIDDEN", "Only a Brokerage Administrator can view corrections.");
  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.brokerageId, actor.brokerageId), eq(auditLogs.action, "financial_record_correction")))
    .orderBy(desc(auditLogs.id))
    .limit(200);
  return rows.map((r) => {
    const v = JSON.parse(r.updatedValue ?? "{}") as { patch?: unknown; justification?: string; evidence?: CorrectionEvidence };
    return { auditId: r.id, table: r.recordType, recordId: r.recordId, correctedByUserId: r.userId, correctedAt: r.createdAt, before: JSON.parse(r.previousValue ?? "{}"), patch: v.patch, reason: v.justification, evidence: v.evidence ?? null };
  });
}
