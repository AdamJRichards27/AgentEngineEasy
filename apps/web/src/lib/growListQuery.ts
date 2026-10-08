/** Query string for a Grow list page. Absent filters are omitted. */
export function growListPath(
  path: string,
  params: {
    search?: string;
    role?: string;
    cursor?: string | null;
    excludePartyId?: number;
    id?: number;
  } = {},
): string {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.role) query.set("role", params.role);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.excludePartyId !== undefined) query.set("excludePartyId", String(params.excludePartyId));
  if (params.id !== undefined) query.set("id", String(params.id));
  const text = query.toString();
  return text.length > 0 ? `${path}?${text}` : path;
}

/** Screen-reader and visible "Showing N of M" line for a filtered list. */
export function showingCountLabel(shown: number, total: number, singular: string, plural: string): string {
  return `Showing ${shown} of ${total} ${total === 1 ? singular : plural}`;
}
