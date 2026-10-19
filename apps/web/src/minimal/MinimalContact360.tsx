import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { apiErrorMessage, apiFetch } from "../lib/api";
import type { GrowContact360 } from "../lib/growContact360";
import { useEntitlements } from "../lib/session";
import { MinimalGrowSections } from "./MinimalGrowSections";
import { buildMinimalContactModel, formatContactDate, type MinimalContactModel } from "./minimalContactModel";

// AE Minimal A Contact 360 (read-only). Data is the existing GET /grow/contacts/:partyId, under the same
// react-query key as the classic detail. Nothing here writes: notes are the contact's existing "note"
// activities, there is no communication-preference field, and consent is the server's own headline.
// Every change (roles, relationships, consent, calls) stays on the classic detail via "Open full record".

export default function MinimalContact360() {
  const params = useParams<{ id: string }>();
  const { hasEntitlement } = useEntitlements();
  const partyId = /^\d+$/.test(params.id ?? "") ? Number(params.id) : null;
  const detail = useQuery<GrowContact360>({
    queryKey: ["grow-contact", partyId],
    queryFn: () => apiFetch(`/grow/contacts/${partyId}`),
    enabled: partyId !== null,
  });

  if (partyId === null) {
    return <MinimalContactMessage text="That couldn't be found — it may have been removed." />;
  }
  if (detail.isLoading) return <p className="am-empty-note" role="status">Loading contact…</p>;
  if (detail.isError) {
    return (
      <MinimalContactMessage
        text={apiErrorMessage(detail.error, "Couldn't load this contact.")}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  if (!detail.data) return null;
  return <MinimalContact360View model={buildMinimalContactModel(detail.data, { runAccess: hasEntitlement("run.access") })} />;
}

export function MinimalContactMessage({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="am-contact" data-ae-contact="minimal">
      <MinimalGrowSections current="contacts" />
      <Link href="/grow" className="am-back-link">
        ← Back to Today
      </Link>
      <div className="am-rail-section" role="alert">
        <p className="am-switch-error">{text}</p>
        {onRetry ? (
          <button type="button" className="am-classic-switch" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function MinimalContact360View({ model }: { model: MinimalContactModel }) {
  return (
    <div className="am-contact" data-ae-contact="minimal">
      <MinimalGrowSections current="contacts" />
      <Link href="/grow" className="am-back-link">
        ← Back to Today
      </Link>
      <header className="am-contact-head">
        <span className="am-contact-avatar" aria-hidden="true">
          {model.initials}
        </span>
        <div>
          <h1>{model.title}</h1>
          {model.roleChips.length > 0 ? (
            <ul className="am-chip-row" aria-label="Roles">
              {model.roleChips.map((role) => (
                <li key={role} className="am-chip">
                  {role}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </header>

      <section className="am-rail-section" aria-labelledby="am-contact-details">
        <h2 id="am-contact-details" className="am-eyebrow">
          Details
        </h2>
        <dl className="am-facts">
          <dt>Email</dt>
          <dd>{model.email ?? "Not recorded"}</dd>
          <dt>Mobile</dt>
          <dd>{model.mobile ?? "Not recorded"}</dd>
          <dt>Last interaction</dt>
          <dd>{model.lastTouchLabel}</dd>
          <dt>Next commitment</dt>
          <dd>{model.followUp ? `${model.followUp.label} · ${formatContactDate(model.followUp.dueAt)}` : "None scheduled"}</dd>
          <dt>Open opportunities</dt>
          <dd>{model.openOpportunityCount}</dd>
        </dl>
      </section>

      {model.consent ? (
        <section className="am-rail-section" aria-labelledby="am-contact-consent" data-consent-status={model.consent.status}>
          <h2 id="am-contact-consent" className="am-eyebrow">
            Contactability
          </h2>
          <p className="am-agenda-title">{model.consent.label}</p>
          <p className="am-empty-note">{model.consent.detail}</p>
        </section>
      ) : null}

      <section className="am-rail-section" aria-labelledby="am-contact-properties">
        <h2 id="am-contact-properties" className="am-eyebrow">
          Properties
        </h2>
        {model.properties.length === 0 ? (
          <p className="am-empty-note">No active property links.</p>
        ) : (
          <ul className="am-agenda">
            {model.properties.map((p) => (
              <li key={p.key} className="am-agenda-row">
                <div>
                  {p.href ? (
                    <Link href={p.href} className="am-agenda-title">
                      {p.label}
                    </Link>
                  ) : (
                    <span className="am-agenda-title">{p.label}</span>
                  )}
                  <div className="am-agenda-sub">
                    {p.relationship}
                    {p.primary ? " · Primary" : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="am-rail-section" aria-labelledby="am-contact-notes">
        <h2 id="am-contact-notes" className="am-eyebrow">
          Recent notes
        </h2>
        {model.notes.length === 0 ? (
          <p className="am-empty-note">No notes recorded.</p>
        ) : (
          <ul className="am-agenda">
            {model.notes.map((n) => (
              <li key={n.id} className="am-agenda-row">
                <div>
                  <div className="am-agenda-sub">{formatContactDate(n.occurredAt)}</div>
                  <p className="am-contact-note">{n.text}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="am-empty-note">Notes are read-only here.</p>
      </section>

      <Link href={model.fullViewPath} className="am-classic-switch">
        Open full record
      </Link>
    </div>
  );
}
