import { Link } from "wouter";

// AE Mobile (CC Task #64, M2): one property on a phone list or in search. Presentational: no hooks,
// no network. The whole row is the one tap target. Reused by the Properties list in M4.

export interface MobilePropertyRowData {
  id: number;
  href: string;
  address: string;
  location: string;
  /** Run-only (workflow stage). Present only for users who may see Run data; omitted for Grow-only users. */
  stage?: string;
}

export function MobilePropertyRow({ property, onOpen }: { property: MobilePropertyRowData; onOpen?: () => void }) {
  return (
    <Link href={property.href} className="mob-row" onClick={onOpen}>
      <span className="mob-row-main">
        <span className="mob-row-title mob-row-address">{property.address}</span>
        <span className="mob-row-sub">{property.location}</span>
      </span>
      {property.stage ? <span className="mob-row-stage">{property.stage}</span> : null}
    </Link>
  );
}
