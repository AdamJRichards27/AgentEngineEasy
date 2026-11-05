// Owner t276u/t277u: before/after contact values in audit_logs are kept ENCRYPTED.
//   Keys (never logged, printed or returned):
//     AE_AUDIT_VALUE_KEYS            "kid:key,kid:key" — versioned key ring (key = 64 hex chars or
//                                    base64 of 32 bytes). Old versions stay here until retired.
//     AE_AUDIT_VALUE_ACTIVE_KEY_ID   kid used for NEW envelopes.
//     AE_AUDIT_VALUE_KEY / _KEY_ID   single-key form (t276u), still accepted as one ring entry.
//   With no usable ACTIVE key the VALUES ARE NOT STORED (field names only) — never plaintext.
//   Envelope: "enc:v1:<kid>:<iv>:<tag>:<ciphertext>" (base64url; AAD binds the kid).
//   Retention (AUDIT-POLICY.md): values 730 days (2 years) by default. A different period needs a
//     documented basis: AE_AUDIT_VALUE_RETENTION_DAYS + AE_AUDIT_VALUE_RETENTION_BASIS (without
//     the basis the default applies). Metadata is kept 7 years (AUDIT_METADATA_RETENTION_DAYS);
//     nothing here deletes metadata.
//   Rotation (KEY-MANAGEMENT.md): rotateAuditValueKeys() re-encrypts every envelope not under
//     the active kid; verifyAuditValueKeys() decrypts every envelope; retireAuditValueKey(kid)
//     refuses unless no envelope uses kid and every envelope verifies. All are idempotent and
//     write run records to audit_logs.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq, like, lt, or } from "drizzle-orm";
import { auditLogs, db } from "@aee/db";
import { logger } from "@aee/events";

export const ENVELOPE_PREFIX = "enc:v1:";
const ENVELOPE_RE = /enc:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*/g;
export const MASK = "[encrypted]";
export const EXPIRED = "[expired]";
export const DEFAULT_VALUE_RETENTION_DAYS = 730;
export const AUDIT_METADATA_RETENTION_DAYS = 2555;

function parseKey(raw: string): Buffer | null {
  const t = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, "hex");
  try {
    const b = Buffer.from(t, "base64");
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}
const cleanKid = (k: string) => k.trim().replace(/[^A-Za-z0-9_-]/g, "");

/** The key ring from env. Keys never leave this module. */
function keyRing(): { ring: Map<string, Buffer>; active: string | null } {
  const ring = new Map<string, Buffer>();
  for (const entry of String(process.env.AE_AUDIT_VALUE_KEYS ?? "").split(",")) {
    const i = entry.indexOf(":");
    if (i <= 0) continue;
    const kid = cleanKid(entry.slice(0, i));
    const key = parseKey(entry.slice(i + 1));
    if (kid && key) ring.set(kid, key);
  }
  const single = parseKey(String(process.env.AE_AUDIT_VALUE_KEY ?? ""));
  const singleKid = cleanKid(String(process.env.AE_AUDIT_VALUE_KEY_ID ?? "k1")) || "k1";
  if (single && !ring.has(singleKid)) ring.set(singleKid, single);
  const wanted = cleanKid(String(process.env.AE_AUDIT_VALUE_ACTIVE_KEY_ID ?? ""));
  const active = wanted ? (ring.has(wanted) ? wanted : null) : single ? singleKid : ring.size ? [...ring.keys()][0] : null;
  return { ring, active };
}

export function auditValueKeyConfigured(): boolean {
  return keyRing().active !== null;
}
/** Key ids only (never key material) — for operator status output. */
export function auditValueKeyStatus(): { activeKid: string | null; kids: string[] } {
  const { ring, active } = keyRing();
  return { activeKid: active, kids: [...ring.keys()].sort() };
}

