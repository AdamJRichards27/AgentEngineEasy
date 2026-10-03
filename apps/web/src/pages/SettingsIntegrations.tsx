// Agent Engine 2.0 — AE Step 5 remediation — Integration administration UI
// (Settings → Integrations).
//
// The six required views (Overview, Connection Detail, Activity,
// Dead-Letter/Recovery, Reconciliation, Connection Controls) as five tabs —
// Connection Detail and Connection Controls share one surface inside the
// Connections tab, the same "one card renders detail + every available
// action, no separate detail screen that could drift out of sync" pattern
// PitCrewCommandCentre.tsx's PcItemCard already established for this app.
//
// Section 10's hard requirement shapes every render here: a catalogue
// provider with no connection (connectionId === null) is ALWAYS rendered
// as its own distinct "Not Connected" state — never the same label/tone as
// any real connection status. RBAC is enforced at the API (every
// /integrations/* route is requireRole(...BROKERAGE_ADMIN_ROLES) —
// routes/integrations.ts's own header comment); the isAdmin gate below is
// the same "UX nicety, not the security boundary" convention every other
// role-gated page in this app already uses (see App.tsx's canSeePitCrew/
// canSeeFinancial). No secret/credential value is ever requested from or
// rendered by this page — mint-credential's own response never carries one
// (Section 10), so there is nothing here to redact.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../lib/session";
import { apiFetch, ApiError, apiErrorMessage } from "../lib/api";
import { GrowTableScroll } from "../components/GrowTableScroll";
import {
  approvalStatusLabel,
  approvalStatusPillClass,
  activityStatusLabel,
  activityStatusPillClass,
  capabilityLabel,
  categoryLabel,
  configureConnection,
  connectionStatusLabel,
  connectionStatusPillClass,
  createIntegrationConnection,
  decideConnectionApproval,
  fetchDeadLetters,
  fetchIntegrationActivity,
  fetchIntegrationConnectionDetail,
  fetchIntegrationConnections,
  fetchIntegrationOverview,
  fetchIntegrationProviders,
  fetchIntegrationSettings,
  fetchReconciliationSnapshot,
  healthStatusLabel,
  healthStatusPillClass,
  mintConnectionCredential,
  NOT_CONNECTED_LABEL,
  NOT_CONNECTED_PILL_CLASS,
  reconciliationStatusLabel,
  reconciliationStatusPillClass,
  replayDeadLetter,
  requestConnectionApproval,
  resumeConnectionCall,
  revokeConnectionCall,
  suspendConnectionCall,
  updateIntegrationSettingsCall,
  validateConnectionCall,
  type IntegrationActivityFilter,
  type IntegrationConnection,
  type IntegrationOverviewRow,
  type IntegrationProvider,
} from "../lib/integrations";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "connections", label: "Connections" },
  { key: "activity", label: "Activity" },
  { key: "deadLetters", label: "Dead Letters" },
  { key: "reconciliation", label: "Reconciliation" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

interface Focus {
  tab: TabKey;
  connectionId?: string;
  providerId?: string;
}

export default function SettingsIntegrations() {
  const { user, isLoading: sessionLoading } = useSession();
  const isAdmin = user?.role === "Brokerage Administrator";
  const [tab, setTab] = useState<TabKey>("overview");
  const [focusConnectionId, setFocusConnectionId] = useState<string | null>(null);
  const [prefillProviderId, setPrefillProviderId] = useState<string | null>(null);

  if (sessionLoading) return <p className="muted">Loading…</p>;

  if (!isAdmin) {
    return (
      <div className="primary-action">
        <p className="eyebrow">Settings</p>
        <h2>Integrations</h2>
        <p className="muted">Integration settings are only visible to Brokerage Administrators.</p>
      </div>
    );
  }

  function goTo(focus: Focus) {
    setTab(focus.tab);
    setFocusConnectionId(focus.connectionId ?? null);
    setPrefillProviderId(focus.providerId ?? null);
  }

  return (
    <div className="stack">
      <div className="primary-action">
        <p className="eyebrow">Settings</p>
        <h2>Integrations</h2>
        <p className="muted">Provider-neutral connections, activity, dead-letter recovery, and reconciliation evidence — every connection here is a mock/sandbox provider (Section 18: no live third-party connection ships in this build).</p>
      </div>

      <nav className="pc-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={`pc-tab${tab === t.key ? " active" : ""}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "overview" && <OverviewTab onViewConnection={goTo} />}
      {tab === "connections" && (
        <ConnectionsTab focusConnectionId={focusConnectionId} prefillProviderId={prefillProviderId} onConsumedFocus={() => { setFocusConnectionId(null); setPrefillProviderId(null); }} />
      )}
      {tab === "activity" && <ActivityTab />}
      {tab === "deadLetters" && <DeadLettersTab />}
      {tab === "reconciliation" && <ReconciliationTab />}
    </div>
  );
}

// =======================================================================
// 12.1 Overview.
// =======================================================================

function OverviewTab({ onViewConnection }: { onViewConnection: (focus: Focus) => void }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["integration-settings"], queryFn: fetchIntegrationSettings });
  const overview = useQuery({ queryKey: ["integration-overview"], queryFn: fetchIntegrationOverview });
  const [maxConnectionsInput, setMaxConnectionsInput] = useState<string | null>(null);

  const updateSettings = useMutation({
    mutationFn: updateIntegrationSettingsCall,
    onSuccess: (updated) => {
      queryClient.setQueryData(["integration-settings"], updated);
      setMaxConnectionsInput(null);
    },
  });

  if (settings.isLoading || overview.isLoading) return <p className="muted">Loading…</p>;
  if (settings.isError || !settings.data) return <p className="error-text">{settings.error instanceof ApiError ? settings.error.friendly : "Couldn't load integration settings."}</p>;
  if (overview.isError || !overview.data) return <p className="error-text">{overview.error instanceof ApiError ? overview.error.friendly : "Couldn't load the integration overview."}</p>;

  const s = settings.data;

  return (
    <>
      <section className="card">
        <h2>Brokerage Settings</h2>
        <p>
          Integrations are{" "}
          <span className={s.enabled ? "pill pill-success" : "pill"}>{s.enabled ? "Enabled" : "Disabled"}</span>
        </p>
        <p className="muted">No connection — however far through approval — can ever be used while this is off (Section 4's fail-closed brokerage switch).</p>
        <div className="inline-form">
          <button className="btn btn-secondary btn-small" disabled={updateSettings.isPending} onClick={() => updateSettings.mutate({ enabled: !s.enabled })}>
            {s.enabled ? "Disable Integrations" : "Enable Integrations"}
          </button>
          <span className="muted">Max active connections:</span>
          <input
            type="number"
            min={0}
            max={100}
            style={{ width: "5rem" }}
            value={maxConnectionsInput ?? String(s.maxActiveConnections)}
            onChange={(e) => setMaxConnectionsInput(e.target.value)}
          />
          {maxConnectionsInput !== null && maxConnectionsInput !== String(s.maxActiveConnections) && (
            <button
              className="btn btn-primary btn-small"
              disabled={updateSettings.isPending}
              onClick={() => updateSettings.mutate({ maxActiveConnections: Number(maxConnectionsInput) })}
            >
              Save
            </button>
          )}
        </div>
        {updateSettings.isError && <p className="error-text">{apiErrorMessage(updateSettings.error, "Couldn't save integration settings. Try again.")}</p>}
      </section>

      <section className="card">
        <h2>Provider Catalogue</h2>
        <p className="muted">Every provider row below is a MOCK/sandbox catalogue entry (Section 18) — installing one never contacts a real third party.</p>
        <div className="billing-plan-grid">
          {overview.data.map((row) => (
            <ProviderOverviewCard key={row.providerId + (row.connectionId ?? "")} row={row} onView={onViewConnection} />
          ))}
        </div>
      </section>
    </>
  );
}

