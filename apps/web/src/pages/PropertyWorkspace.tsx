import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";

interface PropertyOverview {
  id: number;
  formattedAddress: string;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
  isManualAddress: boolean;
  workflowStage: string;
  amlStatusSummary: string;
  listingStatus: string;
}

interface OwnershipRecord {
  ownerName: string;
  ownershipType?: string;
}

interface OwnershipBlock {
  data: OwnershipRecord[] | null;
  reviewRequired: boolean;
  reviewedBy: number | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
}

interface PartyLink {
  linkId: number;
  role: string;
  isPrimary: boolean;
  partyId: number;
  party: { firstName?: string; lastName?: string; organisationName?: string; email?: string; mobile?: string } | null;
  amlStatus: string | null;
  amlVerificationId: number | null;
  amlException: { outcome: string | null; riskLevel: string | null } | null;
}

interface DocumentPackageBlock {
  id: number;
  status: string;
  documents: Array<{ id: number; documentType: string; title: string; status: string }>;
  signatureRequest: { id: number; status: string; sentAt: string | null; completedAt: string | null } | null;
}

interface AgencyAgreementTermsBlock {
  id: number;
  commissionType: string;
  commissionRateBps: number | null;
  flatFeeCents: number | null;
  marketingFeeCents: number | null;
  agreementTermDays: number;
}

interface WorkspaceResponse {
  property: PropertyOverview;
  ownership: OwnershipBlock;
  parties: PartyLink[];
  nextActions: Array<{ label: string; status: string; blockedReason?: string | null }>;
  documentPackage: DocumentPackageBlock | null;
  agencyAgreementTerms: AgencyAgreementTermsBlock | null;
}

const ROLES = ["Seller", "Buyer", "Solicitor", "PowerOfAttorney", "Other"] as const;
const PARTY_TYPES = ["Person", "Organisation", "Trust", "Estate", "Other"] as const;

