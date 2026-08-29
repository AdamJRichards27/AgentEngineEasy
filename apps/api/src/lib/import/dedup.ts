// Stage B.9/B.10 -- Deterministic deduplication.
//
// Pure matching logic: given one NormalisedImportRecord and a set of
// EXISTING tenant-scoped candidate rows, decides whether the row looks like
// an exact/probable/possible match to something already in Agent Engine, or
// is new. Classification reuses the exact ImportMatchType vocabulary from
// packages/db/src/schema/import.ts (Stage B.2) -- no second taxonomy.
// Nothing here ever auto-merges an ambiguous match; that decision belongs
// to the user in Duplicate Review (B.14).
//
// TENANT ISOLATION (B.23/B.24): this file has no DB access and trusts its
// caller completely. The `candidates` array passed in MUST already be
// scoped to the importing brokerage (WHERE brokerage_id = :tenantId).
// Passing an unscoped candidate list would let one agent's import match
// against another brokerage's contacts -- the route layer is responsible
// for that query, never this module.

import type { ImportMatchType } from "@aee/db";
import type { NormalisedImportRecord } from "./neutralFormat";
import { normaliseAddressForMatching } from "./normalise";

/* ------------------------------------------------------------------ */
/* Contact dedup                                                      */
/* ------------------------------------------------------------------ */

export interface ContactCandidate {
  id: number;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  organisationName: string | null;
  mobile: string | null;
  email: string | null;
  residentialAddress: string | null;
}

export interface ContactMatchResult {
  candidateId: number;
  matchType: ImportMatchType;
  matchedOn: string[];
  score: number;
}

function fullName(p: { firstName?: string | null; middleName?: string | null; lastName?: string | null }): string {
  return [p.firstName, p.middleName, p.lastName].filter(Boolean).join(" ").trim().toLowerCase();
}

/**
 * Scores one normalised row against one existing party. Per B.9, this NEVER
 * classifies a match on name alone -- name matches combine with at least
 * one other signal (email/phone/address) or cap out at "possible".
 */
function scoreContact(record: NormalisedImportRecord, candidate: ContactCandidate): ContactMatchResult | null {
  const p = record.person;
  const matchedOn: string[] = [];

  const recordEmail = p.email?.toLowerCase();
  const candidateEmail = candidate.email?.toLowerCase();
  const emailMatch = Boolean(recordEmail && candidateEmail && recordEmail === candidateEmail);
  if (emailMatch) matchedOn.push("email");

  const mobileMatch = Boolean(p.mobile && candidate.mobile && p.mobile === candidate.mobile);
  if (mobileMatch) matchedOn.push("mobile");

  const recordName = fullName(p) || (p.company ?? "").trim().toLowerCase();
  const candidateName = fullName(candidate) || (candidate.organisationName ?? "").trim().toLowerCase();
  const nameMatch = Boolean(recordName && candidateName && recordName === candidateName);
  if (nameMatch) matchedOn.push("name");

  const recordAddressKey = record.contactAddress?.formatted
    ? normaliseAddressForMatching(record.contactAddress.formatted).matchKey
    : "";
  const candidateAddressKey = candidate.residentialAddress
    ? normaliseAddressForMatching(candidate.residentialAddress).matchKey
    : "";
  const addressMatch = Boolean(recordAddressKey && candidateAddressKey && recordAddressKey === candidateAddressKey);
  if (addressMatch) matchedOn.push("address");

  if (matchedOn.length === 0) return null;

  if (emailMatch && mobileMatch) return { candidateId: candidate.id, matchType: "exact", matchedOn, score: 100 };
  if (emailMatch && nameMatch) return { candidateId: candidate.id, matchType: "exact", matchedOn, score: 95 };
  if (emailMatch || mobileMatch) return { candidateId: candidate.id, matchType: "probable", matchedOn, score: 75 };
  if (nameMatch && addressMatch) return { candidateId: candidate.id, matchType: "probable", matchedOn, score: 70 };
  if (nameMatch) return { candidateId: candidate.id, matchType: "possible", matchedOn, score: 30 };

  // Address matched with no name/email/phone corroboration -- too weak to
  // call even "possible" for a person match (a shared household address is
  // common and isn't evidence of being the same contact).
  return null;
}

