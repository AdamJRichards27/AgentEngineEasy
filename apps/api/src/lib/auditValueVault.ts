// Owner t276u: before/after contact values in audit_logs are kept ENCRYPTED.
//   - AES-256-GCM; key from env AE_AUDIT_VALUE_KEY (32 bytes as 64 hex chars or base64),
//     key id from AE_AUDIT_VALUE_KEY_ID (default "k1") so keys can be rotated. The key is
//     never logged or returned. With no valid key the VALUES ARE WITHHELD (never stored in
//     plaintext): the row records only which fields changed.
//   - Envelope: "enc:v1:<kid>:<iv b64url>:<tag b64url>:<ciphertext b64url>".
//   - Ordinary audit views use maskAuditValue(): every envelope becomes "[encrypted]".
//   - Restricted read: routes/auditValues.ts (allow-listed administrators, reason required,
//     every access and refusal itself audited).
//   - Retention: AE_AUDIT_VALUE_RETENTION_DAYS (default 2555 = 7 years). After that the
//     envelope is unreadable through the API (410) and purgeExpiredAuditValues() replaces it
//     with "[expired]" (metadata — who, when, which fields — is kept).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq, like, lt, or } from "drizzle-orm";
import { auditLogs, db } from "@aee/db";

export const ENVELOPE_PREFIX = "enc:v1:";
const ENVELOPE_RE = /enc:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*/g;
export const MASK = "[encrypted]";
export const EXPIRED = "[expired]";

function keyFromEnv(): { kid: string; key: Buffer } | null {
  const raw = String(process.env.AE_AUDIT_VALUE_KEY ?? "").trim();
  if (!raw) return null;
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else {
    try {
      const b = Buffer.from(raw, "base64");
      if (b.length === 32) key = b;
    } catch {
      key = null;
    }
  }
  if (!key) return null;
  const kid = (String(process.env.AE_AUDIT_VALUE_KEY_ID ?? "k1").trim() || "k1").replace(/[^A-Za-z0-9_-]/g, "");
  return { kid, key };
}

export function auditValueKeyConfigured(): boolean {
  return keyFromEnv() !== null;
}

/** Encrypt a JSON-serialisable value. Returns null when no key is configured (caller withholds). */
export function sealAuditValue(value: unknown): string | null {
  const k = keyFromEnv();
  if (!k) return null;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k.key, iv);
  c.setAAD(Buffer.from(`${ENVELOPE_PREFIX}${k.kid}`));
  const ct = Buffer.concat([c.update(JSON.stringify(value ?? null), "utf8"), c.final()]);
  return `${ENVELOPE_PREFIX}${k.kid}:${iv.toString("base64url")}:${c.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
}

export class AuditValueUnavailable extends Error {
  constructor(public readonly reason: "NO_KEY" | "KEY_MISMATCH" | "NOT_ENCRYPTED" | "EXPIRED") {
    super(`audit value unavailable: ${reason}`);
  }
}

export function openAuditValue(envelope: string): unknown {
  if (envelope === EXPIRED) throw new AuditValueUnavailable("EXPIRED");
  if (!envelope.startsWith(ENVELOPE_PREFIX)) throw new AuditValueUnavailable("NOT_ENCRYPTED");
  const k = keyFromEnv();
  if (!k) throw new AuditValueUnavailable("NO_KEY");
  const [kid, iv, tag, ct] = envelope.slice(ENVELOPE_PREFIX.length).split(":");
  if (kid !== k.kid) throw new AuditValueUnavailable("KEY_MISMATCH");
  try {
    const d = createDecipheriv("aes-256-gcm", k.key, Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(`${ENVELOPE_PREFIX}${kid}`));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8"));
  } catch {
    throw new AuditValueUnavailable("KEY_MISMATCH");
  }
}

/** For ordinary audit screens and reports: no envelope ever leaves masked. */
export function maskAuditValue(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.replace(ENVELOPE_RE, MASK);
}

/** Field names only (no values) — safe metadata for ordinary views. */
export function fieldNames(v: unknown): string[] {
  return v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v as Record<string, unknown>).sort() : [];
}

/** Sealed representation of a before/after value: envelope, or a withheld marker (never plaintext). */
export function sealedOrWithheld(value: unknown): string | { withheld: true; fields: string[] } | null {
  if (value === undefined || value === null) return null;
  return sealAuditValue(value) ?? { withheld: true, fields: fieldNames(value) };
}

export function retentionDays(): number {
  const n = Number(process.env.AE_AUDIT_VALUE_RETENTION_DAYS ?? 2555);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2555;
}

export function isPastRetention(createdAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() > retentionDays() * 86_400_000;
}

/** Replace expired envelopes with "[expired]"; metadata stays. Returns rows changed. */
export async function purgeExpiredAuditValues(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays() * 86_400_000);
  const rows = await db
    .select({ id: auditLogs.id, previousValue: auditLogs.previousValue, updatedValue: auditLogs.updatedValue })
    .from(auditLogs)
    .where(and(lt(auditLogs.createdAt, cutoff), or(like(auditLogs.previousValue, `%${ENVELOPE_PREFIX}%`), like(auditLogs.updatedValue, `%${ENVELOPE_PREFIX}%`))));
  for (const r of rows) {
    await db
      .update(auditLogs)
      .set({ previousValue: r.previousValue?.replace(ENVELOPE_RE, EXPIRED) ?? null, updatedValue: r.updatedValue?.replace(ENVELOPE_RE, EXPIRED) ?? null })
      .where(eq(auditLogs.id, r.id));
  }
  return rows.length;
}