function sealWith(kid: string, key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(`${ENVELOPE_PREFIX}${kid}`));
  const ct = Buffer.concat([c.update(JSON.stringify(value ?? null), "utf8"), c.final()]);
  return `${ENVELOPE_PREFIX}${kid}:${iv.toString("base64url")}:${c.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
}

/** Encrypt under the active key. Returns null when no active key is available (caller withholds). */
export function sealAuditValue(value: unknown): string | null {
  const { ring, active } = keyRing();
  if (!active) return null;
  return sealWith(active, ring.get(active)!, value);
}

export class AuditValueUnavailable extends Error {
  constructor(public readonly reason: "NO_KEY" | "KEY_MISMATCH" | "NOT_ENCRYPTED" | "EXPIRED") {
    super(`audit value unavailable: ${reason}`);
  }
}

export function envelopeKid(envelope: string): string | null {
  return envelope.startsWith(ENVELOPE_PREFIX) ? envelope.slice(ENVELOPE_PREFIX.length).split(":")[0] ?? null : null;
}

export function openAuditValue(envelope: string): unknown {
  if (envelope === EXPIRED) throw new AuditValueUnavailable("EXPIRED");
  if (!envelope.startsWith(ENVELOPE_PREFIX)) throw new AuditValueUnavailable("NOT_ENCRYPTED");
  const [kid, iv, tag, ct] = envelope.slice(ENVELOPE_PREFIX.length).split(":");
  const key = keyRing().ring.get(kid);
  if (!key) throw new AuditValueUnavailable("NO_KEY");
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
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

export function fieldNames(v: unknown): string[] {
  return v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v as Record<string, unknown>).sort() : [];
}

export function sealedOrWithheld(value: unknown): string | { withheld: true; fields: string[] } | null {
  if (value === undefined || value === null) return null;
  return sealAuditValue(value) ?? { withheld: true, fields: fieldNames(value) };
}

/** Value retention: 730 days unless a different period AND its documented basis are configured. */
export function retentionDays(): number {
  const raw = process.env.AE_AUDIT_VALUE_RETENTION_DAYS;
  const basis = String(process.env.AE_AUDIT_VALUE_RETENTION_BASIS ?? "").trim();
  if (raw === undefined || raw === "") return DEFAULT_VALUE_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_VALUE_RETENTION_DAYS;
  if (Math.floor(n) !== DEFAULT_VALUE_RETENTION_DAYS && basis.length < 10) {
    logger.warn("audit_value_retention_basis_missing", { configuredDays: Math.floor(n), appliedDays: DEFAULT_VALUE_RETENTION_DAYS });
    return DEFAULT_VALUE_RETENTION_DAYS;
  }
  return Math.floor(n);
}

export function isPastRetention(createdAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() > retentionDays() * 86_400_000;
}

const envelopeRows = () =>
  db
    .select({ id: auditLogs.id, previousValue: auditLogs.previousValue, updatedValue: auditLogs.updatedValue, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(or(like(auditLogs.previousValue, `%${ENVELOPE_PREFIX}%`), like(auditLogs.updatedValue, `%${ENVELOPE_PREFIX}%`)))
    .orderBy(auditLogs.id);

async function runRecord(action: string, detail: Record<string, unknown>): Promise<void> {
  await db.insert(auditLogs).values({ brokerageId: null, userId: null, action, recordType: "audit_value_keys", recordId: "system", updatedValue: JSON.stringify({ ...detail, at: new Date().toISOString() }) });
}

/**
 * Replace expired envelopes with "[expired]" (metadata kept). Row by row, compare-and-set, so a
 * crash or retry never double-processes or loses a row. `failOn` is a test hook (row ids that throw).
 */
export async function purgeExpiredAuditValues(now: Date = new Date(), opts: { failOn?: Set<number> } = {}): Promise<{ examined: number; purged: number; failed: number[] }> {
  const cutoff = new Date(now.getTime() - retentionDays() * 86_400_000);
  const rows = await db
    .select({ id: auditLogs.id, previousValue: auditLogs.previousValue, updatedValue: auditLogs.updatedValue })
    .from(auditLogs)
    .where(and(lt(auditLogs.createdAt, cutoff), or(like(auditLogs.previousValue, `%${ENVELOPE_PREFIX}%`), like(auditLogs.updatedValue, `%${ENVELOPE_PREFIX}%`))));
  let purged = 0;
  const failed: number[] = [];
  for (const r of rows) {
    try {
      if (opts.failOn?.has(r.id)) throw new Error("injected failure");
      const res = await db
        .update(auditLogs)
        .set({ previousValue: r.previousValue?.replace(ENVELOPE_RE, EXPIRED) ?? null, updatedValue: r.updatedValue?.replace(ENVELOPE_RE, EXPIRED) ?? null })
        .where(and(eq(auditLogs.id, r.id), r.updatedValue === null ? eq(auditLogs.id, r.id) : eq(auditLogs.updatedValue, r.updatedValue)))
        .returning({ id: auditLogs.id });
      if (res.length) purged++;
    } catch {
      failed.push(r.id);
    }
  }
  return { examined: rows.length, purged, failed };
}

function reencryptText(text: string | null, activeKid: string): { text: string | null; changed: boolean } {
  if (!text) return { text, changed: false };
  let changed = false;
  const out = text.replace(ENVELOPE_RE, (env) => {
    if (envelopeKid(env) === activeKid) return env;
    const value = openAuditValue(env);
    changed = true;
    return sealAuditValue(value)!;
  });
  return { text: out, changed };
}

/** Re-encrypt every envelope not under the active key. Idempotent; compare-and-set per row. */
export async function rotateAuditValueKeys(opts: { failOn?: Set<number> } = {}): Promise<{ activeKid: string; examined: number; reencrypted: number; failed: number[] }> {
  const { active } = keyRing();
  if (!active) throw new AuditValueUnavailable("NO_KEY");
  const rows = await envelopeRows();
  let reencrypted = 0;
  const failed: number[] = [];
  for (const r of rows) {
    try {
      if (opts.failOn?.has(r.id)) throw new Error("injected failure");
      const p = reencryptText(r.previousValue, active);
      const u = reencryptText(r.updatedValue, active);
      if (!p.changed && !u.changed) continue;
      const res = await db
        .update(auditLogs)
        .set({ previousValue: p.text, updatedValue: u.text })
        .where(and(eq(auditLogs.id, r.id), r.updatedValue === null ? eq(auditLogs.id, r.id) : eq(auditLogs.updatedValue, r.updatedValue)))
        .returning({ id: auditLogs.id });
      if (res.length) reencrypted++;
    } catch {
      failed.push(r.id);
    }
  }
  const result = { activeKid: active, examined: rows.length, reencrypted, failed };
  await runRecord("audit_key_rotation_run", { ...result, failed: failed.length, failedIds: failed.slice(0, 50) });
  logger.info("audit_key_rotation_run", { activeKid: active, examined: rows.length, reencrypted, failed: failed.length });
  return result;
}

/** Decrypt every envelope. Returns per-kid counts and unverifiable row ids. Never returns values. */
export async function verifyAuditValueKeys(): Promise<{ examined: number; byKid: Record<string, number>; unverified: number[] }> {
  const rows = await envelopeRows();
  const byKid: Record<string, number> = {};
  const unverified: number[] = [];
  for (const r of rows) {
    const envs = `${r.previousValue ?? ""} ${r.updatedValue ?? ""}`.match(ENVELOPE_RE) ?? [];
    let ok = true;
    for (const env of envs) {
      const kid = envelopeKid(env) ?? "?";
      byKid[kid] = (byKid[kid] ?? 0) + 1;
      try {
        openAuditValue(env);
      } catch {
        ok = false;
      }
    }
    if (!ok) unverified.push(r.id);
  }
  return { examined: rows.length, byKid, unverified };
}

/**
 * Certify that `kid` can be removed from the key ring. Refuses (and records the refusal) when any
 * envelope still uses kid, any envelope fails to decrypt, or kid is the active key.
 */
export async function retireAuditValueKey(kid: string): Promise<{ ok: boolean; reason?: string; remaining?: number; unverified?: number }> {
  const { active } = keyRing();
  const v = await verifyAuditValueKeys();
  const remaining = v.byKid[kid] ?? 0;
  let reason: string | undefined;
  if (kid === active) reason = "KEY_IS_ACTIVE";
  else if (remaining > 0) reason = "ENVELOPES_REMAIN";
  else if (v.unverified.length > 0) reason = "UNVERIFIED_RECORDS";
  await runRecord(reason ? "audit_key_retirement_refused" : "audit_key_retirement_verified", { kid, reason: reason ?? null, remaining, unverified: v.unverified.length, examined: v.examined });
  return reason ? { ok: false, reason, remaining, unverified: v.unverified.length } : { ok: true, remaining: 0, unverified: 0 };
}