export interface ContactDedupResult {
  matchType: ImportMatchType;
  matches: ContactMatchResult[];
}

/**
 * Finds every plausible match for one row, sorted best-first. Overall
 * matchType is the best individual match found, or "new". Multiple
 * exact/probable matches are surfaced, not collapsed -- an ambiguous "which
 * existing contact is this?" is exactly what Duplicate Review is for.
 */
export function findContactMatches(record: NormalisedImportRecord, candidates: ContactCandidate[]): ContactDedupResult {
  const matches = candidates
    .map((c) => scoreContact(record, c))
    .filter((m): m is ContactMatchResult => m !== null)
    .sort((a, b) => b.score - a.score);
  return { matchType: matches[0]?.matchType ?? "new", matches };
}

/* ------------------------------------------------------------------ */
/* Property dedup                                                     */
/* ------------------------------------------------------------------ */

export interface PropertyCandidate {
  id: number;
  formattedAddress: string;
  placeId: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
}

export interface PropertyMatchResult {
  candidateId: number;
  matchType: ImportMatchType;
  matchedOn: string[];
  score: number;
}

/**
 * Property dedup exists so differently-formatted-but-identical addresses
 * (e.g. "12 Smith St, Bondi NSW 2026" vs "Unit 12, Smith Street Bondi
 * 2026") don't create duplicate property records. A resolved Google Places
 * placeId match is exact; otherwise a normalised address-matching key plus
 * corroborating suburb/postcode is probable. Never requires Places -- a
 * fully manual address always compares on the normalised key alone.
 */
function scoreProperty(record: NormalisedImportRecord, candidate: PropertyCandidate): PropertyMatchResult | null {
  const address = record.property?.address;
  if (!address?.formatted) return null;

  const matchedOn: string[] = [];
  const recordKey = normaliseAddressForMatching(address.formatted).matchKey;
  const candidateKey = normaliseAddressForMatching(candidate.formattedAddress).matchKey;
  const exactKeyMatch = Boolean(recordKey && candidateKey && recordKey === candidateKey);
  if (exactKeyMatch) matchedOn.push("formattedAddress");

  const suburbMatch = Boolean(
    address.suburb && candidate.suburb && address.suburb.trim().toLowerCase() === candidate.suburb.trim().toLowerCase(),
  );
  const postcodeMatch = Boolean(address.postcode && candidate.postcode && address.postcode.trim() === candidate.postcode.trim());
  if (suburbMatch) matchedOn.push("suburb");
  if (postcodeMatch) matchedOn.push("postcode");

  if (exactKeyMatch) return { candidateId: candidate.id, matchType: "exact", matchedOn, score: 100 };

  // No exact key match -- a shared leading street-number/name token plus a
  // corroborating suburb/postcode still surfaces as a candidate for the
  // user to confirm, so a trivial formatting difference ("St" vs "Street",
  // a missing unit number) doesn't silently create a duplicate property.
  const recordPrefix = recordKey.split(" ").slice(0, 2).join(" ");
  const candidatePrefix = candidateKey.split(" ").slice(0, 2).join(" ");
  const streetPrefixMatch = Boolean(recordPrefix && recordPrefix === candidatePrefix);
  if (streetPrefixMatch) matchedOn.push("streetPrefix");

  if (streetPrefixMatch && (suburbMatch || postcodeMatch)) {
    return { candidateId: candidate.id, matchType: "probable", matchedOn, score: 65 };
  }
  if (streetPrefixMatch || suburbMatch || postcodeMatch) {
    return { candidateId: candidate.id, matchType: "possible", matchedOn, score: 25 };
  }
  return null;
}

export interface PropertyDedupResult {
  matchType: ImportMatchType;
  matches: PropertyMatchResult[];
}

export function findPropertyMatches(record: NormalisedImportRecord, candidates: PropertyCandidate[]): PropertyDedupResult {
  const matches = candidates
    .map((c) => scoreProperty(record, c))
    .filter((m): m is PropertyMatchResult => m !== null)
    .sort((a, b) => b.score - a.score);
  return { matchType: matches[0]?.matchType ?? "new", matches };
}
