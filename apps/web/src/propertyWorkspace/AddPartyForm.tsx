// Moved unchanged from PropertyWorkspace.tsx so a later shell can reuse this panel.

import { useState } from "react";
import { ROLES, PARTY_TYPES } from "./types";

// Minimal one-time capture form (Build Brief §4) — every field here is
// captured once against the property and reused everywhere downstream
// (AML, agency agreement, contract) via the PropertyParty join.
export function AddPartyForm({
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
    <div className="card stack">
      <div className="inline-form">
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select value={partyType} onChange={(e) => setPartyType(e.target.value as (typeof PARTY_TYPES)[number])}>
            {PARTY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
      {partyType === "Person" ? (
        <div className="inline-form">
          <label>
            First name
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </label>
          <label>
            Last name
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </label>
        </div>
      ) : (
        <label>
          {partyType} name
          <input value={organisationName} onChange={(e) => setOrganisationName(e.target.value)} />
        </label>
      )}
      <div className="inline-form">
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Mobile
          <input value={mobile} onChange={(e) => setMobile(e.target.value)} />
        </label>
      </div>
      <div className="inline-form">
        <button className="btn btn-primary" onClick={submit}>
          Save
        </button>
        <button className="btn btn-link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
