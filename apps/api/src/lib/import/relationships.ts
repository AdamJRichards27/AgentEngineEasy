// Stage B.11/B.12 -- Relationship resolution.
//
// A raw import source is usually one row per (contact, property,
// relationship) combination -- an owner of three properties appears as
// three rows; a jointly-owned property appears once per co-owner. Naive
// row-by-row import would flatten this into disconnected contacts and
// properties and lose the actual business relationships. This module
// reconstructs the real graph: WITHIN one import batch, rows that resolve
// to the same contact (or the same property) are merged into a single
// logical group with MULTIPLE relationship links, not duplicated --
// correctly supporting one-person/many-properties and one-property/
// many-people without ever flattening the relationships into text.
//
// Cross-batch dedup against EXISTING Agent Engine records (B.9/B.10,
// dedup.ts) is a separate, earlier step. This module's inputs already
// carry each row's best existing-record match (if any); within-batch
// grouping is layered on top using the same conservative rule as dedup.ts
// -- an exact existing-record match, or an exact email/mobile match,
// never name alone.
//
// Uses only the real GROW_RELATIONSHIP_TYPES vocabulary (via
// NormalisedRelationship.resolvedType, already resolved in normalise.ts).
// No second taxonomy is invented here.

import type { GrowRelationshipType, ImportMatchType } from "@aee/db";
import type { NormalisedImportRecord } from "./neutralFormat";
import { normaliseAddressForMatching } from "./normalise";

/* ------------------------------------------------------------------ */
/* Union-find helper                                                  */
/* ------------------------------------------------------------------ */