function ProviderOverviewCard({ row, onView }: { row: IntegrationOverviewRow; onView: (focus: Focus) => void }) {
  const connected = row.connectionId !== null;
  return (
    <div className="billing-plan-card">
      <div className="plan-name">{row.displayName}</div>
      <p className="muted">
        {categoryLabel(row.category)} · {row.environmentClassification}
      </p>
      <p className="muted">{row.capabilities.map(capabilityLabel).join(", ")}</p>

      {!connected ? (
        <p>
          <span className={NOT_CONNECTED_PILL_CLASS}>{NOT_CONNECTED_LABEL}</span>
        </p>
      ) : (
        <div className="stack" style={{ gap: "0.35rem" }}>
          <p>
            <span className={connectionStatusPillClass(row.connectionStatus!)}>{connectionStatusLabel(row.connectionStatus!)}</span>{" "}
            {row.health && <span className={healthStatusPillClass(row.health)}>{healthStatusLabel(row.health)}</span>}
          </p>
          {row.approvalStatus && <p className="muted">Approval: <span className={approvalStatusPillClass(row.approvalStatus)}>{approvalStatusLabel(row.approvalStatus)}</span></p>}
          <p className="muted">
            {row.outstandingFailures} retrying · {row.deadLetterCount} dead-lettered
          </p>
          {row.reconciliationStatus !== "NOT_APPLICABLE" && (
            <p className="muted">
              Reconciliation: <span className={reconciliationStatusPillClass(row.reconciliationStatus)}>{reconciliationStatusLabel(row.reconciliationStatus)}</span>
            </p>
          )}
          {row.lastSuccessfulActivityAt && <p className="muted">Last activity {new Date(row.lastSuccessfulActivityAt).toLocaleString()}</p>}
        </div>
      )}

      <button
        className="btn btn-secondary btn-small"
        onClick={() => onView(connected ? { tab: "connections", connectionId: row.connectionId! } : { tab: "connections", providerId: row.providerId })}
      >
        {connected ? "View Connection" : "Connect…"}
      </button>
    </div>
  );
}

