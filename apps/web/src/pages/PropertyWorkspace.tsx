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
}

interface DocumentPackageBlock {
  id: number;
  status: string;
  documents: Array<{ documentType: string; title: string; status: string }>;
}

interface WorkspaceResponse {
  property: PropertyOverview;
  ownership: OwnershipBlock;
  parties: PartyLink[];
  nextActions: Array<{ label: string; status: string; blockedReason?: string | null }>;
  documentPackage: DocumentPackageBlock | null;
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

  const addParty = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiFetch("/parties", { method: "POST", body: JSON.stringify({ propertyId, ...input }) }),
    onSuccess: () => {
      setShowAddParty(false);
      invalidate();
    },
  });

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

      {/* Required documents (ARCHITECTURE.md §10 Phase 3) — determined and
          created by Ready to List; content population/e-sign is Phase 5. */}
      {data.documentPackage && (
        <section>
          <h2>Required Documents</h2>
          <p>Package status: {data.documentPackage.status}</p>
          <ul>
            {data.documentPackage.documents.map((d, i) => (
              <li key={i}>
                {d.title} — {d.status}
              </li>
            ))}
          </ul>
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
