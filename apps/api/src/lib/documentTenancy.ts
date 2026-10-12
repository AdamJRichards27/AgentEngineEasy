import { sql } from "drizzle-orm";
import { documentObjectVersions, documents, properties, transactions } from "@aee/db";

/**
 * R-F44. `documents.brokerage_id` is NULL on property-backed rows. Migration
 * 0022's ownership check requires that: a Ready to List document has a
 * property and no brokerage column. The owning brokerage is resolved here,
 * in the SQL predicate, from that parent property or from a transaction on
 * the same property. When the column is present (a propertyless logical
 * document) it is the predicate instead.
 *
 * No backfill and no schema change. A later column fill is not required for
 * these reads and writes.
 */

/** Property-backed rows only. Logical documents (property_id NULL) do not match. */
export function propertyDocumentInBrokerage(brokerageId: number) {
  return sql`(
    (${documents.brokerageId} is null or ${documents.brokerageId} = ${brokerageId})
    and (
      ${documents.propertyId} in (
        select ${properties.id} from ${properties}
        where ${properties.brokerageId} = ${brokerageId}
      )
      or ${documents.propertyId} in (
        select ${transactions.propertyId} from ${transactions}
        inner join ${properties} on ${properties.id} = ${transactions.propertyId}
        where ${properties.brokerageId} = ${brokerageId}
      )
    )
  )`;
}

/**
 * Either form of ownership: brokerage_id when the row carries one and has no
 * property, or the parent property/transaction when brokerage_id is NULL.
 */
export function documentInBrokerage(brokerageId: number) {
  return sql`(
    (
      ${documents.brokerageId} is not null
      and ${documents.brokerageId} = ${brokerageId}
      and ${documents.propertyId} is null
    )
    or ${propertyDocumentInBrokerage(brokerageId)}
  )`;
}

/**
 * Parent scope when the caller has a property id and not a separate brokerage
 * parameter. The brokerage is the property's (or that property's transaction).
 */
export function documentOnProperty(propertyId: number) {
  return sql`(
    (
      ${documents.propertyId} = ${propertyId}
      or ${documents.propertyId} in (
        select ${transactions.propertyId} from ${transactions}
        where ${transactions.propertyId} = ${propertyId}
      )
    )
    and (
      ${documents.brokerageId} is null
      or ${documents.brokerageId} = (
        select ${properties.brokerageId} from ${properties}
        where ${properties.id} = ${propertyId}
      )
    )
  )`;
}

/**
 * Signed-download redemption has no session brokerage. The version row's
 * brokerage must be the document's brokerage column or the parent
 * property/transaction brokerage. A mismatched pair does not match.
 */
export function documentMatchesVersionBrokerage() {
  return sql`(
    (
      ${documents.brokerageId} is not null
      and ${documents.brokerageId} = ${documentObjectVersions.brokerageId}
      and ${documents.propertyId} is null
    )
    or (
      (${documents.brokerageId} is null or ${documents.brokerageId} = ${documentObjectVersions.brokerageId})
      and (
        ${documents.propertyId} in (
          select ${properties.id} from ${properties}
          where ${properties.brokerageId} = ${documentObjectVersions.brokerageId}
        )
        or ${documents.propertyId} in (
          select ${transactions.propertyId} from ${transactions}
          inner join ${properties} on ${properties.id} = ${transactions.propertyId}
          where ${properties.brokerageId} = ${documentObjectVersions.brokerageId}
        )
      )
    )
  )`;
}
