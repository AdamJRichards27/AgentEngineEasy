import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import {
  brandingBody,
  brandingFormError,
  brandingFormFrom,
  myBrandingImageUrl,
  type BrandingForm,
  type MyBrandingResponse,
} from "../../lib/branding";
import { saveMyBranding } from "./brandingApi";
import BrandingFieldsForm from "./BrandingFieldsForm";
import BrandingImageUploader from "./BrandingImageUploader";
import BrandingPreview from "./BrandingPreview";

// Settings › My Branding & Profile. Your own profile only (admins can't edit
// other agents' profiles in v1). New appraisals use this automatically.
export default function MyBrandingEditor() {
  const queryClient = useQueryClient();
  const me = useQuery<MyBrandingResponse>({ queryKey: ["branding-me"], queryFn: () => apiFetch("/branding/me") });
  const [form, setForm] = useState<BrandingForm | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (me.data && form === null) setForm(brandingFormFrom(me.data));
  }, [me.data]);
  const save = useMutation({
    mutationFn: (f: BrandingForm) => saveMyBranding(brandingBody(f)),
    onSuccess: () => {
      setMessage("Saved to AE. New appraisals will use this.");
      void queryClient.invalidateQueries({ queryKey: ["branding-me"] });
      void queryClient.invalidateQueries({ queryKey: ["branding-appraisal"] });
    },
    onError: (e) => setMessage(apiErrorMessage(e, "Couldn't save your branding.")),
  });
  if (me.isLoading || (!form && !me.isError)) return <p className="muted">Loading…</p>;
  if (me.isError || !form) return <p role="alert">{apiErrorMessage(me.error, "Couldn't load your branding.")}</p>;
  const problem = brandingFormError(form);
  return (
    <div className="ae-brand ae-brand-editor">
      <div className="ae-brand-grid">
        <div>
          <BrandingFieldsForm form={form} onChange={(f) => { setForm(f); setMessage(null); }} />
          <div className="ae-brand-actions">
            <button type="button" className="ae-brand-button is-primary" disabled={!!problem || save.isPending} onClick={() => save.mutate(form)}>
              {save.isPending ? "Saving…" : "Save as my default"}
            </button>
            {problem ? <span className="ae-brand-fine">{problem}</span> : null}
          </div>
          {message ? <p role="status">{message}</p> : null}
        </div>
        <div>
          <BrandingPreview
            fields={brandingBody(form)}
            logoUrl={myBrandingImageUrl("logo", me.data?.logo)}
            photoUrl={myBrandingImageUrl("photo", me.data?.photo)}
          />
          <div className="ae-brand-actions">
            <BrandingImageUploader kind="logo" label={me.data?.logo ? "Change logo" : "Add logo"} />
            <BrandingImageUploader kind="photo" label={me.data?.photo ? "Change profile photo" : "Add profile photo"} />
          </div>
        </div>
      </div>
    </div>
  );
}