// =======================================================================
// Connections (list + create form + inline detail/controls).
// =======================================================================

function ConnectionsTab({
  focusConnectionId,
  prefillProviderId,
  onConsumedFocus,
}: {
  focusConnectionId: string | null;
  prefillProviderId: string | null;
  onConsumedFocus: () => void;
}) {
  const connections = useQuery({ queryKey: ["integration-connections"], queryFn: fetchIntegrationConnections });
  const [expandedId, setExpandedId] = useState<string | null>(focusConnectionId);
  const [showCreateForm, setShowCreateForm] = useState(prefillProviderId !== null);
  // Captured once at mount, not re-derived from the live prop — onConsumedFocus
  // below clears the PARENT's prefillProviderId as soon as this tab has
  // registered the intent to show the create form, so CreateConnectionForm
  // must read its prefill from this stable local copy rather than the raw
  // prop (which can otherwise already be null by the time the connections
  // list finishes loading and this component's JSX finally reaches the
  // create-form section, a real race this app's own tests caught).
  const [capturedPrefillProviderId] = useState(prefillProviderId);

  useEffect(() => {
    if (focusConnectionId) {
      setExpandedId(focusConnectionId);
      onConsumedFocus();
    } else if (prefillProviderId) {
      setShowCreateForm(true);
      onConsumedFocus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusConnectionId, prefillProviderId]);

  return (
    <>
      <section className="card">
        <h2>New Connection</h2>
        {!showCreateForm ? (
          <button className="btn btn-primary btn-small" onClick={() => setShowCreateForm(true)}>
            Start a new connection…
          </button>
        ) : (
          <CreateConnectionForm prefillProviderId={capturedPrefillProviderId} onDone={() => setShowCreateForm(false)} />
        )}
      </section>

      <section className="card">
        <h2>Connections{connections.data ? ` (${connections.data.length})` : ""}</h2>
        {connections.isLoading && <p className="muted">Loading…</p>}
        {(connections.isError || (!connections.isLoading && !connections.data)) && (
          <p className="error-text">{connections.error instanceof ApiError ? connections.error.friendly : "Couldn't load connections."}</p>
        )}
        {connections.data && connections.data.length === 0 && <p className="empty-state">No connections yet.</p>}
        {connections.data && connections.data.length > 0 && (
          <ul className="item-list">
            {connections.data.map((c) => (
              <li key={c.id}>
                <div className="pc-item-header">
                  <button className="btn btn-link" onClick={() => setExpandedId((cur) => (cur === c.id ? null : c.id))}>
                    <strong>{c.displayName}</strong>
                  </button>
                  <span className={connectionStatusPillClass(c.status)}>{connectionStatusLabel(c.status)}</span>
                </div>
                <p className="muted">
                  {c.providerId} · <span className={healthStatusPillClass(c.healthStatus)}>{healthStatusLabel(c.healthStatus)}</span>
                </p>
                {expandedId === c.id && <ConnectionDetail connection={c} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function CreateConnectionForm({ prefillProviderId, onDone }: { prefillProviderId: string | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ["integration-providers"], queryFn: fetchIntegrationProviders });
  const [providerId, setProviderId] = useState(prefillProviderId ?? "");
  const [displayName, setDisplayName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);

  const create = useMutation({
    mutationFn: createIntegrationConnection,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integration-connections"] });
      queryClient.invalidateQueries({ queryKey: ["integration-overview"] });
      onDone();
    },
  });

  const selectedProvider = providers.data?.find((p: IntegrationProvider) => p.id === providerId);

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!providerId || !displayName.trim() || !purpose.trim() || scopes.length === 0) return;
        create.mutate({ providerId, displayName: displayName.trim(), purpose: purpose.trim(), requestedScopes: scopes });
      }}
    >
      <select
        value={providerId}
        onChange={(e) => {
          setProviderId(e.target.value);
          setScopes([]);
        }}
        required
      >
        <option value="">Select a provider…</option>
        {providers.data?.map((p: IntegrationProvider) => (
          <option key={p.id} value={p.id}>
            {p.displayName} ({categoryLabel(p.category)})
          </option>
        ))}
      </select>
      {selectedProvider && <p className="muted">{selectedProvider.description}</p>}
      <input placeholder="Connection name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
      <textarea placeholder="Purpose — why does this brokerage need this connection?" value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} required />
      {selectedProvider && (
        <div>
          <p className="muted">Requested capabilities:</p>
          {selectedProvider.capabilities.map((cap) => (
            <label key={cap} style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={scopes.includes(cap)}
                onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, cap] : cur.filter((c) => c !== cap)))}
              />{" "}
              {capabilityLabel(cap)}
            </label>
          ))}
        </div>
      )}
      <div className="inline-form">
        <button className="btn btn-primary btn-small" type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create Draft Connection"}
        </button>
        <button className="btn btn-link btn-small" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      {create.isError && <p className="error-text">{apiErrorMessage(create.error, "Couldn't create that connection. Try again.")}</p>}
    </form>
  );
}

