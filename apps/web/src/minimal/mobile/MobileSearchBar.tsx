import { Link } from "wouter";
import { MOBILE_TODAY_SEARCH_LABEL } from "./mobileLabels";
import { MOBILE_SEARCH_ROUTE } from "./mobileSearchConfig";

// AE Mobile (CC Task #64, M2): the search bar at the top of Today on a phone. It is a link styled
// as a field, so tapping it opens /search with the keyboard up and Today never jumps. Presentational.
// Shown on phones only: mobile.css hides it above the phone breakpoint.
export function MobileSearchBar() {
  return (
    <Link href={MOBILE_SEARCH_ROUTE} className="mob-searchbar" aria-label={MOBILE_TODAY_SEARCH_LABEL}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-4-4" />
      </svg>
      <span>{MOBILE_TODAY_SEARCH_LABEL}</span>
    </Link>
  );
}
