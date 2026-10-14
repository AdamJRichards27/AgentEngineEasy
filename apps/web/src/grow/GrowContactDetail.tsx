// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { useEntitlements } from "../lib/session";
// AE GROW Priority 3 — Contact 360's communications section, reused unmodified here (see that
// component's own header comment). Grow Today's Email/SMS action buttons below route into it via
// GrowWorkspace's pendingComposeChannel state rather than opening a second composer.
import { ContactCommunicationsSection } from "../components/CommunicationsSection";
// AE GROW Priority 5 Remediation — Property Intelligence. Reused, unmodified, from Contact 360's
// own perspective (anchor="contact"); the Property Workspace embeds the same component with
// anchor="property". See that component's own header comment for why this is a shared panel
// rather than a second bespoke screen.
import { PropertyIntelligencePanel } from "../components/PropertyIntelligencePanel";
import { GrowContactTranscriptPanel } from "../components/GrowContactTranscriptPanel";
// AE GROW Completion W3-A (A-7) — Contact 360's contactability/consent surface.
// Extracted into its own component rather than added to this file, which is
// already Grow Today, Contact 360 and the call panel at once;
// that extraction is the explicit mitigation recorded in the roadmap.
import { GrowContactConsentPanel } from "../components/GrowContactConsentPanel";
import { GrowContactEditForm } from "../components/GrowContactEditForm";
import { GrowPendingCommitmentProposals } from "../components/GrowPendingCommitmentProposals";
// AE GROW Pilot Readiness WP6b (D6) — the shared loading/failed/empty region
// presentation, and the pure state logic behind it and the tab bar.
import { GrowDataRegionStatus } from "../components/GrowDataRegion";
import { growCallingSurfaces } from "../lib/growCalling";
import { formatWhen } from "../lib/growToday";
import { NEXT_COMMITMENT_LABEL, NO_OPEN_COMMITMENT } from "../lib/growTerms";
import { GrowTableScroll } from "../components/GrowTableScroll";
import { growListPath } from "../lib/growListQuery";
import { GrowContactActivityLog } from "./GrowActivityLog";
import { GrowContactAppraisalsSection } from "./GrowAppraisals";
import { GrowContactCallPanel } from "./GrowContactCallPanel";
import { GrowContactCommitmentsList } from "./GrowContactCommitmentsList";
import { GrowContactOpportunitiesSection } from "./GrowContactOpportunitiesSection";
import { GrowLinkPropertyForm } from "./GrowLinkPropertyForm";
import { growActivityTypeLabel } from "./messages";
import { StatTile } from "./StatTile";
import type {
  GrowAccess,
  GrowContactListItem,
  GrowContactListPage,
  GrowContact360,
} from "./types";
import { GROW_CONTACT_ROLES, GROW_CONTACT_RELATIONSHIP_TYPES } from "./types";

