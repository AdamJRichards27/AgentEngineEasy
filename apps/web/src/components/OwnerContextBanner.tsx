import { Link } from "wouter";
import { apiErrorMessage } from "../lib/api";
import { useOwnerContext } from "../lib/owner";
import type { SessionUser } from "../lib/session";
import "./Owner.css";

export function OwnerContextBanner({ user }: { user: SessionUser }) {
  const context = useOwnerContext();
  const selected = user.ownerSelectedBrokerageId != null;
  return (
    <section className="owner-context" aria-label="Platform owner brokerage context">
      <div className="owner-context-header">
        <strong>
          {selected
            ? `Selected brokerage: ${user.brokerageName ?? `Brokerage #${user.ownerSelectedBrokerageId}`}`
            : "Platform Owner — no brokerage selected"}
        </strong>
        <div className="owner-actions">
          <Link href="/owner" className="btn btn-secondary btn-small">Switch brokerage</Link>
          {selected && (
            <button type="button" className="btn btn-secondary btn-small" disabled={context.isPending}
              onClick={() => context.mutate({ brokerageId: null })}>
              {context.isPending ? "Exiting…" : "Exit brokerage"}
            </button>
          )}
        </div>
      </div>
      <p className="muted">
        {selected
          ? "You are working as a Brokerage Administrator. Changes apply to this brokerage; you are not impersonating a user."
          : "Select a brokerage to manage its users, invitations and operations."}
      </p>
      {context.isError && <p className="error-text" role="alert">
        {apiErrorMessage(context.error, "Couldn't exit this brokerage. Try again.")}
      </p>}
    </section>
  );
}
