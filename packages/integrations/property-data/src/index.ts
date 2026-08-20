// Provider abstraction (Build Brief §18-19). Route/UI code depends only on
// this interface, never on a specific provider — swapping providers later
// is a factory config change, not a redesign.

export interface AddressCandidate {
  placeId: string;
  formattedAddress: string;
  suburb?: string;
  state?: string;
  postcode?: string;
}

export interface OwnershipRecord {
  ownerName: string;
  ownershipType?: string; // e.g. "Individual", "Company", "Trust"
}

export interface PropertyDataProvider {
  searchAddress(query: string): Promise<AddressCandidate[]>;
  lookupOwnership(placeId: string): Promise<OwnershipRecord[] | null>;
}

/**
 * Ships by default so the app runs end-to-end with no credentials.
 * Swap for a real Google Places / Pricefinder-equivalent adapter behind the
 * same interface — see ARCHITECTURE.md §5, §7.
 */
export class MockPropertyDataProvider implements PropertyDataProvider {
  async searchAddress(query: string): Promise<AddressCandidate[]> {
    return [
      {
        placeId: `mock-${encodeURIComponent(query)}`,
        formattedAddress: query,
        state: undefined,
      },
    ];
  }

  async lookupOwnership(_placeId: string): Promise<OwnershipRecord[] | null> {
    return null; // no ownership data available — caller must not hard-block on this
  }
}

export function createPropertyDataProvider(): PropertyDataProvider {
  const provider = process.env.PROPERTY_DATA_PROVIDER ?? "mock";
  switch (provider) {
    case "mock":
    default:
      return new MockPropertyDataProvider();
    // case "google-places": return new GooglePlacesProvider(...);
    // case "pricefinder": return new PricefinderProvider(...);
  }
}
