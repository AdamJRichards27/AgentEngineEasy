import type { GrowRelationshipType } from "@aee/db";

// The intermediate representation every source row passes through. Raw
// spreadsheet rows never map directly into parties/properties/growRelationships -
// they pass RAW -> NORMALISED (this file) -> CANONICAL ENTITY, so validation,
// dedup and relationship resolution all operate on one predictable shape
// regardless of source format or column naming.

export interface NormalisedPerson {
  title?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  preferredName?: string;
  company?: string;
  email?: string;
  alternateEmail?: string;
  mobile?: string;
  alternatePhone?: string;
}

export interface NormalisedAddress {
  unit?: string;
  streetNumber?: string;
  streetName?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  country?: string;
  formatted?: string; // composed single-line string - what actually gets stored
}

/**
 * AE GROW "Brokerage-wide Signal Sweep" stage 2 — a recognised ownership
 * start date, carried through the pipeline to growRelationships.
 *
 * `dateIso` is a STRING, not a Date, deliberately: a NormalisedImportRecord
 * is persisted verbatim into importRecords.normalizedData (jsonb) and read
 * back by pipeline.ts's computePlan(), so anything in this shape must survive
 * a JSON round trip unchanged. A Date would come back as a string anyway,
 * silently, and every downstream consumer would then be lying about its own
 * type.
 *
 * Present ONLY when lib/ownershipStart.ts recognised the value with
 * certainty. An unrecognised value leaves this undefined and populates
 * `ownershipStartRejected` instead, so a whole column of dates AE could not
 * read becomes a visible warning rather than a silent drop.
 */
export interface NormalisedOwnershipStart {
  /** Midnight UTC at the recognised precision, ISO-8601. */
  dateIso: string;
  /** "day" | "month" | "year" — what the source actually supplied. */
  precision: string;
  /** The original cell value, preserved for audit. */
  raw: string;
}

export interface NormalisedProperty {
  address: NormalisedAddress;
  propertyType?: string;
  ownershipInfo?: string;
  /** Set when a mapped "date acquired" column was recognised. */
  ownershipStart?: NormalisedOwnershipStart;
  /** Set when such a column had a value that was NOT recognised, so validate.ts can warn. */
  ownershipStartRejected?: { raw: string; reason: string };
  notes?: string;
}

export interface NormalisedRelationship {
  rawType?: string; // original source value, preserved for audit (e.g. "Landlord")
  resolvedType: GrowRelationshipType; // "unknown_pending_review" when uncertain
  role?: string;
}

export interface ImportRowMeta {
  sourceRowNumber: number;
  sourceSheet?: string;
  originalValues: Record<string, string>;
  mappingConfidence: "high" | "medium" | "low" | "manual";
  warnings: string[];
}

export interface NormalisedImportRecord {
  person: NormalisedPerson;
  contactAddress?: NormalisedAddress; // the CONTACT's own address, if the source gave one
  property?: NormalisedProperty; // the PROPERTY being linked, if the source gave one
  relationship?: NormalisedRelationship;
  meta: ImportRowMeta;
}