class UnionFind {
  private parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/* ------------------------------------------------------------------ */
/* Contact grouping                                                   */
/* ------------------------------------------------------------------ */

export interface ContactGroupInput {
  record: NormalisedImportRecord;
  existingMatch?: { matchType: ImportMatchType; partyId: number };
}

export interface ContactGroup {
  groupKey: string;
  existingPartyId?: number;
  conflict: boolean; // rows in this group point to more than one different existing party -- needs manual review, never auto-picked
  rowIndexes: number[];
}

/**
 * Groups rows that represent the same contact within this batch. Merges
 * only on an exact existing-party match, an exact email match, or an exact
 * mobile match -- never on name alone (same rule as dedup.ts's B.9
 * constraint, applied within-batch).
 */
export function groupContacts(inputs: ContactGroupInput[]): {
  groups: ContactGroup[];
  rowToGroupKey: Map<number, string>;
} {
  const uf = new UnionFind(inputs.length);

  const unionByKey = (keyOf: (i: number) => string | undefined) => {
    const byKey = new Map<string, number[]>();
    inputs.forEach((_, i) => {
      const key = keyOf(i);
      if (!key) return;
      const arr = byKey.get(key) ?? [];
      arr.push(i);
      byKey.set(key, arr);
    });
    for (const idxs of byKey.values()) for (let k = 1; k < idxs.length; k++) uf.union(idxs[0], idxs[k]);
  };

  unionByKey((i) => {
    const m = inputs[i].existingMatch;
    return m?.matchType === "exact" ? `existing:${m.partyId}` : undefined;
  });
  unionByKey((i) => inputs[i].record.person.email?.toLowerCase() || undefined);
  unionByKey((i) => inputs[i].record.person.mobile || undefined);

  const rootToRows = new Map<number, number[]>();
  inputs.forEach((_, i) => {
    const r = uf.find(i);
    const arr = rootToRows.get(r) ?? [];
    arr.push(i);
    rootToRows.set(r, arr);
  });

  const groups: ContactGroup[] = [];
  const rowToGroupKey = new Map<number, string>();
  let counter = 0;
  for (const rowIndexes of rootToRows.values()) {
    const groupKey = `contact-${counter++}`;
    const existingIds = new Set(
      rowIndexes
        .map((i) => (inputs[i].existingMatch?.matchType === "exact" ? inputs[i].existingMatch!.partyId : undefined))
        .filter((x): x is number => x !== undefined),
    );
    groups.push({
      groupKey,
      existingPartyId: existingIds.size === 1 ? [...existingIds][0] : undefined,
      conflict: existingIds.size > 1,
      rowIndexes,
    });
    rowIndexes.forEach((i) => rowToGroupKey.set(i, groupKey));
  }
  return { groups, rowToGroupKey };
}

/* ------------------------------------------------------------------ */
/* Property grouping                                                  */
/* ------------------------------------------------------------------ */

export interface PropertyGroupInput {
  record: NormalisedImportRecord;
  existingMatch?: { matchType: ImportMatchType; propertyId: number };
}

export interface PropertyGroup {
  groupKey: string;
  existingPropertyId?: number;
  conflict: boolean;
  rowIndexes: number[];
}

/**
 * Groups rows that reference the same property within this batch. Rows
 * with no property on them are skipped (a contact-only row is still valid
 * and simply contributes no property group / no relationship link).
 */
export function groupProperties(inputs: PropertyGroupInput[]): {
  groups: PropertyGroup[];
  rowToGroupKey: Map<number, string>;
} {
  const propertyRowIndexes = inputs
    .map((inp, i) => (inp.record.property?.address?.formatted ? i : -1))
    .filter((i) => i >= 0);

  const uf = new UnionFind(inputs.length);

  const unionByKey = (keyOf: (i: number) => string | undefined) => {
    const byKey = new Map<string, number[]>();
    for (const i of propertyRowIndexes) {
      const key = keyOf(i);
      if (!key) continue;
      const arr = byKey.get(key) ?? [];
      arr.push(i);
      byKey.set(key, arr);
    }
    for (const idxs of byKey.values()) for (let k = 1; k < idxs.length; k++) uf.union(idxs[0], idxs[k]);
  };

  unionByKey((i) => {
    const m = inputs[i].existingMatch;
    return m?.matchType === "exact" ? `existing:${m.propertyId}` : undefined;
  });
  unionByKey((i) => normaliseAddressForMatching(inputs[i].record.property!.address!.formatted).matchKey || undefined);

  const rootToRows = new Map<number, number[]>();
  for (const i of propertyRowIndexes) {
    const r = uf.find(i);
    const arr = rootToRows.get(r) ?? [];
    arr.push(i);
    rootToRows.set(r, arr);
  }

  const groups: PropertyGroup[] = [];
  const rowToGroupKey = new Map<number, string>();
  let counter = 0;
  for (const rowIndexes of rootToRows.values()) {
    const groupKey = `property-${counter++}`;
    const existingIds = new Set(
      rowIndexes
        .map((i) => (inputs[i].existingMatch?.matchType === "exact" ? inputs[i].existingMatch!.propertyId : undefined))
        .filter((x): x is number => x !== undefined),
    );
    groups.push({
      groupKey,
      existingPropertyId: existingIds.size === 1 ? [...existingIds][0] : undefined,
      conflict: existingIds.size > 1,
      rowIndexes,
    });
    rowIndexes.forEach((i) => rowToGroupKey.set(i, groupKey));
  }
  return { groups, rowToGroupKey };
}

/* ------------------------------------------------------------------ */
/* Relationship link resolution                                       */
/* ------------------------------------------------------------------ */

export interface ResolvedRelationshipLink {
  contactGroupKey: string;
  propertyGroupKey: string;
  relationshipType: GrowRelationshipType;
  rawType?: string;
  needsPendingReview: boolean;
  rowIndexes: number[]; // every source row that contributed this link -- usually one; >1 means duplicate rows in the source
}

/**
 * Builds the final Person<->Property link graph from per-row group
 * assignments. A contact group linked to N property groups across N rows
 * naturally yields N links (one person, many properties); a property group
 * linked from M different contact groups yields M links (one property,
 * many people). Identical (contact, property, relationshipType) links from
 * duplicate source rows are collapsed into one link with multiple
 * rowIndexes rather than creating a duplicate growRelationships row.
 */
export function resolveRelationshipLinks(
  records: NormalisedImportRecord[],
  contactRowToGroupKey: Map<number, string>,
  propertyRowToGroupKey: Map<number, string>,
): ResolvedRelationshipLink[] {
  const byKey = new Map<string, ResolvedRelationshipLink>();

  records.forEach((record, rowIndex) => {
    if (!record.property?.address?.formatted) return; // nothing to link on this row
    const contactGroupKey = contactRowToGroupKey.get(rowIndex);
    const propertyGroupKey = propertyRowToGroupKey.get(rowIndex);
    if (!contactGroupKey || !propertyGroupKey) return;

    const resolvedType: GrowRelationshipType = record.relationship?.resolvedType ?? "unknown_pending_review";
    const key = `${contactGroupKey}::${propertyGroupKey}::${resolvedType}`;

    const existing = byKey.get(key);
    if (existing) {
      existing.rowIndexes.push(rowIndex);
      return;
    }
    byKey.set(key, {
      contactGroupKey,
      propertyGroupKey,
      relationshipType: resolvedType,
      rawType: record.relationship?.rawType,
      needsPendingReview: resolvedType === "unknown_pending_review",
      rowIndexes: [rowIndex],
    });
  });

  return [...byKey.values()];
}
