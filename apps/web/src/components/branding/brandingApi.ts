import { ApiError, apiFetch } from "../../lib/api";
import type { BrandingFields, BrandingImageKind } from "../../lib/branding";

// multipart upload: apiFetch always sends JSON, so this one call uses fetch
// directly (same origin, session cookie, same error shape).
export async function uploadBrandingImage(kind: BrandingImageKind, file: Blob, filename: string, crop: unknown): Promise<unknown> {
  const form = new FormData();
  if (crop) form.append("crop", JSON.stringify(crop));
  form.append("file", file, filename);
  const res = await fetch(`/api/branding/me/${kind}`, { method: "POST", credentials: "include", body: form });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? "Couldn't upload that image.", `upload ${kind} failed`);
  return body;
}

export const saveMyBranding = (fields: BrandingFields) => apiFetch("/branding/me", { method: "PUT", body: JSON.stringify(fields) });
export const saveAppraisalBranding = (id: number, override: Partial<BrandingFields>) =>
  apiFetch(`/branding/appraisals/${id}`, { method: "PUT", body: JSON.stringify({ override }) });
export const clearAppraisalBranding = (id: number) => apiFetch(`/branding/appraisals/${id}`, { method: "DELETE" });