// AE GROW Priority 2 §11 — Contact 360 detail. One request (GET /grow/contacts/:partyId, built
// in this priority's API layer) backs the whole screen — header/identity, relationship-role
// summary, household relationships, properties, the Relationship Timeline, notes/activities/
// commitments, and opportunities — matching the "understand this relationship in seconds" UX
// goal rather than a screen that fires off five separate requests or a generic CRM record view.
export function GrowContactDetail({
  partyId,
  onBack,
  pendingComposeChannel,
  onComposeHandled,
}: {
  partyId: number;
  onBack: () => void;
  // AE GROW Priority 3 §2/§4 — see GrowWorkspace.pendingComposeChannel and
  // ContactCommunicationsSection's own quickComposeChannel prop below.
  pendingComposeChannel: "EMAIL" | "SMS" | null;
  onComposeHandled: () => void;
}) {
  const queryClient = useQueryClient();
  const { hasEntitlement, isLoading: entitlementsLoading } = useEntitlements();
  const canManageContacts = hasEntitlement("grow.contacts.manage");
  const canManageActivities = hasEntitlement("grow.activities.manage");
  // GP-5 — the workspace already loads this. Optional calling/provider flags
  // hide the cards; a missing flag does not. Entitlements still decide.
  const access = useQuery<GrowAccess & { callingEnabled?: boolean; providerEnabled?: boolean }>({
    queryKey: ["grow-access"],
    queryFn: () => apiFetch("/grow/access"),
  });
  const callingSurfaces = growCallingSurfaces({
    entitlementsKnown: entitlementsLoading !== true && access.isLoading !== true,
    hasEntitlement,
    callingEnabled: access.data?.callingEnabled,
    providerEnabled: access.data?.providerEnabled,
  });

  const detail = useQuery<GrowContact360>({
    queryKey: ["grow-contact", partyId],
    queryFn: () => apiFetch(`/grow/contacts/${partyId}`),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["grow-contact", partyId] });
    queryClient.invalidateQueries({ queryKey: ["grow-contacts"] });
  }

  const assignRole = useMutation({
    mutationFn: (role: string) => apiFetch(`/grow/contacts/${partyId}/roles`, { method: "POST", body: JSON.stringify({ role }) }),
    onSuccess: invalidate,
  });
  const removeRole = useMutation({
    mutationFn: (role: string) => apiFetch(`/grow/contacts/${partyId}/roles/${encodeURIComponent(role)}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const [showAddRelationship, setShowAddRelationship] = useState(false);
  const [relatedSearch, setRelatedSearch] = useState("");
  const [relatedResults, setRelatedResults] = useState<GrowContactListItem[]>([]);
  const [relatedPartyId, setRelatedPartyId] = useState<number | null>(null);
  const [relationshipType, setRelationshipType] = useState<string>(GROW_CONTACT_RELATIONSHIP_TYPES[0]);
  const [relationshipNote, setRelationshipNote] = useState("");

  const searchRelated = useMutation({
    mutationFn: (query: string) =>
      apiFetch<GrowContactListPage>(growListPath("/grow/contacts", { search: query, excludePartyId: partyId })),
    onSuccess: (result) => setRelatedResults(result.contacts),
  });

  const addRelationship = useMutation({
    mutationFn: () =>
      apiFetch(`/grow/contacts/${partyId}/relationships`, {
        method: "POST",
        body: JSON.stringify({
          relatedPartyId,
          relationshipType,
          ...(relationshipNote.trim() ? { note: relationshipNote.trim() } : {}),
        }),
      }),
    onSuccess: () => {
      setShowAddRelationship(false);
      setRelatedSearch("");
      setRelatedResults([]);
      setRelatedPartyId(null);
      setRelationshipNote("");
      invalidate();
    },
  });

  const removeRelationship = useMutation({
    mutationFn: (id: number) => apiFetch(`/grow/contacts/relationships/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const [showAddCommitment, setShowAddCommitment] = useState(false);
  const [commitmentDescription, setCommitmentDescription] = useState("");
  const [commitmentDueAt, setCommitmentDueAt] = useState("");
  const [commitmentPropertyId, setCommitmentPropertyId] = useState("");
  const [commitmentOpportunityId, setCommitmentOpportunityId] = useState("");

  const addCommitment = useMutation({
    mutationFn: () =>
      apiFetch(`/grow/contacts/${partyId}/commitments`, {
        method: "POST",
        body: JSON.stringify({
          description: commitmentDescription.trim(),
          dueAt: new Date(commitmentDueAt).toISOString(),
          ...(commitmentPropertyId ? { propertyId: Number(commitmentPropertyId) } : {}),
          ...(commitmentOpportunityId ? { opportunityId: Number(commitmentOpportunityId) } : {}),
        }),
      }),
    onSuccess: () => {
      setShowAddCommitment(false);
      setCommitmentDescription("");
      setCommitmentDueAt("");
      setCommitmentPropertyId("");
      setCommitmentOpportunityId("");
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["grow-today"] });
    },
  });

  // AE GROW Completion W2-B (G-4) — same region presentation as every other
  // Grow region, so a Contact 360 that failed to load offers Try again rather
  // than only "Back to contacts". The back button stays: it is this view's own
  // navigation, not part of the failure.
  if (detail.isLoading || detail.isError || !detail.data) {
    return (
      <div>
        <button type="button" className="btn btn-link btn-small" onClick={onBack}>
          &larr; Back to contacts
        </button>
        <GrowDataRegionStatus
          query={detail}
          itemCount={undefined}
          loadingMessage="Loading contact…"
          errorFallback="Couldn't load this contact."
          emptyMessage="Nothing to show for this contact."
          onRetry={() => void detail.refetch()}
        />
      </div>
    );
  }

  const data = detail.data;
  const c = data.contact;

  return (
    <div>
      <button type="button" className="btn btn-link btn-small" onClick={onBack}>
        &larr; Back to contacts
      </button>

      <div className="primary-action">
        <div className="eyebrow">{c.partyType}</div>
        <h2>{c.displayName}</h2>
        <p className="muted">
          {c.email ?? "No email on file"}
          {c.mobile ? ` · ${c.mobile}` : ""}
        </p>
        <GrowContactEditForm partyId={partyId} contact={c} canEdit={canManageContacts} />
        <div className="grow-contact-roles">
          {GROW_CONTACT_ROLES.map((role) => {
            const active = data.roles.includes(role);
            return (
              <button
                key={role}
                type="button"
                className={`pill${active ? " pill-success" : ""}`}
                disabled={!canManageContacts || assignRole.isPending || removeRole.isPending}
                onClick={() => (active ? removeRole.mutate(role) : assignRole.mutate(role))}
                title={
                  canManageContacts
                    ? active
                      ? `Remove ${role} role`
                      : `Assign ${role} role`
                    : "Requires Grow contact management access"
                }
              >
                {role}
              </button>
            );
          })}
        </div>
      </div>

      {/* AE GROW Completion W3-A (A-7) — above the call and communications
          panels on purpose: whether this contact may be reached, and why not,
          has to be readable BEFORE the affordances that reach them. The block
          comes from the Contact 360 request this view already makes, so the
          panel adds no second round trip. */}
      <GrowContactConsentPanel partyId={partyId} contactability={data.contactability} onChanged={invalidate} />

      {callingSurfaces.call && <GrowContactCallPanel partyId={partyId} contactName={c.displayName} />}
      {callingSurfaces.transcripts && (
        <GrowContactTranscriptPanel
          partyId={partyId}
          contactName={c.displayName}
          onReviewSaved={() => {
            // The API writes the approved call-summary activity atomically with Save.
            // Refresh only read models here; the browser never persists the activity.
            queryClient.invalidateQueries({ queryKey: ["grow-contact", partyId] });
            queryClient.invalidateQueries({ queryKey: ["grow-activities"] });
          }}
        />
      )}

      <div className="stat-tiles">
        <StatTile label="Related Properties" value={data.intelligence.relatedPropertyCount} />
        <StatTile label="Open Opportunities" value={data.intelligence.activeOpportunityCount} />
        <StatTile label="Recent Activity (30d)" value={data.intelligence.recentActivityCount} />
        <StatTile label="Outstanding Commitments" value={data.intelligence.outstandingCommitmentCount} />
      </div>

      {/* AE GROW Priority 3 §2 — Contact 360's communications section: Email/SMS actions,
          reusing the Communications Hub's own composer (components/CommunicationsSection.tsx),
          wired to the new contact-first routes. The thread/message list rendered inside it is
          this page's "communications history" — see that component's own header comment. */}
      <ContactCommunicationsSection
        partyId={partyId}
        canStartThread={canManageContacts}
        quickComposeChannel={pendingComposeChannel}
        onQuickComposeHandled={onComposeHandled}
        contactability={data.contactability}
      />

      <section className="card">
        <h2>Relationship summary</h2>
        <p className="muted">
          {data.intelligence.relationshipAgeDays !== null
            ? `Known to AE for ${data.intelligence.relationshipAgeDays} day(s). `
            : "No recorded history yet. "}
          {data.intelligence.mostRecentInteractionAt
            ? `Last interaction ${data.intelligence.daysSinceLastInteraction} day(s) ago (${formatWhen(
                data.intelligence.mostRecentInteractionAt,
              )}).`
            : "No interactions logged yet."}
        </p>
        {data.intelligence.nextFollowUpAt ? (
          <p>
            <strong>{NEXT_COMMITMENT_LABEL}</strong> {data.intelligence.nextFollowUpDescription} — due{" "}
            {formatWhen(data.intelligence.nextFollowUpAt)}
          </p>
        ) : (
          <p className="muted">{NO_OPEN_COMMITMENT}</p>
        )}
      </section>

      <section className="card">
        <h2>Household &amp; related contacts</h2>
        <p className="muted">Person-to-person context, recorded explicitly by an agent — AE never auto-infers this.</p>
        {data.householdRelationships.length === 0 && <p className="empty-state">No related contacts recorded.</p>}
        {data.householdRelationships.length > 0 && (
          <ul className="item-list">
            {data.householdRelationships.map((h) => (
              <li key={h.id}>
                <strong>{h.relatedPartyDisplayName}</strong> — {h.relationshipType.replace(/_/g, " ")}
                {h.note ? <span className="muted"> ({h.note})</span> : null}
                {canManageContacts && (
                  <button
                    type="button"
                    className="btn btn-link btn-small"
                    disabled={removeRelationship.isPending}
                    onClick={() => removeRelationship.mutate(h.id)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManageContacts && (
          <>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setShowAddRelationship((v) => !v)}>
              {showAddRelationship ? "Cancel" : "Add related contact"}
            </button>
            {showAddRelationship && (
              <form
                className="stack grow-inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!relatedPartyId) return;
                  addRelationship.mutate();
                }}
              >
                <label htmlFor="grow-related-search">Find contact</label>
                <div className="grow-inline-form-row">
                  <input
                    id="grow-related-search"
                    type="text"
                    placeholder="Search by name or email"
                    value={relatedSearch}
                    onChange={(e) => setRelatedSearch(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    disabled={!relatedSearch.trim() || searchRelated.isPending}
                    onClick={() => searchRelated.mutate(relatedSearch.trim())}
                  >
                    Search
                  </button>
                </div>
                {relatedResults.length > 0 && (
                  <ul className="item-list">
                    {relatedResults.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          className={`btn btn-link btn-small${relatedPartyId === r.id ? " active" : ""}`}
                          onClick={() => setRelatedPartyId(r.id)}
                        >
                          {relatedPartyId === r.id ? "✓ " : ""}
                          {r.displayName}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <label htmlFor="grow-relationship-type">Relationship</label>
                <select id="grow-relationship-type" value={relationshipType} onChange={(e) => setRelationshipType(e.target.value)}>
                  {GROW_CONTACT_RELATIONSHIP_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
                <label htmlFor="grow-relationship-note">Note (optional)</label>
                <input
                  id="grow-relationship-note"
                  type="text"
                  value={relationshipNote}
                  onChange={(e) => setRelationshipNote(e.target.value)}
                />
                <button className="btn btn-primary btn-small" type="submit" disabled={!relatedPartyId || addRelationship.isPending}>
                  Save relationship
                </button>
              </form>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2>Properties</h2>
        <p className="muted">Reuses AE's canonical properties — Grow does not keep a second property record.</p>
        {data.properties.length === 0 && <p className="empty-state">No property relationships recorded.</p>}
        {data.properties.length > 0 && (
          <GrowTableScroll>
          <table className="grow-table">
            <thead>
              <tr>
                <th>Property</th>
                <th>Type</th>
                <th>Role</th>
                <th>Status</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {data.properties.map((p) => (
                <tr key={p.relationshipId}>
                  <td>
                    {p.propertyId !== null ? (
                      <Link href={`/properties/${p.propertyId}`}>{p.propertyAddress ?? "View property"}</Link>
                    ) : (
                      p.propertyAddress ?? "–"
                    )}
                  </td>
                  <td>
                    {p.relationshipType}
                    {p.isPrimary ? " (primary)" : ""}
                  </td>
                  <td>{p.role ?? "–"}</td>
                  <td>
                    <span className={`pill ${p.status === "Active" ? "pill-success" : p.status === "PendingReview" ? "pill-warning" : ""}`}>
                      {p.status}
                    </span>
                  </td>
                  <td>{formatWhen(p.validFrom)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </GrowTableScroll>
        )}
        <GrowLinkPropertyForm partyId={partyId} onLinked={invalidate} />
      </section>

      <GrowContactAppraisalsSection partyId={partyId} linkedProperties={data.properties} />

      {/* AE GROW Priority 5 Remediation — Property Intelligence. Extends this existing Contact
          360 view rather than adding a second contact screen, per the remediation objective's
          own instruction. The panel independently gates itself on grow.propertyIntelligence.read
          via useEntitlements() and renders nothing (not even a placeholder) when the viewer lacks
          it, so no wiring is needed here beyond mounting it. */}
      <PropertyIntelligencePanel anchor="contact" partyId={partyId} />

      <section className="card">
        <h2>Relationship Timeline</h2>
        <p className="muted">Every interaction, in one place, chronological — never a predictive score.</p>
        {data.timeline.length === 0 && <p className="empty-state">No history yet.</p>}
        {data.timeline.length > 0 && (
          <ul className="timeline">
            {data.timeline.map((e) => (
              <li key={e.id}>
                <span className="when">{new Date(e.occurredAt).toLocaleString()}</span>
                <div className="eyebrow">{e.type.replace(/_/g, " ")}</div>
                <p style={{ whiteSpace: "pre-wrap" }}>{e.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Notes, activity &amp; commitments</h2>
        <h3>Recent activity</h3>
        {data.activities.length === 0 && <p className="empty-state">No activity logged yet.</p>}
        {data.activities.length > 0 && (
          <ul className="timeline">
            {data.activities.map((a) => (
              <li key={a.id}>
                <span className="when">{new Date(a.occurredAt).toLocaleString()}</span>
                <div className="eyebrow">{growActivityTypeLabel(a.activityType)}</div>
                <p style={a.activityType === "call_summary" ? { whiteSpace: "pre-wrap" } : undefined}>{a.summary}</p>
              </li>
            ))}
          </ul>
        )}

        <GrowContactActivityLog partyId={partyId} canLog={canManageActivities} />

        {/* Stage F4.3: the caller's own pending CREATE_GROW_COMMITMENT
            proposals for this contact, approved/rejected only by explicit
            clicks on the shared review card. Renders nothing when empty. */}
        {canManageActivities && <GrowPendingCommitmentProposals partyId={partyId} contactName={c.displayName} />}

        <h3>Commitments</h3>
        <GrowContactCommitmentsList
          commitments={data.commitments}
          canManageActivities={canManageActivities}
          onChanged={invalidate}
        />
        {canManageActivities && (
          <>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setShowAddCommitment((v) => !v)}>
              {showAddCommitment ? "Cancel" : "Add commitment"}
            </button>
            {showAddCommitment && (
              <form
                className="stack grow-inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!commitmentDescription.trim() || !commitmentDueAt) return;
                  addCommitment.mutate();
                }}
              >
                <label htmlFor="grow-commitment-description">What was promised</label>
                <input
                  id="grow-commitment-description"
                  type="text"
                  placeholder="e.g. Call next month about listing"
                  value={commitmentDescription}
                  onChange={(e) => setCommitmentDescription(e.target.value)}
                  required
                />
                <label htmlFor="grow-commitment-due">Due</label>
                <input
                  id="grow-commitment-due"
                  type="date"
                  value={commitmentDueAt}
                  onChange={(e) => setCommitmentDueAt(e.target.value)}
                  required
                />
                {data.properties.length > 0 && (
                  <>
                    <label htmlFor="grow-commitment-property">Property (optional)</label>
                    <select
                      id="grow-commitment-property"
                      value={commitmentPropertyId}
                      onChange={(e) => setCommitmentPropertyId(e.target.value)}
                    >
                      <option value="">None</option>
                      {data.properties
                        .filter((p) => p.propertyId !== null)
                        .map((p) => (
                          <option key={p.propertyId as number} value={p.propertyId as number}>
                            {p.propertyAddress}
                          </option>
                        ))}
                    </select>
                  </>
                )}
                {data.opportunities.length > 0 && (
                  <>
                    <label htmlFor="grow-commitment-opportunity">Opportunity (optional)</label>
                    <select
                      id="grow-commitment-opportunity"
                      value={commitmentOpportunityId}
                      onChange={(e) => setCommitmentOpportunityId(e.target.value)}
                    >
                      <option value="">None</option>
                      {data.opportunities.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.opportunityType} — {o.stage}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <button className="btn btn-primary btn-small" type="submit" disabled={addCommitment.isPending}>
                  Save commitment
                </button>
              </form>
            )}
          </>
        )}
      </section>

      <GrowContactOpportunitiesSection
        partyId={partyId}
        contactName={c.displayName}
        linkedProperties={data.properties}
        opportunities={data.opportunities}
        onChanged={invalidate}
      />
    </div>
  );
}
