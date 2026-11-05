// AE 2.0 desktop screens (t276u follow-on): the server read contracts of t280u (CONTRACTS-t280u.md) as types, defensive parsers and plain words.
// Nothing here decides who may do what: the server does, and answers with fields (canManage, renewable, revocable, canDownload, canAssignAnyOwner,
// canAcceptForSelf, isAuditValueReader, canReadAuditMetadata). The screens draw an action only when the server says it is allowed. No contact value
// or raw stored key is ever shown: every code and state becomes a sentence here.
import { formatExpiry } from "./exportNotice";

export const when = (iso: string | null | undefined): string => (iso ? formatExpiry(iso) : "");
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/* ── Delegation (proposal / listing agreement sending) ───────────────────────────────────────────────────────────────────────────────────────── */
export type DelegationState = "active" | "expired" | "revoked" | "invalidated";
export type DelegationViewer = "owner" | "admin" | "delegate";
export interface DelegationRow {
  delegateUserId: number;
  delegateName: string;
  delegateRole: string;
  state: DelegationState;
  reason: string;
  grantedAt: string;
  expiresAt: string;
  renewalCount: number;
  revokedAt: string | null;
  renewable: boolean;
  revocable: boolean;
}
export interface EligibleDelegate { userId: number; name: string; role: string }
export interface DelegationStatus { recordType: string; recordId: number; viewer: DelegationViewer; canManage: boolean; ttlDays: number; delegations: DelegationRow[]; eligibleDelegates: EligibleDelegate[] }

const STATES: readonly DelegationState[] = ["active", "expired", "revoked", "invalidated"];

export function parseDelegationStatus(raw: unknown): DelegationStatus | null {
  const o = rec(raw);
  if (!o) return null;
  const viewer = o.viewer === "owner" || o.viewer === "admin" || o.viewer === "delegate" ? o.viewer : null;
  const recordId = num(o.recordId);
  if (!viewer || recordId === null || typeof o.recordType !== "string") return null;
  const delegations: DelegationRow[] = [];
  for (const d of list(o.delegations)) {
    const r = rec(d);
    const state = r && STATES.find((s) => s === r.state);
    if (!r || !state || num(r.delegateUserId) === null || !str(r.grantedAt) || !str(r.expiresAt)) continue;
    delegations.push({ delegateUserId: num(r.delegateUserId)!, delegateName: str(r.delegateName) ?? "A colleague", delegateRole: str(r.delegateRole) ?? "", state, reason: str(r.reason) ?? "", grantedAt: str(r.grantedAt)!, expiresAt: str(r.expiresAt)!, renewalCount: num(r.renewalCount) ?? 0, revokedAt: str(r.revokedAt), renewable: r.renewable === true, revocable: r.revocable === true });
  }
  const eligibleDelegates: EligibleDelegate[] = [];
  for (const e of list(o.eligibleDelegates)) {
    const r = rec(e);
    if (r && num(r.userId) !== null && str(r.name)) eligibleDelegates.push({ userId: num(r.userId)!, name: str(r.name)!, role: str(r.role) ?? "" });
  }
  return { recordType: o.recordType, recordId, viewer, canManage: o.canManage === true, ttlDays: num(o.ttlDays) ?? 30, delegations, eligibleDelegates };
}

export const DELEGATION_STATE_LABEL: Record<DelegationState, string> = { active: "Active", expired: "Expired", revoked: "Revoked", invalidated: "No longer valid" };

/** One delegation in a sentence, by its state. Never a stored key. */
export function delegationDetail(d: DelegationRow): string {
  switch (d.state) {
    case "active": return `Can send until ${when(d.expiresAt)}.`;
    case "expired": return `Expired on ${when(d.expiresAt)}.`;
    case "revoked": return `Revoked${d.revokedAt ? ` on ${when(d.revokedAt)}` : ""}.`;
    case "invalidated": return "No longer valid: the record's owner changed.";
  }
}

export const REASON_MIN = 5;
export const REASON_MAX = 500;
export const reasonOk = (s: string): boolean => s.trim().length >= REASON_MIN && s.trim().length <= REASON_MAX;

