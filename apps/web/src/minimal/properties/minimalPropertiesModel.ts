import { type AppraisalListRow, appraisalIsTerminal, appraisalWorkspacePath } from "../../lib/appraisalUi";
import { appraisalStatusLabel } from "../../lib/growAppraisals";
import { builderPath } from "../appraisal/appraisalBuilderModel";

// AE Minimal A — Properties (prototype Minimal.tsx "am-data-screen" properties
// workspace). Reads only existing endpoints:
//   GET /properties            (brokerage- and visibility-scoped list)
//   GET /grow/appraisals/pipeline
//   GET /grow/opportunities
//   GET /grow/relationships?search=<address>  (linked contacts; no propertyId filter exists)
// The prototype's property type, bedrooms and record status (D4) are not
// stored on `properties`, so they are not shown.

export interface MinimalPropertyRow {
  id: number;
  formattedAddress: string;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  workflowStage: string;
  listingStatus: string;
}

export interface MinimalPropertyOpportunity {
  id: number;
  propertyId: number | null;
  status: string;
}

export interface MinimalPropertyRelationship {
  partyId: number;
  propertyId: number | null;
  status: string;
  role: string | null;
  partyFirstName: string | null;
  partyLastName: string | null;
  partyOrganisationName: string | null;
}

export interface MinimalPropertyCard {
  id: number;
  address: string;
  location: string;
  stage: string;
  listingStatus: string;
  href: string;
  appraisal: { id: number; statusLabel: string; href: string; closed: boolean } | null;
  openOpportunityCount: number;
}

export function propertyLocationLine(p: Pick<MinimalPropertyRow, "suburb" | "state" | "postcode">): string {
  const parts = [p.suburb, p.state, p.postcode].map((part) => part?.trim() ?? "").filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" ") : "Location not recorded";
}

function appraisalForPropertyRow(rows: AppraisalListRow[], propertyId: number): AppraisalListRow | null {
  const matching = rows.filter((row) => row.propertyId === propertyId);
  return matching.find((row) => !appraisalIsTerminal(row)) ?? matching[0] ?? null;
}

export function buildMinimalPropertyCards(
  properties: MinimalPropertyRow[],
  appraisals: AppraisalListRow[],
  opportunities: MinimalPropertyOpportunity[],
): MinimalPropertyCard[] {
  return properties.map((p) => {
    const appraisal = appraisalForPropertyRow(appraisals, p.id);
    return {
      id: p.id,
      address: p.formattedAddress,
      location: propertyLocationLine(p),
      stage: p.workflowStage,
      listingStatus: p.listingStatus,
      href: `/properties/${p.id}`,
      appraisal: appraisal
        ? {
            id: appraisal.id,
            statusLabel: appraisalStatusLabel(appraisal.status),
            href: appraisalWorkspacePath(appraisal.id),
            closed: appraisalIsTerminal(appraisal),
          }
        : null,
      openOpportunityCount: opportunities.filter((o) => o.propertyId === p.id && o.status === "Open").length,
    };
  });
}

export type CreateAppraisalResolution =
  | { kind: "existing"; appraisalId: number; contactName: string | null; builderHref: string }
  | { kind: "closed"; appraisalId: number; message: string }
  | { kind: "start"; body: { partyId: number; propertyId: number } }
  | { kind: "choose"; choices: { partyId: number; label: string }[]; propertyId: number }
  | { kind: "no-contact"; message: string };

export const ONE_APPRAISAL_PER_PROPERTY =
  "This property's appraisal is finished. AE keeps one appraisal per property, so a new one can't be started here. Open the existing appraisal instead.";

export const LINK_CONTACT_FIRST =
  "Link a contact to this property first. An appraisal is always prepared for a contact.";

function partyLabel(r: MinimalPropertyRelationship): string {
  const person = [r.partyFirstName, r.partyLastName].map((s) => s?.trim() ?? "").filter(Boolean).join(" ");
  const name = person || r.partyOrganisationName?.trim() || `Contact ${r.partyId}`;
  return r.role ? `${name} · ${r.role}` : name;
}

/**
 * "Create Appraisal" from a property card (feasibility item 8, D8 linked-contact
 * path). Existing appraisal → open it (getOrCreateAppraisal would only reuse it).
 * Finished appraisal → explain; the server refuses a second one. Otherwise
 * POST /grow/appraisals/from-contact with the single active linked contact,
 * or ask the agent to choose.
 */
export function resolveCreateAppraisal(
  propertyId: number,
  appraisals: AppraisalListRow[],
  relationships: MinimalPropertyRelationship[],
): CreateAppraisalResolution {
  const existing = appraisalForPropertyRow(appraisals, propertyId);
  if (existing) {
    if (appraisalIsTerminal(existing)) {
      return { kind: "closed", appraisalId: existing.id, message: ONE_APPRAISAL_PER_PROPERTY };
    }
    return {
      kind: "existing",
      appraisalId: existing.id,
      contactName: existing.partyDisplayName,
      builderHref: builderPath(existing.id),
    };
  }
  const seen = new Set<number>();
  const linked: MinimalPropertyRelationship[] = [];
  for (const r of relationships) {
    if (r.propertyId !== propertyId || r.status !== "Active" || seen.has(r.partyId)) continue;
    seen.add(r.partyId);
    linked.push(r);
  }
  if (linked.length === 0) return { kind: "no-contact", message: LINK_CONTACT_FIRST };
  if (linked.length === 1) return { kind: "start", body: { partyId: linked[0].partyId, propertyId } };
  return { kind: "choose", choices: linked.map((r) => ({ partyId: r.partyId, label: partyLabel(r) })), propertyId };
}

export function propertyRelationshipsPath(address: string): string {
  return `/grow/relationships?search=${encodeURIComponent(address)}&limit=100`;
}

/** Route selector for WS3. "?view=full" is the explicit way back to the classic list (same convention as Contact 360). */
export function selectPropertiesView(minimalShell: boolean, search = ""): "minimal" | "classic" {
  if (!minimalShell) return "classic";
  return new URLSearchParams(search).get("view") === "full" ? "classic" : "minimal";
}
