// t274u item 3 (file growInterestRecord.ts; lib/growInterest.ts is the shared read-side classification): desktop Contact 360 "Record Grow interest" — a distinct action
// from "Link property". It writes ONE Grow relationship (POST /grow/relationships)
// and never a canonical property_parties link; "Link property" writes only the
// canonical link. Neither action creates both record types.
import { AUTHORITY_REQUIRED_ROLES } from "./relationshipPermission";
import { getActingAuthority, type ActingAuthority } from "./actingAuthority";

export const GROW_INTEREST_PATH = "/grow/relationships";
export const GROW_INTEREST_DUPLICATE_TEXT = "This interest is already recorded for this contact.";
export const GROW_INTEREST_TYPE_REQUIRED = "Choose the kind of interest.";

/** Mirrors the server (t275u): grow.relationships.manage; Pit Crew only with a contact owner's recorded authority. */
export function canRecordGrowInterest(hasEntitlement: (key: string) => boolean, role: string | null | undefined, actingAuthority: ActingAuthority | null = getActingAuthority()): boolean {
  if (role && (AUTHORITY_REQUIRED_ROLES as readonly string[]).includes(role)) return actingAuthority !== null;
  return hasEntitlement("grow.relationships.manage");
}

export function growInterestBody(partyId: number, propertyId: number | null, relationshipType: string): { partyId: number; relationshipType: string; propertyId?: number; sourceType: "manual" } {
  return propertyId === null ? { partyId, relationshipType, sourceType: "manual" } : { partyId, propertyId, relationshipType, sourceType: "manual" };
}

export function growInterestErrorText(status: number | undefined, fallback: string): string {
  if (status === 409) return GROW_INTEREST_DUPLICATE_TEXT;
  if (status === 404) return "That property couldn't be found.";
  if (status === 403) return "You don't have permission to record Grow interest.";
  return fallback;
}
