import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, documents, users, brokerages, type Document } from "@aee/db";
import { logAudit } from "../audit.js";
import {
  BRANDING_LOGICAL_KIND_PREFIX,
  getStoredLogicalDocumentContent,
  ingestDocumentVersion,
  type StoredDocumentContent,
} from "../documentStorage.js";
import { processBrandingImage, type BrandingCrop, type BrandingImageKind } from "./images.js";

// CC #52 branding S1 — migration-free storage on the existing documents
// table's logical-owner mode (brokerage_id + logical_owner_type +
// logical_owner_id, property_id NULL; CHECK documents_ownership_mode_check
// and UNIQUE documents_logical_owner_unique already exist). One row per
// (brokerage, kind, owner):
//   branding_agent_profile    owner = user id       metadata.profile (fields only, no bytes)
//   branding_agent_logo       owner = user id       versions in document_object_versions
//   branding_agent_photo      owner = user id       versions in document_object_versions
//   branding_appraisal        owner = appraisal id  metadata.override (fields only)
// Every query filters by the caller's brokerage. Nothing here touches the
// appraisals table, so existing drafts are unchanged.

export const BRANDING_KINDS = {
  profile: `${BRANDING_LOGICAL_KIND_PREFIX}agent_profile`,
  logo: `${BRANDING_LOGICAL_KIND_PREFIX}agent_logo`,
  photo: `${BRANDING_LOGICAL_KIND_PREFIX}agent_photo`,
  appraisal: `${BRANDING_LOGICAL_KIND_PREFIX}appraisal`,
} as const;
type BrandingKind = (typeof BRANDING_KINDS)[keyof typeof BRANDING_KINDS];

const PHONE = /^\+?[0-9][0-9 ()-]{5,19}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const noControl = (s: string) => !CONTROL.test(s);
const noMarkup = (s: string) => !/[<>]/.test(s);
const text = (max: number) =>
  z.string().trim().max(max).refine(noControl, "Remove control characters.").refine(noMarkup, "Remove < and > characters.");
const optionalText = (max: number) => text(max).nullable().optional().transform((v) => (v ? v : null));

