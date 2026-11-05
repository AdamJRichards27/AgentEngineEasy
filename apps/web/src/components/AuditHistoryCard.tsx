// AE 2.0: the Settings "Audit history" card. Shown only when the SERVER says this user may read audit metadata (GET /audit/capabilities ->
// canReadAuditMetadata: a Brokerage Administrator of the caller's own brokerage), never inferred from the role. While the answer is unknown, or if it
// fails, nothing is drawn. The capabilities request is not itself an audit read; it is cached so it is not repeated on every visit or window focus.
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { parseAuditCapabilities, type AuditCapabilities } from "../lib/t280uContracts";

/** One definition of the capabilities request, shared by this card and the audit page so they use one cache entry. */
export const auditCapabilitiesQuery = {
  queryKey: ["audit-capabilities"],
  queryFn: async (): Promise<AuditCapabilities> => parseAuditCapabilities(await apiFetch("/audit/capabilities")),
  retry: false,
  staleTime: 5 * 60_000,
  refetchOnWindowFocus: false,
} as const;

export function AuditHistoryCardView() {
  return (
    <section className="card" data-ae-audit-card>
      <h2>Audit history</h2>
      <p className="muted">Who did what and when. Changed values stay encrypted unless an authorised Audit Value Reader asks for one entry, with a reason.</p>
      <Link href="/settings/audit" className="btn btn-secondary btn-small">
        View Audit history →
      </Link>
    </section>
  );
}

export function AuditHistoryCard() {
  const caps = useQuery<AuditCapabilities>(auditCapabilitiesQuery);
  if (!caps.data?.canReadAuditMetadata) return null;
  return <AuditHistoryCardView />;
}
