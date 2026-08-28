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

export interface NormalisedProperty {
  address: NormalisedAddress;
  propertyType?: string;
  ownershipInfo?: string;
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
