import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import { useSession } from "../../lib/session";
import {
  appraisalBrandingImageUrl,
  brandingBody,
  brandingFormError,
  brandingFormFromFields,
  brandingSourceLabel,
  overrideBody,
  type AppraisalBrandingResponse,
  type BrandingForm,
  type MyBrandingResponse,
} from "../../lib/branding";
import { saveAppraisalBranding, saveMyBranding } from "./brandingApi";
import BrandingFieldsForm from "./BrandingFieldsForm";
import BrandingImageUploader from "./BrandingImageUploader";
import BrandingPreview from "./BrandingPreview";

// AB Step 6 "Your Appraisal Branding". Reads GET /branding/appraisals/:id,
// which already resolves the agent's saved default (auto-loaded for every new
// appraisal) plus any override for this appraisal. Logo and photo are the
// agent's defaults, so only the appraisal's own agent can change them.
export default function AppraisalBrandingCard({ appraisalId, canWrite }: { appraisalId: number; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const { user } = useSession();
  const q = useQuery<AppraisalBrandingResponse>({
    queryKey: ["branding-appraisal", appraisalId],
    queryFn: () => apiFetch(`/branding/appraisals/${appraisalId}`),
  });
  const isOwnAgent = !!user && q.data?.agentUserId === user.id;
  const me = useQuery<MyBrandingResponse>({ queryKey: ["branding-me"], queryFn: () => apiFetch("/branding/me"), enabled: isOwnAgent });
  const [editing, setEditing] = useState<BrandingForm | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["branding-appraisal", appraisalId] });
    void queryClient.invalidateQueries({ queryKey: ["branding-me"] });
  };
  const applyOnce = useMutation({
    mutationFn: (f: BrandingForm) => saveAppraisalBranding(appraisalId, overrideBody(f, me.data?.profile ?? defaultsFrom(q.data))),
    onSuccess: () => { setMessage("Applied to this appraisal only."); setEditing(null); refresh(); },
    onError: (e) => setMessage(apiErrorMessage(e, "Couldn't apply the branding.")),
  });
  const saveDefault = useMutation({
    mutationFn: (f: BrandingForm) => saveMyBranding(brandingBody(f)),
    onSuccess: () => { setMessage("Saved as your default."); setEditing(null); refresh(); },
    onError: (e) => setMessage(apiErrorMessage(e, "Couldn't save your default.")),
  });

  if (q.isLoading) return <section className="ae-brand ae-brand-card"><p className="ae-brand-fine">Loading branding…</p></section>;
  if (q.isError || !q.data) return null;
  const d = q.data;
  if (d.finalised) {
    return (
      <section className="ae-brand ae-brand-card" data-ae-branding="finalised">
        <h3>Your Appraisal Branding</h3>
        <p className="ae-brand-fine">{d.snapshot ? "Branding as issued." : "This appraisal was issued before branding was recorded."}</p>
      </section>
    );
  }
  const shown = editing ? brandingBody(editing) : d.effective;
  const busy = applyOnce.isPending || saveDefault.isPending;
  const problem = editing ? brandingFormError(editing) : null;
  return (
    <section className="ae-brand ae-brand-card" data-ae-branding="step6" aria-labelledby="ae-brand-card-title">
      <div className="ae-brand-card-head">
        <h3 id="ae-brand-card-title">Your Appraisal Branding</h3>
        <span className="ae-brand-source" data-source={brandingSourceLabel(d.sources)}>{brandingSourceLabel(d.sources)}</span>
      </div>
      <BrandingPreview
        fields={shown}
        logoUrl={appraisalBrandingImageUrl(appraisalId, "logo", d.logo)}
        photoUrl={appraisalBrandingImageUrl(appraisalId, "photo", d.photo)}
      />
      {editing ? <BrandingFieldsForm form={editing} onChange={setEditing} disabled={busy} /> : null}
      {canWrite ? (
        <div className="ae-brand-actions">
          {!editing ? (
            <button type="button" className="ae-brand-button" onClick={() => { setEditing(brandingFormFromFields(d.effective)); setMessage(null); }}>
              Edit branding
            </button>
          ) : (
            <button type="button" className="ae-brand-button" onClick={() => setEditing(null)}>Cancel</button>
          )}
          {isOwnAgent ? (
            <>
              <BrandingImageUploader kind="logo" label="Change logo" />
              <BrandingImageUploader kind="photo" label="Change profile photo" />
            </>
          ) : null}
          {editing ? (
            <>
              {isOwnAgent ? (
                <button type="button" className="ae-brand-button" disabled={busy || !!problem} onClick={() => saveDefault.mutate(editing)}>
                  Save as my default
                </button>
              ) : null}
              <button type="button" className="ae-brand-button is-primary" disabled={busy || !!problem} onClick={() => applyOnce.mutate(editing)}>
                Apply to this appraisal only
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {problem ? <p className="ae-brand-fine">{problem}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      <p className="ae-brand-fine">
        {isOwnAgent ? "Logo and photo changes update your default. " : ""}
        <Link href="/settings#my-branding">Manage My Branding &amp; Profile</Link>
      </p>
    </section>
  );
}

function defaultsFrom(d: AppraisalBrandingResponse | undefined) {
  if (!d?.effective || !d.sources) return null;
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(d.effective)) out[k] = d.sources[k as keyof typeof d.sources] === "agent" ? v : null;
  return out;
}