function ConnectionDetail({ connection }: { connection: IntegrationConnection }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["integration-connection", connection.id], queryFn: () => fetchIntegrationConnectionDetail(connection.id) });
  const [confirmingSuspend, setConfirmingSuspend] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [reason, setReason] = useState("");
  const [approvedScopes, setApprovedScopes] = useState<string[] | null>(null);
  const [mintedNote, setMintedNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["integration-connection", connection.id] });
    queryClient.invalidateQueries({ queryKey: ["integration-connections"] });
    queryClient.invalidateQueries({ queryKey: ["integration-overview"] });
  }

  function opts() {
    return {
      onSuccess: () => {
        setActionError(null);
        setConfirmingSuspend(false);
        setConfirmingRevoke(false);
        setReason("");
        invalidate();
      },
      onError: (err: unknown) => setActionError(err instanceof ApiError ? err.friendly : "Something went wrong. Try again."),
    };
  }

  const requestApprovalMut = useMutation({ mutationFn: requestConnectionApproval, ...opts() });
  const decideApprovalMut = useMutation({ mutationFn: decideConnectionApproval, ...opts() });
  const mintMut = useMutation({
    mutationFn: mintConnectionCredential,
    onSuccess: (credential) => {
      setActionError(null);
      setMintedNote(`Credential reference minted (${credential.referenceType}) — no secret value is ever returned to this page.`);
      invalidate();
    },
    onError: (err: unknown) => setActionError(err instanceof ApiError ? err.friendly : "Something went wrong. Try again."),
  });
  const configureMut = useMutation({ mutationFn: configureConnection, ...opts() });
  const validateMut = useMutation({ mutationFn: validateConnectionCall, ...opts() });
  const suspendMut = useMutation({ mutationFn: suspendConnectionCall, ...opts() });
  const resumeMut = useMutation({ mutationFn: resumeConnectionCall, ...opts() });
  const revokeMut = useMutation({ mutationFn: revokeConnectionCall, ...opts() });

  const busy = requestApprovalMut.isPending || decideApprovalMut.isPending || mintMut.isPending || configureMut.isPending || validateMut.isPending || suspendMut.isPending || resumeMut.isPending || revokeMut.isPending;

  const c = detail.data?.connection ?? connection;

  return (
    <div className="pc-inline-form stack">
      <p>{c.purpose}</p>
      <p className="muted">Requested: {(c.requestedScopes ?? []).map(capabilityLabel).join(", ") || "none"}</p>
      <p className="muted">Approved: {(c.approvedScopes ?? []).map(capabilityLabel).join(", ") || "none yet"}</p>
      {c.lastValidationResult && (
        <p className="muted">
          Last validation ({new Date(c.lastValidationResult.at).toLocaleString()}): {c.lastValidationResult.ok ? "OK" : "Failed"} — {c.lastValidationResult.detail}
        </p>
      )}
      {c.suspendReason && <p className="muted">Suspend reason: {c.suspendReason}</p>}
      {c.revokeReason && <p className="muted">Revoke reason: {c.revokeReason}</p>}
      {c.rejectReason && <p className="muted">Reject reason: {c.rejectReason}</p>}
      {mintedNote && <p className="muted">{mintedNote}</p>}
      {actionError && <p className="error-text">{actionError}</p>}

      <div className="pc-item-actions">
        {c.status === "DRAFT" && (
          <button className="btn btn-primary btn-small" disabled={busy} onClick={() => requestApprovalMut.mutate({ id: c.id, expectedVersion: c.version })}>
            Request Approval
          </button>
        )}

        {c.status === "PENDING_APPROVAL" && (
          <ApprovalForm
            connection={c}
            approvedScopes={approvedScopes ?? c.requestedScopes}
            onChangeScopes={setApprovedScopes}
            reason={reason}
            onChangeReason={setReason}
            busy={busy}
            onApprove={() => decideApprovalMut.mutate({ id: c.id, expectedVersion: c.version, decision: "APPROVED", approvedScopes: approvedScopes ?? c.requestedScopes, reason: reason || null })}
            onReject={() => decideApprovalMut.mutate({ id: c.id, expectedVersion: c.version, decision: "REJECTED", reason: reason || "Rejected by administrator." })}
          />
        )}

        {(c.status === "APPROVED" || c.status === "CONFIGURING") && (
          <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => mintMut.mutate({ id: c.id })}>
            Mint Credential Reference
          </button>
        )}
        {c.status === "APPROVED" && (
          <button className="btn btn-primary btn-small" disabled={busy} onClick={() => configureMut.mutate({ id: c.id, expectedVersion: c.version })}>
            Begin Configuration
          </button>
        )}
        {(c.status === "CONFIGURING" || c.status === "VALIDATION_FAILED") && (
          <button className="btn btn-primary btn-small" disabled={busy} onClick={() => validateMut.mutate({ id: c.id, expectedVersion: c.version })}>
            {c.status === "VALIDATION_FAILED" ? "Retry Validation" : "Validate Connection"}
          </button>
        )}

        {c.status === "ACTIVE" && !confirmingSuspend && !confirmingRevoke && (
          <>
            <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => setConfirmingSuspend(true)}>
              Suspend…
            </button>
            <button className="btn btn-danger btn-small" disabled={busy} onClick={() => setConfirmingRevoke(true)}>
              Revoke…
            </button>
          </>
        )}
        {c.status === "SUSPENDED" && !confirmingRevoke && (
          <>
            <button className="btn btn-primary btn-small" disabled={busy} onClick={() => resumeMut.mutate({ id: c.id, expectedVersion: c.version })}>
              Resume
            </button>
            <button className="btn btn-danger btn-small" disabled={busy} onClick={() => setConfirmingRevoke(true)}>
              Revoke…
            </button>
          </>
        )}
      </div>

      {confirmingSuspend && (
        <div className="inline-form">
          <input placeholder="Reason for suspending" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn btn-secondary btn-small" disabled={busy || !reason.trim()} onClick={() => suspendMut.mutate({ id: c.id, expectedVersion: c.version, reason: reason.trim() })}>
            {suspendMut.isPending ? "Suspending…" : "Confirm Suspend"}
          </button>
          <button className="btn btn-link btn-small" onClick={() => setConfirmingSuspend(false)}>
            Cancel
          </button>
        </div>
      )}
      {confirmingRevoke && (
        <div className="inline-form">
          <input placeholder="Reason for revoking" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn btn-danger btn-small" disabled={busy || !reason.trim()} onClick={() => revokeMut.mutate({ id: c.id, expectedVersion: c.version, reason: reason.trim() })}>
            {revokeMut.isPending ? "Revoking…" : "Confirm Revoke — this is terminal"}
          </button>
          <button className="btn btn-link btn-small" onClick={() => setConfirmingRevoke(false)}>
            Cancel
          </button>
        </div>
      )}

      {c.status === "ACTIVE" && c.providerId === "mock_sms_v1" && <SendSmsAction connectionId={c.id} onDone={invalidate} />}
      {c.status === "ACTIVE" && c.providerId === "mock_payment_status_v1" && <LinkPaymentReferenceAction connectionId={c.id} onDone={invalidate} />}

      {detail.data && detail.data.transitions.length > 0 && (
        <details className="section">
          <summary>Transition history ({detail.data.transitions.length})</summary>
          <ul className="item-list plain">
            {detail.data.transitions.map((t) => (
              <li key={t.id}>
                <strong>{t.transitionType}</strong> {t.fromValue ? `${t.fromValue} → ${t.toValue}` : t.toValue}
                <div className="muted">
                  {new Date(t.occurredAt).toLocaleString()} · {t.actorType}
                  {t.reason ? ` — ${t.reason}` : ""}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ApprovalForm({
  connection,
  approvedScopes,
  onChangeScopes,
  reason,
  onChangeReason,
  busy,
  onApprove,
  onReject,
}: {
  connection: IntegrationConnection;
  approvedScopes: string[];
  onChangeScopes: (scopes: string[]) => void;
  reason: string;
  onChangeReason: (reason: string) => void;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="stack" style={{ width: "100%" }}>
      <p className="muted">Approve exactly the capabilities this connection actually needs — approval never grants more than was requested.</p>
      {connection.requestedScopes.map((cap) => (
        <label key={cap} style={{ display: "block" }}>
          <input
            type="checkbox"
            checked={approvedScopes.includes(cap)}
            onChange={(e) => onChangeScopes(e.target.checked ? [...approvedScopes, cap] : approvedScopes.filter((c) => c !== cap))}
          />{" "}
          {capabilityLabel(cap)}
        </label>
      ))}
      <input placeholder="Reason / notes (optional for approval, used as the reject reason)" value={reason} onChange={(e) => onChangeReason(e.target.value)} />
      <div className="inline-form">
        <button className="btn btn-primary btn-small" disabled={busy || approvedScopes.length === 0} onClick={onApprove}>
          Approve
        </button>
        <button className="btn btn-danger btn-small" disabled={busy} onClick={onReject}>
          Reject
        </button>
      </div>
    </div>
  );
}

// Operational test actions (Section 15's "controlled actions") — Proof B/C's
// own working actions beyond generic lifecycle management. Deliberately
// plain numeric-id entry: these are ops/testing tools for an administrator
// who already knows the record id from Communications/Financial, not a
// second guided compose flow duplicating those domains' own UI.
function SendSmsAction({ connectionId, onDone }: { connectionId: string; onDone: () => void }) {
  const [messageId, setMessageId] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: (id: number) => apiFetch<{ result: { outcome: string; status: string } }>(`/integrations/connections/${connectionId}/actions/send-sms`, { method: "POST", body: JSON.stringify({ messageId: id }) }),
    onSuccess: (r) => {
      setError(null);
      setResult(`Outcome: ${r.result.outcome} (message status ${r.result.status})`);
      onDone();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.friendly : "Something went wrong."),
  });
  return (
    <details className="section">
      <summary>Operational test action: send an existing SMS message through this connection</summary>
      <div className="inline-form">
        <input placeholder="Communication message id" value={messageId} onChange={(e) => setMessageId(e.target.value)} />
        <button className="btn btn-secondary btn-small" disabled={mut.isPending || !messageId} onClick={() => mut.mutate(Number(messageId))}>
          {mut.isPending ? "Sending…" : "Send"}
        </button>
      </div>
      {result && <p className="muted">{result}</p>}
      {error && <p className="error-text">{error}</p>}
    </details>
  );
}

function LinkPaymentReferenceAction({ connectionId, onDone }: { connectionId: string; onDone: () => void }) {
  const [paymentRequestId, setPaymentRequestId] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: (args: { id: number; ref: string }) =>
      apiFetch<{ linked: boolean }>(`/integrations/connections/${connectionId}/actions/link-payment-reference`, {
        method: "POST",
        body: JSON.stringify({ paymentRequestId: args.id, externalReference: args.ref }),
      }),
    onSuccess: () => {
      setError(null);
      setResult("Linked — this only records the external reference; it never moves money or marks the obligation reconciled.");
      onDone();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.friendly : "Something went wrong."),
  });
  return (
    <details className="section">
      <summary>Operational test action: link a payment request to the mock processor's external reference</summary>
      <div className="inline-form">
        <input placeholder="Payment request id" value={paymentRequestId} onChange={(e) => setPaymentRequestId(e.target.value)} />
        <input placeholder="External reference" value={externalReference} onChange={(e) => setExternalReference(e.target.value)} />
        <button
          className="btn btn-secondary btn-small"
          disabled={mut.isPending || !paymentRequestId || !externalReference.trim()}
          onClick={() => mut.mutate({ id: Number(paymentRequestId), ref: externalReference.trim() })}
        >
          {mut.isPending ? "Linking…" : "Link"}
        </button>
      </div>
      {result && <p className="muted">{result}</p>}
      {error && <p className="error-text">{error}</p>}
    </details>
  );
}

// =======================================================================
// 12.3 Activity.
// =======================================================================

function ActivityTab() {
  const connections = useQuery({ queryKey: ["integration-connections"], queryFn: fetchIntegrationConnections });
  const [filter, setFilter] = useState<IntegrationActivityFilter>({});
  const activity = useQuery({ queryKey: ["integration-activity", filter], queryFn: () => fetchIntegrationActivity(filter) });

  return (
    <section className="card">
      <h2>Activity</h2>
      <div className="inline-form">
        <select value={filter.connectionId ?? ""} onChange={(e) => setFilter((f) => ({ ...f, connectionId: e.target.value || undefined }))}>
          <option value="">All connections</option>
          {connections.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName}
            </option>
          ))}
        </select>
        <select value={filter.direction ?? ""} onChange={(e) => setFilter((f) => ({ ...f, direction: (e.target.value || undefined) as "OUTBOUND" | "INBOUND" | undefined }))}>
          <option value="">Both directions</option>
          <option value="OUTBOUND">Outbound</option>
          <option value="INBOUND">Inbound</option>
        </select>
      </div>

      {activity.isLoading && <p className="muted">Loading…</p>}
      {activity.isError && <p className="error-text">{activity.error instanceof ApiError ? activity.error.friendly : "Couldn't load activity."}</p>}
      {activity.data && activity.data.length === 0 && <p className="empty-state">No activity yet.</p>}
      {activity.data && activity.data.length > 0 && (
        <GrowTableScroll>
        <table className="grow-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Direction</th>
              <th>Capability / Event</th>
              <th>Status</th>
              <th>Retries</th>
              <th>Correlation Id</th>
            </tr>
          </thead>
          <tbody>
            {activity.data.map((row) => (
              <tr key={`${row.direction}-${row.id}`}>
                <td>{new Date(row.occurredAt).toLocaleString()}</td>
                <td>{row.direction}</td>
                <td>{row.capabilityOrEventType}</td>
                <td>
                  <span className={activityStatusPillClass(row)}>{activityStatusLabel(row)}</span>
                </td>
                <td>{row.retryCount ?? "—"}</td>
                <td className="muted">{row.correlationId ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </GrowTableScroll>
      )}
    </section>
  );
}

// =======================================================================
// Dead letters / recovery.
// =======================================================================

function DeadLettersTab() {
  const queryClient = useQueryClient();
  const deadLetters = useQuery({ queryKey: ["integration-dead-letters"], queryFn: fetchDeadLetters });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  const replay = useMutation({
    mutationFn: replayDeadLetter,
    onMutate: (args) => setBusyId(args.id),
    onSuccess: (_result, args) => {
      setErrorById((cur) => ({ ...cur, [args.id]: "" }));
      queryClient.invalidateQueries({ queryKey: ["integration-dead-letters"] });
      queryClient.invalidateQueries({ queryKey: ["integration-overview"] });
      queryClient.invalidateQueries({ queryKey: ["integration-activity"] });
    },
    onError: (err: unknown, args) => setErrorById((cur) => ({ ...cur, [args.id]: err instanceof ApiError ? err.friendly : "Replay failed." })),
    onSettled: () => setBusyId(null),
  });

  if (deadLetters.isLoading) return <p className="muted">Loading…</p>;
  if (deadLetters.isError || !deadLetters.data) return <p className="error-text">{deadLetters.error instanceof ApiError ? deadLetters.error.friendly : "Couldn't load dead letters."}</p>;

  return (
    <section className="card">
      <h2>Dead Letters ({deadLetters.data.length})</h2>
      <p className="muted">Only an authorised replay (below) re-enters the exact same dispatch path the original attempt used — nothing here is a shortcut around it.</p>
      {deadLetters.data.length === 0 ? (
        <p className="empty-state">No dead letters.</p>
      ) : (
        <ul className="item-list">
          {deadLetters.data.map((d) => (
            <li key={d.id}>
              <div className="pc-item-header">
                <strong>{d.sourceType}</strong>
                {d.replayedAt ? (
                  <span className={d.replayResult === "SUCCESS" ? "pill pill-success" : "pill pill-danger"}>
                    Replayed — {d.replayResult === "SUCCESS" ? "Success" : "Failed"}
                  </span>
                ) : (
                  <span className="pill pill-warning">Not Replayed</span>
                )}
              </div>
              <p className="muted">{d.reason}</p>
              <p className="muted">{new Date(d.occurredAt).toLocaleString()}</p>
              {!d.replayedAt && (
                <button className="btn btn-secondary btn-small" disabled={busyId === d.id} onClick={() => replay.mutate({ id: d.id })}>
                  {busyId === d.id ? "Replaying…" : "Replay"}
                </button>
              )}
              {errorById[d.id] && <p className="error-text">{errorById[d.id]}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// =======================================================================
// 12.5 Reconciliation.
// =======================================================================

function ReconciliationTab() {
  const snapshot = useQuery({ queryKey: ["integration-reconciliation"], queryFn: fetchReconciliationSnapshot });

  if (snapshot.isLoading) return <p className="muted">Loading…</p>;
  if (snapshot.isError || !snapshot.data) return <p className="error-text">{snapshot.error instanceof ApiError ? snapshot.error.friendly : "Couldn't load the reconciliation snapshot."}</p>;

  const s = snapshot.data;
  return (
    <section className="card">
      <h2>Reconciliation</h2>
      <p className="muted">
        A live-computed snapshot, scope: {s.scope.replaceAll("_", " ").toLowerCase()}. This is evidence for a human to review — a provider event can never, by itself, mark an AE obligation
        reconciled (Proof C's own boundary).
      </p>
      <div className="stat-tiles">
        <div className="stat-tile">
          <span className="stat-tile-label">AE Records</span>
          <span className="stat-tile-value">{s.aeRecordCount}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile-label">Provider Records</span>
          <span className="stat-tile-value">{s.providerRecordCount}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile-label">Matched</span>
          <span className="stat-tile-value">{s.matchedCount}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile-label">Missing</span>
          <span className="stat-tile-value">{s.missingCount}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile-label">Field Mismatch</span>
          <span className="stat-tile-value">{s.fieldMismatchCount}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile-label">Unmapped</span>
          <span className="stat-tile-value">{s.unresolvedMappingCount}</span>
        </div>
      </div>
      <p className="muted">Computed {new Date(s.computedAt).toLocaleString()}</p>
    </section>
  );
}