/* ── Exports ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export type ExportStatus = "ready" | "downloaded" | "expired";
export interface ExportRow { exportId: number; owner: number; initiatedBy: number; rows: number; preparedAt: string; expiresAt: string; status: ExportStatus; mine: boolean; releasedTo: Array<{ userId: number; releasedAt: string }>; downloadedAt: string | null; seen: boolean; canDownload: boolean }

export function parseExports(raw: unknown): ExportRow[] {
  const o = rec(raw);
  const out: ExportRow[] = [];
  for (const e of list(o?.exports)) {
    const r = rec(e);
    const status = r && (r.status === "ready" || r.status === "downloaded" || r.status === "expired" ? r.status : null);
    if (!r || !status || num(r.exportId) === null || num(r.owner) === null || num(r.initiatedBy) === null || !str(r.preparedAt) || !str(r.expiresAt)) continue;
    const releasedTo: ExportRow["releasedTo"] = [];
    for (const x of list(r.releasedTo)) { const q = rec(x); if (q && num(q.userId) !== null && str(q.releasedAt)) releasedTo.push({ userId: num(q.userId)!, releasedAt: str(q.releasedAt)! }); }
    out.push({ exportId: num(r.exportId)!, owner: num(r.owner)!, initiatedBy: num(r.initiatedBy)!, rows: num(r.rows) ?? 0, preparedAt: str(r.preparedAt)!, expiresAt: str(r.expiresAt)!, status, mine: r.mine === true, releasedTo, downloadedAt: str(r.downloadedAt), seen: r.seen === true, canDownload: r.canDownload === true });
  }
  return out;
}
export const EXPORT_STATUS_LABEL: Record<ExportStatus, string> = { ready: "Ready", downloaded: "Downloaded", expired: "Expired" };
export const exportScope = (n: number): string => `${n} contact${n === 1 ? "" : "s"}`;

/* ── Held imports ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export interface HeldImport { importJobId: number; filename: string; totalRows: number; uploadedAt: string; releaseStatus: "held" | "released"; reasonCode: string | null; release: { ownerUserId: number; authorityRef: string; releasedAt: string } | null; canAssignAnyOwner: boolean; canAcceptForSelf: boolean }

export function parseHeldImports(raw: unknown): HeldImport[] {
  const out: HeldImport[] = [];
  for (const h of list(rec(raw)?.held)) {
    const r = rec(h);
    if (!r || num(r.importJobId) === null || !str(r.filename) || (r.releaseStatus !== "held" && r.releaseStatus !== "released")) continue;
    const rel = rec(r.release);
    out.push({ importJobId: num(r.importJobId)!, filename: str(r.filename)!, totalRows: num(r.totalRows) ?? 0, uploadedAt: str(r.uploadedAt) ?? "", releaseStatus: r.releaseStatus, reasonCode: str(r.reasonCode), release: rel && num(rel.ownerUserId) !== null ? { ownerUserId: num(rel.ownerUserId)!, authorityRef: str(rel.authorityRef) ?? "", releasedAt: str(rel.releasedAt) ?? "" } : null, canAssignAnyOwner: r.canAssignAnyOwner === true, canAcceptForSelf: r.canAcceptForSelf === true });
  }
  return out;
}
export const HELD_REASON_WORDS: Record<string, string> = {
  OWNER_NOT_FOUND: "No owner is recorded for this import.",
  OWNER_OTHER_BROKERAGE: "The recorded owner belongs to another brokerage.",
  OWNER_INACTIVE: "The recorded owner is no longer active.",
  OWNER_ROLE: "The recorded owner is not an Agent or an Administrator.",
  OWNER_NOT_ENTITLED: "The recorded owner does not have permission to import.",
};
export const heldReasonText = (code: string | null): string => (code ? HELD_REASON_WORDS[code] ?? "The owner of this import can't be established." : "");
export const AUTHORITY_REF_MIN = 3;
export const AUTHORITY_REF_MAX = 200;
export const authorityRefOk = (s: string): boolean => s.trim().length >= AUTHORITY_REF_MIN && s.trim().length <= AUTHORITY_REF_MAX;

/* ── Audit ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
export interface AuditCapabilities { isAuditValueReader: boolean; canReadAuditMetadata: boolean; valueRetentionDays: number | null; metadataRetentionDays: number | null }
export interface AuditEntry { auditId: number; action: string; recordType: string; recordId: string; userId: number | null; createdAt: string; hasEncryptedValues: boolean; valuesExpired: boolean; valuesRetainedUntil: string | null }
export interface AuditAccess { id: number; userId: number | null; role: string; outcome: "accessed" | "refused"; refusal: string | null; reason: string | null; at: string }
export interface AuditValues { auditId: number; action: string; before: string | null; after: string | null; fields: string[] }

export function parseAuditCapabilities(raw: unknown): AuditCapabilities {
  const o = rec(raw);
  return { isAuditValueReader: o?.isAuditValueReader === true, canReadAuditMetadata: o?.canReadAuditMetadata === true, valueRetentionDays: num(o?.valueRetentionDays), metadataRetentionDays: num(o?.metadataRetentionDays) };
}
export function parseAuditEntries(raw: unknown): { entries: AuditEntry[]; nextBeforeId: number | null } {
  const o = rec(raw);
  const entries: AuditEntry[] = [];
  for (const e of list(o?.entries)) {
    const r = rec(e);
    if (!r || num(r.auditId) === null || !str(r.action) || !str(r.createdAt)) continue;
    entries.push({ auditId: num(r.auditId)!, action: str(r.action)!, recordType: str(r.recordType) ?? "", recordId: str(r.recordId) ?? "", userId: num(r.userId), createdAt: str(r.createdAt)!, hasEncryptedValues: r.hasEncryptedValues === true, valuesExpired: r.valuesExpired === true, valuesRetainedUntil: str(r.valuesRetainedUntil) });
  }
  return { entries, nextBeforeId: num(o?.nextBeforeId) };
}
export function parseAuditAccesses(raw: unknown): AuditAccess[] {
  const out: AuditAccess[] = [];
  for (const a of list(rec(raw)?.accesses)) {
    const r = rec(a);
    if (!r || num(r.id) === null || !str(r.at) || (r.outcome !== "accessed" && r.outcome !== "refused")) continue;
    out.push({ id: num(r.id)!, userId: num(r.userId), role: str(r.role) ?? "", outcome: r.outcome, refusal: str(r.refusal), reason: str(r.reason), at: str(r.at)! });
  }
  return out;
}
/** The decrypted values of ONE entry, shown only after a reasoned request. Only text is accepted; anything else is dropped. */
export function parseAuditValues(raw: unknown): AuditValues | null {
  const o = rec(raw);
  if (!o || num(o.auditId) === null) return null;
  return { auditId: num(o.auditId)!, action: str(o.action) ?? "", before: str(o.before), after: str(o.after), fields: list(o.fields).filter((f): f is string => typeof f === "string") };
}
const sentence = (s: string): string => { const t = s.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase(); return t ? t[0].toUpperCase() + t.slice(1) : ""; };
/** An audit action key as a readable sentence ("grow_contact_updated_on_authority" becomes "Grow contact updated on authority"). */
export const actionWords = sentence;
export const recordWords = (type: string, id: string): string => `${sentence(type) || "Record"}${id ? ` ${id}` : ""}`;
export const REFUSAL_WORDS: Record<string, string> = { NOT_AUTHORISED: "not authorised", REASON_REQUIRED: "no reason was given", NOT_FOUND: "entry not found", EXPIRED: "past its retention period", KEY_MISMATCH: "could not be decrypted", NO_KEY: "could not be decrypted" };
export const refusalText = (r: string | null): string => (r ? REFUSAL_WORDS[r] ?? sentence(r) : "refused");

