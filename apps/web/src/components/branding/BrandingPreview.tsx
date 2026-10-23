import { brandingContactLines, type BrandingFields } from "../../lib/branding";

/** Cover strip + contact block, as the report will show them. Images keep their aspect (object-fit: contain / cover). */
export default function BrandingPreview({ fields, logoUrl, photoUrl }: { fields: Partial<BrandingFields> | null | undefined; logoUrl: string | null; photoUrl: string | null }) {
  const lines = brandingContactLines(fields);
  return (
    <div className="ae-brand-preview" aria-label="Branding preview">
      <div className="ae-brand-cover">
        {logoUrl ? <img className="ae-brand-logo" src={logoUrl} alt="Your logo" /> : <span className="ae-brand-placeholder">No logo yet</span>}
        <div className="ae-brand-person">
          {photoUrl ? <img className="ae-brand-photo" src={photoUrl} alt="Your profile photo" /> : <span className="ae-brand-photo is-empty" aria-hidden="true" />}
          <div>
            <strong>{fields?.fullName || "Your name"}</strong>
            {fields?.title ? <span>{fields.title}</span> : null}
            {fields?.agencyName ? <span>{fields.agencyName}</span> : null}
          </div>
        </div>
      </div>
      {lines.length ? (
        <ul className="ae-brand-contact">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="ae-brand-fine">No contact details yet.</p>
      )}
      {fields?.bio ? <p className="ae-brand-bio">{fields.bio}</p> : null}
    </div>
  );
}
