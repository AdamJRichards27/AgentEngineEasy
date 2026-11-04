// t273u (X12): Run's property workspace shows the same read-only Primary
// marker as Grow desktop ("Owner · Primary") and the phone ("Primary"), from
// the isPrimary flag the workspace API already returns on each
// property_parties link. Display only: no control, no new permission.
export const PRIMARY_MARKER_LABEL = "Primary";

export function runPartyPrimaryMarker(link: { isPrimary?: boolean | null }): string | null {
  return link.isPrimary === true ? PRIMARY_MARKER_LABEL : null;
}