function partyName(p: PartyLink["party"]): string {
  if (!p) return "—";
  return p.organisationName || `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "—";
}

// The Property Action Screen (Build Brief §13 / ARCHITECTURE.md §4) — the
// screen the whole build orients around. Answers "what needs to happen
// next?" with one primary action, not a module menu.
export default function PropertyWorkspace({ params }: { params: { id: string } }) {
  const propertyId = Number(params.id);
  const queryClient = useQueryClient();
  const [showAddParty, setShowAddParty] = useState(false);
  const [reviewNotes, setReviewNotes] = useState("");
  const [exceptionNotes, setExceptionNotes] = useState<Record<number, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["property-workspace", propertyId],
    queryFn: () => apiFetch<WorkspaceResponse>(`/properties/${propertyId}/workspace`),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["property-workspace", propertyId] });

  const readyToList = useMutation({
    mutationFn: () => apiFetch(`/properties/${propertyId}/ready-to-list`, { method: "POST" }),
    onSuccess: invalidate,
  });

  const resolveOwnershipReview = useMutation({
    mutationFn: () =>
      apiFetch(`/properties/${propertyId}/ownership-review`, {
        method: "POST",
        body: JSON.stringify({ notes: reviewNotes || undefined }),
      }),
    onSuccess: () => {
      setReviewNotes("");
      invalidate();
    },
  });

  const removeParty = useMutation({
    mutationFn: (linkId: number) => apiFetch(`/parties/link/${linkId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  // AML exception handling (Phase 4): retry re-runs the check; resolve
  // records a Brokerage Administrator's compliance decision (mandatory
  // notes, enforced server-side too) rather than silently overriding a
  // failed/flagged outcome.
  const retryAml = useMutation({
    mutationFn: (verificationId: number) => apiFetch(`/aml/${verificationId}/retry`, { method: "POST" }),
    onSuccess: invalidate,
  });

  const resolveAmlException = useMutation({
    mutationFn: ({ verificationId, notes }: { verificationId: number; notes: string }) =>
      apiFetch(`/aml/${verificationId}/resolve-exception`, { method: "POST", body: JSON.stringify({ notes }) }),
    onSuccess: (_data, variables) => {
      setExceptionNotes((prev) => ({ ...prev, [variables.verificationId]: "" }));
      invalidate();
    },
  });

  const addParty = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch("/parties", { method: "POST", body: JSON.stringify({ propertyId, ...input }) }),
    onSuccess: () => {
      setShowAddParty(false);
      invalidate();
    },
  });

  // Phase 5: agency agreement terms capture, template population, and
  // send-for-signature.
  const saveAgencyTerms = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch(`/documents/agency-agreement-terms/${propertyId}`, { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: invalidate,
  });

  const populatePackage = useMutation({
    mutationFn: (packageId: number) => apiFetch(`/documents/packages/${packageId}/populate`, { method: "POST" }),
    onSuccess: invalidate,
  });

  const sendForSignature = useMutation({
    mutationFn: (packageId: number) => apiFetch(`/documents/packages/${packageId}/send-for-signature`, { method: "POST" }),
    onSuccess: invalidate,
  });

  const [preview, setPreview] = useState<{ documentId: number; content: string } | null>(null);
  const previewDocument = async (documentId: number) => {
    const res = await fetch(`/api/documents/${documentId}/content`);
    const content = res.ok ? await res.text() : `Could not load content (${res.status}).`;
    setPreview({ documentId, content });
  };

  if (isLoading || !data) return <p>Loading…</p>;

  const sellers = data.parties.filter((p) => p.role === "Seller");
  const others = data.parties.filter((p) => p.role !== "Seller");

  return (
    <div>
      <h1>{data.property.formattedAddress}</h1>

      {/* Property overview (ARCHITECTURE.md §10 Phase 2) */}
      <section>
        <h2>Overview</h2>
        <p>Stage: {data.property.workflowStage}</p>
        <p>
          {[data.property.suburb, data.property.state, data.property.postcode].filter(Boolean).join(", ") ||
            (data.property.isManualAddress ? "Manually entered address — no further detail available." : "—")}
        </p>
        <p>AML: {data.property.amlStatusSummary} · Listing: {data.property.listingStatus}</p>
      </section>

      {/* Ownership review — review, not block (Build Brief §8) */}
      {data.ownership.reviewRequired && (
        <section style={{ border: "1px solid", padding: "0.75rem" }}>
          <h2>Ownership review</h2>
          <p>
            The seller(s) entered don't clearly match the title ownership data on file. This does not block
            progress — trusts, companies, estates, and powers of attorney can legitimately differ. Review and
            clear when satisfied.
          </p>
          {data.ownership.data && (
            <ul>
              {data.ownership.data.map((o, i) => (
                <li key={i}>
                  {o.ownerName}
                  {o.ownershipType ? ` (${o.ownershipType})` : ""}
                </li>
              ))}
            </ul>
          )}
          <input
            value={reviewNotes}
            onChange={(e) => setReviewNotes(e.target.value)}
            placeholder="Optional note (e.g. selling via Power of Attorney)"
          />
          <button onClick={() => resolveOwnershipReview.mutate()}>Mark Reviewed</button>
        </section>
      )}
      {!data.ownership.reviewRequired && data.ownership.reviewNotes && (
        <p>Ownership reviewed: {data.ownership.reviewNotes}</p>
      )}

      <section>
        <h2>People</h2>

        <h3>Sellers</h3>
        {sellers.length === 0 ? <p>No sellers captured yet.</p> : null}
        <ul>
          {sellers.map((p) => (
            <li key={p.linkId}>
              {partyName(p.party)}
              {p.isPrimary ? " (primary)" : ""}
              {p.amlStatus ? ` — AML: ${p.amlStatus}` : ""}
              <button onClick={() => removeParty.mutate(p.linkId)}>Remove</button>

              {/* AML exception (Phase 4): Review Required / Failed never
                  silently clears — retry re-runs the check, resolving
                  requires a note and is a Brokerage Administrator action. */}
              {p.amlException && p.amlVerificationId && (
                <div style={{ border: "1px solid", padding: "0.5rem", marginTop: "0.25rem" }}>
                  <p>
                    AML exception{p.amlException.outcome ? ` (${p.amlException.outcome})` : ""}
                    {p.amlException.riskLevel ? ` — risk: ${p.amlException.riskLevel}` : ""}
                  </p>
                  <button onClick={() => retryAml.mutate(p.amlVerificationId!)}>Retry check</button>
                  <input
                    value={exceptionNotes[p.amlVerificationId] ?? ""}
                    onChange={(e) =>
                      setExceptionNotes((prev) => ({ ...prev, [p.amlVerificationId!]: e.target.value }))
                    }
                    placeholder="Compliance note (required to resolve)"
                  />
                  <button
                    onClick={() =>
                      resolveAmlException.mutate({
                        verificationId: p.amlVerificationId!,
                        notes: exceptionNotes[p.amlVerificationId!] ?? "",
                      })
                    }
                    disabled={!(exceptionNotes[p.amlVerificationId] ?? "").trim()}
                  >
                    Mark Resolved
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {others.length > 0 && (
          <>
            <h3>Other parties</h3>
            <ul>
              {others.map((p) => (
                <li key={p.linkId}>
                  {p.role}: {partyName(p.party)}
                  <button onClick={() => removeParty.mutate(p.linkId)}>Remove</button>
                </li>
              ))}
            </ul>
          </>
        )}

        {!showAddParty ? (
          <button onClick={() => setShowAddParty(true)}>+ Add Person</button>
        ) : (
          <AddPartyForm onCancel={() => setShowAddParty(false)} onSubmit={(input) => addParty.mutate(input)} />
        )}
      </section>

      <section>
        <h2>Next Actions</h2>
        {data.nextActions.length === 0 ? (
          <p>No active workflow yet.</p>
        ) : (
          <ul>
            {data.nextActions.map((a, i) => (
              <li key={i}>
                {a.label} — {a.status}
                {a.blockedReason ? ` (${a.blockedReason})` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Agency agreement terms (Phase 5) — real structured fields (Build
          Brief §3 explicitly rejected the legacy app's opaque-JSON
          commission storage). Required before the AgencyAgreement document
          itself can be generated — see the "not yet captured" note below. */}
      {data.documentPackage && (
        <section>
          <h2>Agency agreement terms</h2>
          <AgencyTermsForm
            initial={data.agencyAgreementTerms}
            onSubmit={(input) => saveAgencyTerms.mutate(input)}
          />
        </section>
      )}

      {/* Required documents (ARCHITECTURE.md §10 Phase 3/5) — determined by
          Ready to List, generated and sent for signature here. Every
          generated document is a placeholder — see the disclaimer banner in
          its content — pending real legal review. */}
      {data.documentPackage && (
        <section>
          <h2>Required Documents</h2>
          <p>Package status: {data.documentPackage.status}</p>
          <ul>
            {data.documentPackage.documents.map((d) => (
              <li key={d.id}>
                {d.title} — {d.status}
                {(d.status === "Generated" || d.status === "Signed") && (
                  <button onClick={() => previewDocument(d.id)}>Preview</button>
                )}
              </li>
            ))}
          </ul>
          <button onClick={() => populatePackage.mutate(data.documentPackage!.id)}>Generate Documents</button>
          {((populatePackage.data as any)?.skipped?.length ?? 0) > 0 && (
            <p>
              {(populatePackage.data as any).skipped
                .map((s: { reason: string }) => s.reason)
                .join(" ")}
            </p>
          )}
          {populatePackage.isError && <p>{(populatePackage.error as Error).message}</p>}

          <button
            onClick={() => sendForSignature.mutate(data.documentPackage!.id)}
            disabled={data.documentPackage.status !== "Ready"}
          >
            Send for Signature
          </button>
          {data.documentPackage.status !== "Ready" && data.documentPackage.status !== "Sent" && data.documentPackage.status !== "Completed" && (
            <p>Generate every document before sending for signature.</p>
          )}
          {sendForSignature.isError && <p>{(sendForSignature.error as Error).message}</p>}

          {data.documentPackage.signatureRequest && (
            <p>
              Signature status: {data.documentPackage.signatureRequest.status}
              {data.documentPackage.signatureRequest.completedAt
                ? ` (completed ${data.documentPackage.signatureRequest.completedAt})`
                : ""}
            </p>
          )}

          {preview && (
            <div style={{ border: "1px solid", padding: "0.5rem", marginTop: "0.5rem" }}>
              <button onClick={() => setPreview(null)}>Close preview</button>
              <pre style={{ whiteSpace: "pre-wrap" }}>{preview.content}</pre>
            </div>
          )}
        </section>
      )}

      {data.property.workflowStage === "Appraisal" && (
        <div>
          <button onClick={() => readyToList.mutate()} disabled={sellers.length === 0}>
            Ready to List
          </button>
          {sellers.length === 0 && <p>Capture at least one seller before Ready to List.</p>}
          {readyToList.isError && <p>{(readyToList.error as Error).message}</p>}
        </div>
      )}
    </div>
  );
}

// Minimal one-time capture form (Build Brief §4) — every field here is
// captured once against the property and reused everywhere downstream
// (AML, agency agreement, contract) via the PropertyParty join.
function AddPartyForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (input: Record<string, unknown>) => void;
}) {
  const [role, setRole] = useState<(typeof ROLES)[number]>("Seller");
  const [partyType, setPartyType] = useState<(typeof PARTY_TYPES)[number]>("Person");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [organisationName, setOrganisationName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");

  const submit = () => {
    onSubmit({
      role,
      partyType,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      organisationName: organisationName || undefined,
      email: email || undefined,
      mobile: mobile || undefined,
    });
  };

  return (
    <div>
      <select value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <select value={partyType} onChange={(e) => setPartyType(e.target.value as (typeof PARTY_TYPES)[number])}>
        {PARTY_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {partyType === "Person" ? (
        <>
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" />
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" />
        </>
      ) : (
        <input
          value={organisationName}
          onChange={(e) => setOrganisationName(e.target.value)}
          placeholder={`${partyType} name`}
        />
      )}
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
      <input value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="Mobile" />
      <button onClick={submit}>Save</button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  );
}

const COMMISSION_TYPES = ["Percentage", "FlatFee"] as const;

// Real structured agency-agreement terms capture (Phase 5) — feeds directly
// into the AgencyAgreement document template (apps/api/src/lib/
// documentTemplates.ts); the document can't be generated until these are
// saved at least once.
function AgencyTermsForm({
  initial,
  onSubmit,
}: {
  initial: {
    commissionType: string;
    commissionRateBps: number | null;
    flatFeeCents: number | null;
    marketingFeeCents: number | null;
    agreementTermDays: number;
  } | null;
  onSubmit: (input: Record<string, unknown>) => void;
}) {
  const [commissionType, setCommissionType] = useState<(typeof COMMISSION_TYPES)[number]>(
    (initial?.commissionType as (typeof COMMISSION_TYPES)[number]) ?? "Percentage",
  );
  const [commissionRate, setCommissionRate] = useState(initial?.commissionRateBps ? (initial.commissionRateBps / 100).toString() : "");
  const [flatFee, setFlatFee] = useState(initial?.flatFeeCents ? (initial.flatFeeCents / 100).toString() : "");
  const [marketingFee, setMarketingFee] = useState(initial?.marketingFeeCents ? (initial.marketingFeeCents / 100).toString() : "");
  const [termDays, setTermDays] = useState(String(initial?.agreementTermDays ?? 90));

  const submit = () => {
    onSubmit({
      commissionType,
      commissionRateBps: commissionType === "Percentage" && commissionRate ? Math.round(Number(commissionRate) * 100) : undefined,
      flatFeeCents: commissionType === "FlatFee" && flatFee ? Math.round(Number(flatFee) * 100) : undefined,
      marketingFeeCents: marketingFee ? Math.round(Number(marketingFee) * 100) : undefined,
      agreementTermDays: Number(termDays) || 90,
    });
  };

  return (
    <div>
      {!initial && <p>Not yet captured — the Agency Agreement document can't be generated until these are saved.</p>}
      <select value={commissionType} onChange={(e) => setCommissionType(e.target.value as (typeof COMMISSION_TYPES)[number])}>
        {COMMISSION_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {commissionType === "Percentage" ? (
        <input value={commissionRate} onChange={(e) => setCommissionRate(e.target.value)} placeholder="Commission rate (%)" />
      ) : (
        <input value={flatFee} onChange={(e) => setFlatFee(e.target.value)} placeholder="Flat fee ($)" />
      )}
      <input value={marketingFee} onChange={(e) => setMarketingFee(e.target.value)} placeholder="Marketing fee ($, optional)" />
      <input value={termDays} onChange={(e) => setTermDays(e.target.value)} placeholder="Agreement term (days)" />
      <button onClick={submit}>Save Terms</button>
    </div>
  );
}
