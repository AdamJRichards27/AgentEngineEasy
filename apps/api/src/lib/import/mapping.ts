// Column detection & mapping (Stage B.6). Suggests a canonical field for
// each source header using a normalised alias lookup, but NEVER silently
// resolves an ambiguous header - anything not recognised maps to null and
// is left for the user to assign explicitly. The mapping the user confirms
// is what the pipeline replays verbatim; nothing is re-guessed later.

export const CANONICAL_FIELDS = [
  "person.title",
  "person.firstName",
  "person.middleName",
  "person.lastName",
  "person.preferredName",
  "person.company",
  "person.email",
  "person.alternateEmail",
  "person.mobile",
  "person.alternatePhone",
  "contactAddress.full",
  "contactAddress.unit",
  "contactAddress.streetNumber",
  "contactAddress.streetName",
  "contactAddress.suburb",
  "contactAddress.state",
  "contactAddress.postcode",
  "contactAddress.country",
  "property.address.full",
  "property.address.unit",
  "property.address.streetNumber",
  "property.address.streetName",
  "property.address.suburb",
  "property.address.state",
  "property.address.postcode",
  "property.type",
  "property.ownership",
  // AE GROW "Brokerage-wide Signal Sweep" stage 2. The one piece of data the
  // long_ownership_tenure rule genuinely needs and could not previously get:
  // WHEN the owner acquired the property. Almost every real CRM/trust-account
  // export carries it under one of the aliases below, and until now the
  // pipeline dropped it on the floor, which is why the tenure rule could only
  // ever have measured how long AE had known about the row.
  "property.ownershipStartDate",
  "property.notes",
  "relationship.type",
] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

function normaliseHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[_\-./]/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Alias keys are pre-normalised via normaliseHeader() so lookups are exact
// after normalisation - this is what lets "Mobile Phone", "mobile_phone" and
// "MOBILE-PHONE" all resolve to the same canonical field.
const ALIASES: Record<string, CanonicalField> = {
  "title": "person.title",
  "salutation": "person.title",
  "first name": "person.firstName",
  "firstname": "person.firstName",
  "given name": "person.firstName",
  "middle name": "person.middleName",
  "last name": "person.lastName",
  "lastname": "person.lastName",
  "surname": "person.lastName",
  "family name": "person.lastName",
  "preferred name": "person.preferredName",
  "nickname": "person.preferredName",
  "known as": "person.preferredName",
  "company": "person.company",
  "organisation": "person.company",
  "organization": "person.company",
  "business name": "person.company",
  "email": "person.email",
  "email address": "person.email",
  "e mail": "person.email",
  "alternate email": "person.alternateEmail",
  "alt email": "person.alternateEmail",
  "secondary email": "person.alternateEmail",
  "mobile": "person.mobile",
  "mobile phone": "person.mobile",
  "mobile number": "person.mobile",
  "cell": "person.mobile",
  "cell phone": "person.mobile",
  "phone": "person.alternatePhone",
  "phone number": "person.alternatePhone",
  "telephone": "person.alternatePhone",
  "home phone": "person.alternatePhone",
  "landline": "person.alternatePhone",
  "alternate phone": "person.alternatePhone",
  "alt phone": "person.alternatePhone",
  "work phone": "person.alternatePhone",
  // A bare "address" on a real-estate contact export is, by convention,
  // usually the PROPERTY address (this is a property-relationship-centric
  // database) - explicit "mailing"/"postal"/"residential" wording is what
  // routes to the contact's own address instead. Both are only defaults:
  // fully user-editable in the mapping step.
  "mailing address": "contactAddress.full",
  "postal address": "contactAddress.full",
  "residential address": "contactAddress.full",
  "contact address": "contactAddress.full",
  "unit": "contactAddress.unit",
  "unit number": "contactAddress.unit",
  "street number": "contactAddress.streetNumber",
  "street name": "contactAddress.streetName",
  "street": "contactAddress.streetName",
  "suburb": "contactAddress.suburb",
  "city": "contactAddress.suburb",
  "state": "contactAddress.state",
  "postcode": "contactAddress.postcode",
  "post code": "contactAddress.postcode",
  "zip": "contactAddress.postcode",
  "zip code": "contactAddress.postcode",
  "country": "contactAddress.country",
  "address": "property.address.full",
  "property address": "property.address.full",
  "full address": "property.address.full",
  "property type": "property.type",
  "ownership": "property.ownership",
  // Ownership start date. Every alias here names the start of an OWNERSHIP;
  // deliberately absent is a bare "sale date" / "last sold", which is a fact
  // about the property rather than about the person currently recorded as its
  // owner (the same distinction lib/ownershipStart.ts's
  // PROVIDER_OWNERSHIP_START_KEYS draws). As with every alias in this table,
  // these are suggestions only and remain fully editable in the mapping step.
  "ownership start date": "property.ownershipStartDate",
  "ownership start": "property.ownershipStartDate",
  "owned since": "property.ownershipStartDate",
  "owner since": "property.ownershipStartDate",
  "date acquired": "property.ownershipStartDate",
  "acquired date": "property.ownershipStartDate",
  "acquired": "property.ownershipStartDate",
  "acquisition date": "property.ownershipStartDate",
  "purchase date": "property.ownershipStartDate",
  "date purchased": "property.ownershipStartDate",
  "date of purchase": "property.ownershipStartDate",
  "settlement date": "property.ownershipStartDate",
  "notes": "property.notes",
  "comments": "property.notes",
  "relationship": "relationship.type",
  "relationship type": "relationship.type",
  "contact type": "relationship.type",
  "role": "relationship.type",
};

export interface ColumnMappingSuggestion {
  sourceHeader: string;
  canonicalField: CanonicalField | null;
  confidence: "high" | "none";
}

// Automatic mapping is suggestion-only. It never applies itself - the
// caller always shows this to the user for confirmation/edit before it is
// persisted as the job's mapping (Stage B.6: "automatic mapping must remain
// editable... do not silently guess ambiguous mappings").
export function suggestMapping(headers: string[]): ColumnMappingSuggestion[] {
  return headers.map((sourceHeader) => {
    const key = normaliseHeader(sourceHeader);
    const canonicalField = ALIASES[key] ?? null;
    return {
      sourceHeader,
      canonicalField,
      confidence: canonicalField ? "high" : "none",
    };
  });
}

export type ColumnMapping = Record<string, CanonicalField | null>; // sourceHeader -> canonicalField

export function mappingToRecord(suggestions: ColumnMappingSuggestion[]): ColumnMapping {
  const out: ColumnMapping = {};
  for (const s of suggestions) out[s.sourceHeader] = s.canonicalField;
  return out;
}

// Applies a confirmed mapping to one raw row, producing a flat canonical-field
// -> value map. Purely mechanical - normalise.ts is what turns this into a
// typed NormalisedImportRecord.
export function applyMapping(rawRow: Record<string, string>, mapping: ColumnMapping): Partial<Record<CanonicalField, string>> {
  const out: Partial<Record<CanonicalField, string>> = {};
  for (const [header, value] of Object.entries(rawRow)) {
    const field = mapping[header];
    if (!field) continue;
    const trimmed = (value ?? "").trim();
    if (trimmed.length === 0) continue;
    // If two source columns map to the same field, keep the first non-empty value.
    if (!out[field]) out[field] = trimmed;
  }
  return out;
}
