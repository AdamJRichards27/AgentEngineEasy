import { BRANDING_FIELDS, type BrandingForm } from "../../lib/branding";

export default function BrandingFieldsForm({ form, onChange, disabled }: { form: BrandingForm; onChange: (f: BrandingForm) => void; disabled?: boolean }) {
  return (
    <div className="ae-brand-fields">
      {BRANDING_FIELDS.map((f) => (
        <label key={f.key} className={`ae-brand-field${f.type === "textarea" ? " is-wide" : ""}`}>
          <span>
            {f.label}
            {"required" in f && f.required ? " *" : ""}
          </span>
          {f.type === "textarea" ? (
            <textarea value={form[f.key]} maxLength={f.max} disabled={disabled} onChange={(e) => onChange({ ...form, [f.key]: e.target.value })} />
          ) : (
            <input type={f.type} value={form[f.key]} maxLength={f.max} disabled={disabled} onChange={(e) => onChange({ ...form, [f.key]: e.target.value })} />
          )}
        </label>
      ))}
      <p className="ae-brand-fine is-wide">Only enter details that are yours. AE never fills in titles, qualifications or licence numbers.</p>
    </div>
  );
}