export const brandingFieldsSchema = z
  .object({
    fullName: text(120).pipe(z.string().min(1, "Enter your full name.")),
    title: optionalText(80),
    agencyName: optionalText(120),
    mobilePhone: optionalText(20).refine((v) => v === null || PHONE.test(v), "Enter a valid mobile number."),
    officePhone: optionalText(20).refine((v) => v === null || PHONE.test(v), "Enter a valid office number."),
    email: optionalText(254).refine((v) => v === null || z.string().email().safeParse(v).success, "Enter a valid email."),
    website: optionalText(200).refine((v) => v === null || /^https:\/\/[^\s/$.?#][^\s]*$/i.test(v), "Website must start with https://"),
    address: optionalText(200),
    licence: optionalText(60),
    bio: z.string().trim().max(600).refine(noControl).refine(noMarkup, "Remove < and > characters.").nullable().optional().transform((v) => (v ? v : null)),
  })
  .strict();
export type BrandingFields = z.output<typeof brandingFieldsSchema>;

/** Per-appraisal override: any subset of the fields; null clears back to the default. */
export const brandingOverrideSchema = brandingFieldsSchema
  .partial()
  .extend({ fullName: text(120).pipe(z.string().min(1)).optional() })
  .strict();
export type BrandingOverride = z.output<typeof brandingOverrideSchema>;

export const BRANDING_FIELD_KEYS = Object.keys(brandingFieldsSchema.shape) as (keyof BrandingFields)[];

async function findLogical(brokerageId: number, kind: BrandingKind, ownerId: number): Promise<Document | null> {
  const [row] = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.brokerageId, brokerageId),
        eq(documents.logicalOwnerType, kind),
        eq(documents.logicalOwnerId, ownerId),
        isNull(documents.propertyId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function upsertLogical(brokerageId: number, kind: BrandingKind, ownerId: number, title: string, metadata: Record<string, unknown>): Promise<Document> {
  const owner = { kind, brokerageId, ownerId };
  const existing = await findLogical(brokerageId, kind, ownerId);
  if (existing) {
    const [updated] = await db
      .update(documents)
      .set({ metadata: { ...(existing.metadata as Record<string, unknown> | null), ...metadata, logicalOwner: owner }, updatedAt: new Date() })
      .where(and(eq(documents.id, existing.id), eq(documents.brokerageId, brokerageId), eq(documents.logicalOwnerType, kind)))
      .returning();
    return updated;
  }
  const [created] = await db
    .insert(documents)
    .values({
      propertyId: null,
      brokerageId,
      logicalOwnerType: kind,
      logicalOwnerId: ownerId,
      documentType: "BrandingRecord",
      title,
      status: "Draft",
      metadata: { ...metadata, logicalOwner: owner },
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // Lost a create race: the unique index kept one row. Re-read and merge.
  return upsertLogical(brokerageId, kind, ownerId, title, metadata);
}

export interface BrandingCaller {
  id: number;
  brokerageId: number;
}

export interface BrandingImageRef {
  version: number;
  contentSha256: string;
  width: number | null;
  height: number | null;
  updatedAt: string;
}

export interface AgentBrandingView {
  profile: BrandingFields | null;
  logo: BrandingImageRef | null;
  photo: BrandingImageRef | null;
  /** Account data the editor may offer to prefill. Never invented. */
  suggestions: { fullName: string | null; email: string | null; agencyName: string | null };
}

function imageRef(doc: Document | null): BrandingImageRef | null {
  if (!doc || !doc.objectStorageKey) return null;
  const m = (doc.metadata ?? {}) as Record<string, unknown>;
  const cur = m.current as Record<string, unknown> | undefined;
  if (!cur) return null;
  return {
    version: Number(cur.version),
    contentSha256: String(cur.contentSha256),
    width: typeof cur.width === "number" ? cur.width : null,
    height: typeof cur.height === "number" ? cur.height : null,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function storedProfile(doc: Document | null): BrandingFields | null {
  const p = (doc?.metadata as Record<string, unknown> | null)?.profile;
  return p && typeof p === "object" ? (p as BrandingFields) : null;
}

export async function getAgentBranding(caller: BrandingCaller, userId: number = caller.id): Promise<AgentBrandingView> {
  const [profileDoc, logoDoc, photoDoc, userRows] = await Promise.all([
    findLogical(caller.brokerageId, BRANDING_KINDS.profile, userId),
    findLogical(caller.brokerageId, BRANDING_KINDS.logo, userId),
    findLogical(caller.brokerageId, BRANDING_KINDS.photo, userId),
    db
      .select({ firstName: users.firstName, lastName: users.lastName, email: users.email, brokerageName: brokerages.name })
      .from(users)
      .leftJoin(brokerages, eq(brokerages.id, users.brokerageId))
      .where(and(eq(users.id, userId), eq(users.brokerageId, caller.brokerageId))),
  ]);
  const u = userRows[0];
  const name = u ? `${u.firstName} ${u.lastName}`.trim() : "";
  return {
    profile: storedProfile(profileDoc),
    logo: imageRef(logoDoc),
    photo: imageRef(photoDoc),
    suggestions: { fullName: name || null, email: u?.email ?? null, agencyName: u?.brokerageName ?? null },
  };
}

export async function saveAgentBrandingFields(caller: BrandingCaller, fields: BrandingFields): Promise<BrandingFields> {
  const before = storedProfile(await findLogical(caller.brokerageId, BRANDING_KINDS.profile, caller.id));
  await upsertLogical(caller.brokerageId, BRANDING_KINDS.profile, caller.id, `Branding profile for user ${caller.id}`, {
    profile: fields,
    profileSavedAt: new Date().toISOString(),
  });
  const changed = BRANDING_FIELD_KEYS.filter((k) => (before?.[k] ?? null) !== (fields[k] ?? null));
  await logAudit({
    brokerageId: caller.brokerageId,
    userId: caller.id,
    action: "branding_profile_saved",
    recordType: "branding",
    recordId: `user:${caller.id}`,
    // Field names only. Personal details are never written to the audit trail.
    updatedValue: changed.length ? `fields: ${changed.join(", ")}` : "no field changes",
  });
  return fields;
}

export async function saveAgentBrandingImage(
  caller: BrandingCaller,
  kind: BrandingImageKind,
  input: { bytes: Buffer; declaredMimeType: string; crop: BrandingCrop | null },
): Promise<BrandingImageRef> {
  const processed = await processBrandingImage({ ...input, kind });
  const docKind = kind === "logo" ? BRANDING_KINDS.logo : BRANDING_KINDS.photo;
  const doc = await upsertLogical(caller.brokerageId, docKind, caller.id, `Branding ${kind} for user ${caller.id}`, {});
  const owner = { kind: docKind, brokerageId: caller.brokerageId, ownerId: caller.id };
  const result = await ingestDocumentVersion({
    documentId: doc.id,
    brokerageId: caller.brokerageId,
    actorUserId: caller.id,
    bytes: processed.bytes,
    originalFilename: `${kind}${processed.extension}`,
    declaredMimeType: processed.mimeType,
    source: "branding",
    retentionClass: "general",
    replacementReason: doc.objectStorageKey ? `Branding ${kind} replaced by its owner.` : undefined,
    metadata: { logicalOwner: owner, brandingImage: kind, width: processed.width, height: processed.height },
  });
  const current = {
    version: result.version.version,
    contentSha256: result.version.contentSha256,
    width: processed.width,
    height: processed.height,
  };
  await upsertLogical(caller.brokerageId, docKind, caller.id, `Branding ${kind} for user ${caller.id}`, { current });
  await logAudit({
    brokerageId: caller.brokerageId,
    userId: caller.id,
    action: `branding_${kind}_uploaded`,
    recordType: "branding",
    recordId: `user:${caller.id}`,
    updatedValue: `v${current.version} ${processed.mimeType} ${processed.width}x${processed.height}`,
  });
  return { ...current, updatedAt: new Date().toISOString() };
}

/** Own image only (owner = caller), or an appraisal owner's image via loadAppraisalBrandingImage. */
export async function loadAgentBrandingImage(
  brokerageId: number,
  userId: number,
  kind: BrandingImageKind,
): Promise<StoredDocumentContent | null> {
  const docKind = kind === "logo" ? BRANDING_KINDS.logo : BRANDING_KINDS.photo;
  const doc = await findLogical(brokerageId, docKind, userId);
  if (!doc || !doc.objectStorageKey) return null;
  return getStoredLogicalDocumentContent(doc.id, brokerageId, { kind: docKind, brokerageId, ownerId: userId });
}

export async function getAppraisalOverride(brokerageId: number, appraisalId: number): Promise<BrandingOverride | null> {
  const doc = await findLogical(brokerageId, BRANDING_KINDS.appraisal, appraisalId);
  const o = (doc?.metadata as Record<string, unknown> | null)?.override;
  return o && typeof o === "object" ? (o as BrandingOverride) : null;
}

export async function saveAppraisalOverride(
  caller: BrandingCaller,
  appraisalId: number,
  override: BrandingOverride | null,
): Promise<void> {
  await upsertLogical(caller.brokerageId, BRANDING_KINDS.appraisal, appraisalId, `Branding override for appraisal ${appraisalId}`, {
    override,
    overrideSavedBy: caller.id,
    overrideSavedAt: new Date().toISOString(),
  });
  await logAudit({
    brokerageId: caller.brokerageId,
    userId: caller.id,
    action: override ? "branding_appraisal_override_saved" : "branding_appraisal_override_cleared",
    recordType: "appraisal",
    recordId: String(appraisalId),
    updatedValue: override ? `fields: ${Object.keys(override).join(", ") || "none"}` : "cleared",
  });
}

export type BrandingSource = "appraisal" | "agent" | "none";

/** Per field: appraisal override, else the agent's saved default, else null. No values are invented. */
export function resolveEffectiveBranding(
  profile: BrandingFields | null,
  override: BrandingOverride | null,
): { fields: Partial<Record<keyof BrandingFields, string | null>>; sources: Partial<Record<keyof BrandingFields, BrandingSource>> } {
  const fields: Partial<Record<keyof BrandingFields, string | null>> = {};
  const sources: Partial<Record<keyof BrandingFields, BrandingSource>> = {};
  for (const k of BRANDING_FIELD_KEYS) {
    if (override && Object.prototype.hasOwnProperty.call(override, k) && override[k] != null) {
      fields[k] = override[k] as string;
      sources[k] = "appraisal";
    } else if (profile && profile[k] != null) {
      fields[k] = profile[k] as string;
      sources[k] = "agent";
    } else {
      fields[k] = null;
      sources[k] = "none";
    }
  }
  return { fields, sources };
}
