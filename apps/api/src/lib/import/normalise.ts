// Stage B.7 -- Normalisation.
//
// Turns the raw canonical-field map produced by mapping.applyMapping() into
// a typed NormalisedImportRecord (see neutralFormat.ts). Normalisation NEVER
// discards data: the raw row is already preserved verbatim in
// ImportRowMeta.originalValues (set by the caller), so every normaliser here
// is free to clean/reformat a value for matching and storage without losing
// the source truth.
//
// Rules (per B.7):
//  - Email: trim + lowercase + format check. An invalid-looking email is
//    still carried through (as the best-effort cleaned value) so the row
//    isn't silently blanked -- validate.ts is what turns "invalid format"
//    into a WARNING the user sees in Review.
//  - Phone (AU/NZ): reformats only numbers that confidently match an AU or
//    NZ shape. Anything else is preserved verbatim rather than mangled.
//  - Name: trim + collapse internal whitespace only -- no case-folding, no
//    stripping of legitimate characters (hyphens, apostrophes, macrons).
//  - Address: never requires Google Places recognition and always supports
//    a fully manual address. A single "full address" source column is
//    trusted verbatim; structured columns (suburb/state/postcode/...) are
//    composed into the single formatted string Agent Engine actually
//    stores (parties.residentialAddress / properties.formattedAddress).
//  - Relationship type: matched case-insensitively against the real Stage A
//    GROW_RELATIONSHIP_TYPES vocabulary (packages/db/src/schema/grow.ts).
//    No second taxonomy is invented. An unmatched/blank value resolves to
//    "unknown_pending_review" -- Stage B.11/B.12's relationship resolution
//    engine (not this file) is what turns PendingReview rows into
//    confirmed relationships, using cross-row context this per-row
//    normaliser doesn't have.

import { GROW_RELATIONSHIP_TYPES, type GrowRelationshipType } from "@aee/db";
import type { CanonicalField } from "./mapping";
import type {
  ImportRowMeta,
  NormalisedAddress,
  NormalisedImportRecord,
  NormalisedPerson,
  NormalisedProperty,
  NormalisedRelationship,
} from "./neutralFormat";

/* ---------------------------------------------------------------------- */
/* Field-level normalisers                                                */
/* ---------------------------------------------------------------------- */

