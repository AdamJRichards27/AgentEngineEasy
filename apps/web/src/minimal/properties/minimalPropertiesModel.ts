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
  /** Present when the API exposes property_parties.isPrimary; primary contacts sort first in the chooser. */
  isPrimary?: boolean | null;
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
  | { kind: "start"; body: StartAppraisalBody }
  | { kind: "choose"; choices: { partyId: number; label: string }[]; propertyId: number }
  | { kind: "no-contact"; message: string };

/** D8 (SPEC-03): the server validates tenant, link and duplicates when entry is "property". */
export interface StartAppraisalBody {
  partyId: number;
  propertyId: number;
  entry: "property";
}

export function startAppraisalBody(partyId: number, propertyId: number): StartAppraisalBody {
  return { partyId, propertyId, entry: "property" };
}

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
  if (linked.length === 1) return { kind: "start", body: startAppraisalBody(linked[0].partyId, propertyId) };
  linked.sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)));
  return { kind: "choose", choices: linked.map((r) => ({ partyId: r.partyId, label: partyLabel(r) })), propertyId };
}

export const CONTACT_NOT_LINKED =
  "That contact is no longer linked to this property. Link the contact on the property, then try again.";

export type StartFailureResolution =
  | { kind: "open-existing"; builderHref: string }
  | { kind: "notice"; text: string; href?: string; hrefLabel?: string };

/**
 * AB-3: map a failed property-entry start to what the agent sees. A 409
 * APPRAISAL_EXISTS (another tab or a double click won the race) opens the
 * existing appraisal; a 422 PROPERTY_CONTACT_NOT_LINKED points at the
 * property to link a contact. Anything else is the caller's friendly message.
 */
export function resolveStartFailure(
  error: { status?: number; code?: string; appraisalId?: number } | null | undefined,
  propertyId: number,
  fallbackText: string,
): StartFailureResolution {
  if (error?.status === 409 && error.code === "APPRAISAL_EXISTS" && typeof error.appraisalId === "number") {
    return { kind: "open-existing", builderHref: builderPath(error.appraisalId) };
  }
  if (error?.status === 422 && error.code === "PROPERTY_CONTACT_NOT_LINKED") {
    return { kind: "notice", text: CONTACT_NOT_LINKED, href: `/properties/${propertyId}`, hrefLabel: "Open the property" };
  }
  return { kind: "notice", text: fallbackText };
}

export function propertyRelationshipsPath(address: string): string {
  return `/grow/relationships?search=${encodeURIComponent(address)}&limit=100`;
}

/** Route selector for WS3. "?view=full" is the explicit way back to the classic list (same convention as Contact 360). */
export function selectPropertiesView(minimalShell: boolean, search = ""): "minimal" | "classic" {
  if (!minimalShell) return "classic";
  return new URLSearchParams(search).get("view") === "full" ? "classic" : "minimal";
}
