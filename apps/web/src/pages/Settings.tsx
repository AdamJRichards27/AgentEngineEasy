import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch, apiErrorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import OwnNameForm from "../components/OwnNameForm";

interface CatalogueProduct {
  productId: number;
  code: string;
  name: string;
  description: string | null;
  priceId: number | null;
  amountCents: number | null;
  currency: string | null;
  billingInterval: string | null;
}

interface SubscriptionSummary {
  id: number;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

interface SubscriptionResponse {
  subscription: SubscriptionSummary | null;
  entitlements: string[];
}

function billingErrorMessage(error: unknown): string {
  return apiErrorMessage(error, "Something went wrong. Try again.");
}

function formatPrice(amountCents: number | null, currency: string | null, interval: string | null): string {
  if (amountCents === null || currency === null) return "Contact us";
  const amount = (amountCents / 100).toLocaleString(undefined, { style: "currency", currency });
  return interval ? `${amount}/${interval}` : amount;
}

export default function Settings() {
  const { user } = useSession();
  const isAdmin = user?.role === "Brokerage Administrator";
  const queryClient = useQueryClient();

  const subscription = useQuery<SubscriptionResponse>({
    queryKey: ["billing-subscription"],
    queryFn: () => apiFetch("/billing/subscription"),
  });
  const catalogue = useQuery<{ products: CatalogueProduct[] }>({
    queryKey: ["billing-catalogue"],
    queryFn: () => apiFetch("/billing/catalogue"),
    enabled: isAdmin,
  });

  const invalidateBilling = () => {
    queryClient.invalidateQueries({ queryKey: ["billing-subscription"] });
    queryClient.invalidateQueries({ queryKey: ["grow-access"] });
  };

  const checkout = useMutation({
    mutationFn: (productCode: string) =>
      apiFetch("/billing/checkout", { method: "POST", body: JSON.stringify({ productCode }) }),
    onSuccess: invalidateBilling,
  });

  const cancel = useMutation({
    mutationFn: (atPeriodEnd: boolean) =>
      apiFetch("/billing/cancel", { method: "POST", body: JSON.stringify({ atPeriodEnd }) }),
    onSuccess: invalidateBilling,
  });

  const needsName = !user?.firstName?.trim() || !user?.lastName?.trim();

  return (
    <div>
      <h1>Settings</h1>
      <section className="card" id="profile">
        <h2>{needsName ? "Complete your profile" : "Your name"}</h2>
        <p className="muted">
          {needsName
            ? "Add your first and last name. This is the name your brokerage and Pit Crew see."
            : "This is the name your brokerage and Pit Crew see."}
        </p>
        <OwnNameForm
          key={`${user?.id ?? "signed-out"}:${user?.firstName ?? ""}:${user?.lastName ?? ""}`}
          initialFirstName={user?.firstName ?? ""}
          initialLastName={user?.lastName ?? ""}
        />
        <p>
          {user?.email}
        </p>
        <p className="muted">
          {user?.brokerageName} · {user?.role}
        </p>
      </section>

      <section className="card">
        <h2>Billing</h2>
        {subscription.isLoading && <p className="muted">Loading…</p>}
        {subscription.data?.subscription ? (
          <>
            <p>
              Status: <span className="pill pill-success">{subscription.data.subscription.status}</span>
              {subscription.data.subscription.cancelAtPeriodEnd && (
                <span className="pill pill-warning" style={{ marginLeft: "0.5rem" }}>
                  Cancels at period end
                </span>
              )}
            </p>
            {subscription.data.subscription.currentPeriodEnd && (
              <p className="muted">
                Current period ends {new Date(subscription.data.subscription.currentPeriodEnd).toLocaleDateString()}
              </p>
            )}
            <p className="muted">Active entitlements: {subscription.data.entitlements.join(", ") || "none"}</p>
            {isAdmin && !subscription.data.subscription.cancelAtPeriodEnd && (
              <button className="btn btn-secondary btn-small" onClick={() => cancel.mutate(true)} disabled={cancel.isPending}>
                Cancel at period end
              </button>
            )}
          </>
        ) : (
          <p className="muted">No active subscription. Brokerage-wide activation is the only allocation unit in this build - office/team seat allocation is not yet available.</p>
        )}
        {/* AE GROW Completion W2-B (G-5): was `((checkout.error ?? cancel.error) as ApiError)
            .friendly`, which renders the literal string "undefined" whenever the failure isn't an
            ApiError — a dropped connection during checkout being the obvious one, on the one
            screen where the agent is trying to pay. */}
        {(checkout.isError || cancel.isError) && (
          <p className="error-text">{billingErrorMessage(checkout.error ?? cancel.error)}</p>
        )}

        {isAdmin && catalogue.data && catalogue.data.products.length > 0 && (
          <div className="billing-plan-grid">
            {catalogue.data.products.map((p) => (
              <div className="billing-plan-card" key={p.productId}>
                <div className="plan-name">{p.name}</div>
                <div className="plan-price">{formatPrice(p.amountCents, p.currency, p.billingInterval)}</div>
                {p.description && <p className="muted">{p.description}</p>}
                <button
                  className="btn btn-primary btn-small"
                  onClick={() => checkout.mutate(p.code)}
                  disabled={checkout.isPending}
                >
                  {checkout.isPending ? "Starting…" : "Subscribe"}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {isAdmin && (
        <section className="card">
          <h2>Users &amp; Access</h2>
          <p className="muted">
            Invite team members, manage existing accounts, and handle data export/deletion requests — every account
            in this app starts as an admin-issued invitation.
          </p>
          <Link href="/settings/users" className="btn btn-secondary btn-small">
            Manage Users &amp; Access →
          </Link>
        </section>
      )}

      {isAdmin && (
        <section className="card">
          <h2>Integrations</h2>
          <p className="muted">Connect and manage provider integrations — portals, communications, and financial status feeds (mock/sandbox providers only in this build).</p>
          <Link href="/settings/integrations" className="btn btn-secondary btn-small">
            Manage Integrations →
          </Link>
        </section>
      )}

      <p className="muted">Pit Crew configuration lands here as later phases build it out.</p>
    </div>
  );
}