export interface NormalisedEmailResult {
  original: string;
  value: string | null;
  isValid: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(raw: string | undefined | null): NormalisedEmailResult {
  const original = (raw ?? "").trim();
  if (!original) return { original, value: null, isValid: true };
  const cleaned = original.toLowerCase();
  return { original, value: cleaned, isValid: EMAIL_RE.test(cleaned) };
}

export interface NormalisedPhoneResult {
  original: string;
  value: string | null;
  region: "AU" | "NZ" | "UNKNOWN";
  isValid: boolean;
}

// Deliberately conservative: only reformats numbers that look confidently
// AU or NZ. Anything else is preserved verbatim rather than mangled.
export function normalisePhoneAUNZ(raw: string | undefined | null): NormalisedPhoneResult {
  const original = (raw ?? "").trim();
  if (!original) return { original, value: null, region: "UNKNOWN", isValid: true };

  const digits = original.replace(/[^\d+]/g, "");

  const auMatch = digits.match(/^(?:\+?61|0)(\d{9})$/);
  if (auMatch) return { original, value: `+61${auMatch[1]}`, region: "AU", isValid: true };

  const nzMatch = digits.match(/^(?:\+?64|0)(\d{7,9})$/);
  if (nzMatch) return { original, value: `+64${nzMatch[1]}`, region: "NZ", isValid: true };

  const looksLikePhone = /^[+\d][\d\s().-]{5,}$/.test(original);
  return { original, value: original, region: "UNKNOWN", isValid: looksLikePhone };
}

export interface NormalisedNameResult {
  original: string;
  value: string;
}

export function normaliseName(raw: string | undefined | null): NormalisedNameResult {
  const original = raw ?? "";
  return { original, value: original.trim().replace(/\s+/g, " ") };
}

export interface NormalisedAddressMatchResult {
  original: string;
  matchKey: string;
}

const ADDRESS_NOISE_RE = /[.,#]/g;
const UNIT_PREFIX_RE = /^(unit|apt|apartment|suite|ste)\s+/i;

// Produces a matching key ONLY -- never used for storage/display. Sufficient
// for exact/near-exact dedup matching without geocoding. Google Places (used
// elsewhere in the app) can refine this further but is never required.
export function normaliseAddressForMatching(raw: string | undefined | null): NormalisedAddressMatchResult {
  const original = (raw ?? "").trim();
  if (!original) return { original, matchKey: "" };
  const matchKey = original
    .toLowerCase()
    .replace(UNIT_PREFIX_RE, "")
    .replace(ADDRESS_NOISE_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  return { original, matchKey };
}

/* ---------------------------------------------------------------------- */
/* Relationship type matching -- reuses the real Stage A vocabulary       */
/* ---------------------------------------------------------------------- */

const UNKNOWN_RELATIONSHIP: GrowRelationshipType = "unknown_pending_review";

const RELATIONSHIP_ALIASES: Record<string, GrowRelationshipType> = {
  owner: "owner",
  "co owner": "co_owner",
  coowner: "co_owner",
  "joint owner": "co_owner",
  "former owner": "former_owner",
  "past owner": "former_owner",
  occupier: "occupier",
  resident: "occupier",
  tenant: "tenant",
  renter: "tenant",
  lessee: "tenant",
  landlord: "landlord",
  lessor: "landlord",
  buyer: "buyer",
  purchaser: "buyer",
  "prospective buyer": "prospective_buyer",
  "potential buyer": "prospective_buyer",
  "buyer enquiry": "prospective_buyer",
  seller: "seller",
  "prospective seller": "prospective_seller",
  "potential seller": "prospective_seller",
  "seller enquiry": "prospective_seller",
  "appraisal contact": "appraisal_contact",
  appraisal: "appraisal_contact",
  vendor: "vendor",
  investor: "investor",
  developer: "developer",
  referrer: "referrer",
  referral: "referrer",
  "related party": "related_party",
  other: "related_party",
};

const CODE_LOOKUP: ReadonlySet<string> = new Set(GROW_RELATIONSHIP_TYPES);

function normaliseRelationshipKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}

export function resolveRelationshipType(raw: string | undefined | null): {
  rawType: string | undefined;
  resolvedType: GrowRelationshipType;
} {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { rawType: undefined, resolvedType: UNKNOWN_RELATIONSHIP };
  const key = normaliseRelationshipKey(trimmed);
  const asCode = key.replace(/\s+/g, "_");
  if (CODE_LOOKUP.has(asCode)) return { rawType: trimmed, resolvedType: asCode as GrowRelationshipType };
  const aliased = RELATIONSHIP_ALIASES[key];
  if (aliased) return { rawType: trimmed, resolvedType: aliased };
  return { rawType: trimmed, resolvedType: UNKNOWN_RELATIONSHIP };
}

/* ---------------------------------------------------------------------- */
/* Address assembly + record builder                                      */
/* ---------------------------------------------------------------------- */

type MappedRow = Partial<Record<CanonicalField, string>>;

function get(mapped: MappedRow, field: CanonicalField): string | undefined {
  const trimmed = mapped[field]?.trim();
  return trimmed ? trimmed : undefined;
}

function buildAddress(mapped: MappedRow, prefix: "contactAddress" | "property.address"): NormalisedAddress | undefined {
  const full = get(mapped, `${prefix}.full` as CanonicalField);
  const unit = get(mapped, `${prefix}.unit` as CanonicalField);
  const streetNumber = get(mapped, `${prefix}.streetNumber` as CanonicalField);
  const streetName = get(mapped, `${prefix}.streetName` as CanonicalField);
  const suburb = get(mapped, `${prefix}.suburb` as CanonicalField);
  const state = get(mapped, `${prefix}.state` as CanonicalField);
  const postcode = get(mapped, `${prefix}.postcode` as CanonicalField);
  const country = prefix === "contactAddress" ? get(mapped, "contactAddress.country") : undefined;

  if (!full && !unit && !streetNumber && !streetName && !suburb && !state && !postcode && !country) {
    return undefined;
  }

  const composed = [unit && `Unit ${unit}`, streetNumber, streetName, suburb, state, postcode, country]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const formatted = full ?? (composed || undefined);

  return { unit, streetNumber, streetName, suburb, state, postcode, country, formatted };
}

function buildPerson(mapped: MappedRow): NormalisedPerson {
  const email = normaliseEmail(mapped["person.email"]);
  const alternateEmail = normaliseEmail(mapped["person.alternateEmail"]);
  const mobile = normalisePhoneAUNZ(mapped["person.mobile"]);
  const alternatePhone = normalisePhoneAUNZ(mapped["person.alternatePhone"]);

  return {
    title: get(mapped, "person.title"),
    firstName: normaliseName(mapped["person.firstName"]).value || undefined,
    middleName: normaliseName(mapped["person.middleName"]).value || undefined,
    lastName: normaliseName(mapped["person.lastName"]).value || undefined,
    preferredName: normaliseName(mapped["person.preferredName"]).value || undefined,
    company: normaliseName(mapped["person.company"]).value || undefined,
    email: email.value ?? undefined,
    alternateEmail: alternateEmail.value ?? undefined,
    mobile: mobile.value ?? undefined,
    alternatePhone: alternatePhone.value ?? undefined,
  };
}

function buildProperty(mapped: MappedRow): NormalisedProperty | undefined {
  const address = buildAddress(mapped, "property.address");
  const propertyType = get(mapped, "property.type");
  const ownershipInfo = get(mapped, "property.ownership");
  const notes = get(mapped, "property.notes");
  if (!address && !propertyType && !ownershipInfo && !notes) return undefined;
  return { address: address ?? {}, propertyType, ownershipInfo, notes };
}

function buildRelationship(mapped: MappedRow): NormalisedRelationship | undefined {
  const raw = mapped["relationship.type"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const { rawType, resolvedType } = resolveRelationshipType(raw);
  return { rawType, resolvedType };
}

/**
 * Turns a confirmed column mapping's flat canonical-field map (see
 * mapping.applyMapping) into the typed NormalisedImportRecord every later
 * pipeline stage (validate/dedup/resolve/import) operates on. Purely
 * mechanical field-by-field normalisation -- never drops a row and never
 * decides VALID/WARNING/ERROR (that's validate.ts).
 */
export function buildNormalisedRecord(mapped: MappedRow, meta: ImportRowMeta): NormalisedImportRecord {
  return {
    person: buildPerson(mapped),
    contactAddress: buildAddress(mapped, "contactAddress"),
    property: buildProperty(mapped),
    relationship: buildRelationship(mapped),
    meta,
  };
}
