import { eq } from "drizzle-orm";
import { db, properties, propertyParties, parties } from "@aee/db";
import type { OwnershipRecord } from "@aee/integration-property-data";

function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function partyDisplayName(party: { firstName: string | null; lastName: string | null; organisationName: string | null }): string {
  return party.organisationName || [party.firstName, party.lastName].filter(Boolean).join(" ");
}

/**
 * Ownership-mismatch-as-review-not-block (Build Brief §8, ARCHITECTURE.md
 * §8). Never throws, never blocks the caller's write — it only ever flips a
 * review flag for the agent to look at. Trusts, companies, estates and
 * powers of attorney can legitimately not match a title owner's name, so
 * this is a prompt, not a validation error.
 */
export async function reviewOwnershipForProperty(propertyId: number): Promise<void> {
  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (!property || !property.ownershipData) return;

  const ownershipData = property.ownershipData as OwnershipRecord[];
  if (!Array.isArray(ownershipData) || ownershipData.length === 0) return;

  const links = await db
    .select()
    .from(propertyParties)
    .where(eq(propertyParties.propertyId, propertyId));
  const sellerLinks = links.filter((l) => l.role === "Seller");
  if (sellerLinks.length === 0) return; // nothing to compare yet

  const sellerParties = await Promise.all(
    sellerLinks.map((l) => db.select().from(parties).where(eq(parties.id, l.partyId)).then((r) => r[0])),
  );
  const sellerNames = sellerParties.filter(Boolean).map((p) => normalise(partyDisplayName(p!)));
  const ownerNames = ownershipData.map((o) => normalise(o.ownerName));

  const everySellerMatches = sellerNames.every((seller) =>
    ownerNames.some((owner) => owner.includes(seller) || seller.includes(owner)),
  );

  if (!everySellerMatches) {
    await db
      .update(properties)
      .set({ ownershipReviewRequired: true, updatedAt: new Date() })
      .where(eq(properties.id, propertyId));
  }
}
