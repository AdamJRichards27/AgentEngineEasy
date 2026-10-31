import type { ReactNode } from "react";
import { Link } from "wouter";
import { useEntitlements } from "../lib/session";
import { RUN_ACCESS, runLinkAllowed } from "../minimal/minimalNav";

// Owner D5: links from Grow screens into Run pages are offered only with
// run.access. Without it the fallback renders instead (default: nothing), so a
// Grow-only user never lands on a 403. The server still enforces run.access.
export function RunGatedLink({ href, className, children, fallback = null }: {
  href: string;
  className?: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { hasEntitlement, isLoading } = useEntitlements();
  const entitlements = hasEntitlement(RUN_ACCESS) ? [RUN_ACCESS] : [];
  if (!runLinkAllowed(href, entitlements, isLoading)) return <>{fallback}</>;
  return <Link href={href} className={className}>{children}</Link>;
}
