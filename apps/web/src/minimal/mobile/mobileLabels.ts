// AE Mobile (CC Task #64, M2): plain-language labels for the phone screens. Display only; stored
// values never change. Pure: no React, no network.

export const MOBILE_COMING_SOON = "Coming soon";
export const MOBILE_TODAY_SEARCH_LABEL = "Search people or properties";

/** PastClient -> "Past client", AppraisalProspect -> "Appraisal prospect". One word is unchanged. */
export function roleLabel(role: string): string {
  const spaced = role.replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  if (spaced.length === 0) return role;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