/* ── Server error codes in plain words (the server's own sentence wins when it sent one) ────────────────────────────────────────────────────── */
export const CODE_WORDS: Record<string, string> = {
  SEND_DELEGATION_OWNER_ONLY: "Only the owner of this record can change who may send it.",
  SEND_DELEGATE_INVALID: "That person can't be given sending authority. Choose another Agent or Administrator.",
  SEND_DELEGATION_NOT_RENEWABLE: "This delegation can't be renewed. Record a new delegation instead.",
  SEND_DELEGATION_INVALID: "That delegation request isn't valid.",
  EXPORT_DELIVERED_TO_OWNER: "This export is delivered to its owner. It can be downloaded only after the owner releases it.",
  EXPORT_EXPIRED: "This export has expired and is no longer available.",
  EXPORT_RELEASE_OWNER_ONLY: "Only the contact owner can release an export.",
  EXPORT_RELEASE_INVALID: "An export can be released only to the person who prepared it, with a reason of 5 to 500 characters.",
  EXPORT_SEEN_OWNER_ONLY: "Only the owner can mark an export as seen.",
  IMPORT_HELD_READ_FORBIDDEN: "You can't review held imports.",
  AUDIT_METADATA_RESTRICTED: "The audit history is for Administrators.",
  AUDIT_VALUES_RESTRICTED: "You are not authorised to read audited values.",
  AUDIT_VALUES_REASON_REQUIRED: "Give a reason of 5 to 500 characters to view audited values.",
  AUDIT_VALUE_EXPIRED: "These values are past their retention period and are no longer kept.",
  AUDIT_VALUE_UNAVAILABLE: "These values can't be decrypted with the configured key.",
  AUDIT_ID_INVALID: "That audit entry isn't valid.",
};
export function codeText(error: unknown, fallback: string): string {
  const e = error as { code?: unknown; friendly?: unknown } | null;
  if (e && typeof e.code === "string" && CODE_WORDS[e.code]) return CODE_WORDS[e.code];
  if (e && typeof e.friendly === "string" && e.friendly.trim().length > 0) return e.friendly;
  return fallback;
}
