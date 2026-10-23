// CC #52 branding S2 — pure helpers for the My Branding & Profile editor and
// the Appraisal Builder Step 6 card. No hooks, no network.
// Server contract: apps/api/src/routes/branding.ts (S1, PR #255).

export const BRANDING_FIELDS = [
  { key: "fullName", label: "Full name", required: true, max: 120, type: "text" },
  { key: "title", label: "Title", max: 80, type: "text" },
  { key: "agencyName", label: "Agency name", max: 120, type: "text" },
  { key: "mobilePhone", label: "Mobile", max: 20, type: "tel" },
  { key: "officePhone", label: "Office phone", max: 20, type: "tel" },
  { key: "email", label: "Email", max: 254, type: "email" },
  { key: "website", label: "Website (https://)", max: 200, type: "url" },
  { key: "address", label: "Address (optional)", max: 200, type: "text" },
  { key: "licence", label: "Licence / registration (optional, as issued to you)", max: 60, type: "text" },
  { key: "bio", label: "Short bio (optional)", max: 600, type: "textarea" },
] as const;

export type BrandingFieldKey = (typeof BRANDING_FIELDS)[number]["key"];
export type BrandingFields = Record<BrandingFieldKey, string | null>;
export type BrandingForm = Record<BrandingFieldKey, string>;
export type BrandingSource = "appraisal" | "agent" | "none";

export interface BrandingImageRef {
  version: number;
  contentSha256: string;
  width: number | null;
  height: number | null;
}

export interface MyBrandingResponse {
  profile: BrandingFields | null;
  logo: BrandingImageRef | null;
  photo: BrandingImageRef | null;
  suggestions: { fullName: string | null; email: string | null; agencyName: string | null };
}

export interface AppraisalBrandingResponse {
  appraisalId: number;
  finalised: boolean;
  agentUserId?: number | null;
  override?: Partial<BrandingFields> | null;
  effective?: BrandingFields;
  sources?: Record<BrandingFieldKey, BrandingSource>;
  logo?: BrandingImageRef | null;
  photo?: BrandingImageRef | null;
  snapshot?: unknown;
}

export const BRANDING_KEYS: BrandingFieldKey[] = BRANDING_FIELDS.map((f) => f.key);

export function emptyBrandingForm(): BrandingForm {
  return Object.fromEntries(BRANDING_KEYS.map((k) => [k, ""])) as BrandingForm;
}

/** Saved profile wins. Otherwise only real account data (name, email, brokerage) is offered; never title, licence or bio. */
export function brandingFormFrom(data: Pick<MyBrandingResponse, "profile" | "suggestions"> | null | undefined): BrandingForm {
  const form = emptyBrandingForm();
  if (!data) return form;
  if (data.profile) {
    for (const k of BRANDING_KEYS) form[k] = data.profile[k] ?? "";
    return form;
  }
  form.fullName = data.suggestions.fullName ?? "";
  form.email = data.suggestions.email ?? "";
  form.agencyName = data.suggestions.agencyName ?? "";
  return form;
}

export function brandingFormFromFields(fields: Partial<BrandingFields> | null | undefined): BrandingForm {
  const form = emptyBrandingForm();
  for (const k of BRANDING_KEYS) form[k] = fields?.[k] ?? "";
  return form;
}

/** PUT /branding/me body: trimmed, blanks become null. */
export function brandingBody(form: BrandingForm): BrandingFields {
  return Object.fromEntries(BRANDING_KEYS.map((k) => [k, form[k].trim() === "" ? null : form[k].trim()])) as BrandingFields;
}

/** Client-side checks that mirror the server; the server stays authoritative. */
export function brandingFormError(form: BrandingForm): string | null {
  if (!form.fullName.trim()) return "Enter your full name.";
  for (const f of BRANDING_FIELDS) {
    const v = form[f.key].trim();
    if (v.length > f.max) return `${f.label} is too long.`;
    if (/[<>]/.test(v)) return `${f.label} can't contain < or >.`;
  }
  const site = form.website.trim();
  if (site && !/^https:\/\/\S+$/i.test(site)) return "Website must start with https://";
  return null;
}

/**
 * "Apply to this appraisal only": the override is just the fields that differ
 * from the agent's saved default. A field cleared here falls back to the default.
 */
export function overrideBody(form: BrandingForm, defaults: Partial<BrandingFields> | null | undefined): Partial<BrandingFields> {
  const out: Partial<BrandingFields> = {};
  for (const k of BRANDING_KEYS) {
    const v = form[k].trim();
    if (v && v !== (defaults?.[k] ?? "")) out[k] = v;
  }
  return out;
}

export function brandingSourceLabel(sources: Partial<Record<BrandingFieldKey, BrandingSource>> | null | undefined): string {
  const vals = Object.values(sources ?? {});
  if (vals.includes("appraisal")) return "This appraisal only";
  if (vals.includes("agent")) return "From your default";
  return "Not set up yet";
}

export const BRANDING_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const BRANDING_IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";
export const BRANDING_MAX_BYTES = 5 * 1024 * 1024;

export function brandingFileError(file: { type: string; size: number }): string | null {
  if (!(BRANDING_IMAGE_TYPES as readonly string[]).includes(file.type)) return "Use a PNG, JPG or WebP image.";
  if (file.size > BRANDING_MAX_BYTES) return "Images must be 5 MB or smaller.";
  if (file.size === 0) return "That file is empty.";
  return null;
}

export type BrandingImageKind = "logo" | "photo";
/** Photo is square (circle in the report); logo is free within 4:1. */
export function cropAspect(kind: BrandingImageKind): number | undefined {
  return kind === "photo" ? 1 : undefined;
}

/** react-easy-crop croppedAreaPixels → server crop (integers, inside the image). */
export function serverCrop(
  area: { x: number; y: number; width: number; height: number } | null,
  natural: { width: number; height: number } | null,
): { x: number; y: number; width: number; height: number } | null {
  if (!area || !natural) return null;
  const x = Math.max(0, Math.min(natural.width - 1, Math.round(area.x)));
  const y = Math.max(0, Math.min(natural.height - 1, Math.round(area.y)));
  const width = Math.max(1, Math.min(natural.width - x, Math.round(area.width)));
  const height = Math.max(1, Math.min(natural.height - y, Math.round(area.height)));
  return { x, y, width, height };
}

export function myBrandingImageUrl(kind: BrandingImageKind, ref: BrandingImageRef | null | undefined): string | null {
  return ref ? `/api/branding/me/${kind}?v=${encodeURIComponent(ref.contentSha256.slice(0, 16))}` : null;
}

export function appraisalBrandingImageUrl(appraisalId: number, kind: BrandingImageKind, ref: BrandingImageRef | null | undefined): string | null {
  return ref ? `/api/branding/appraisals/${appraisalId}/${kind}?v=${encodeURIComponent(ref.contentSha256.slice(0, 16))}` : null;
}

/** Preview lines for the contact block. Empty values are left out; nothing is filled in. */
export function brandingContactLines(f: Partial<BrandingFields> | null | undefined): string[] {
  if (!f) return [];
  return [f.mobilePhone && `M ${f.mobilePhone}`, f.officePhone && `P ${f.officePhone}`, f.email, f.website, f.address, f.licence && `Licence ${f.licence}`].filter(
    (x): x is string => !!x,
  );
}
