import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "../lib/api";
import { useSession, useEntitlements } from "../lib/session";
import { AskAgentEngine } from "../components/AskAgentEngine";
import {
  type GrowTodayAction,
  type GrowTodaySummary,
  formatGeneratedAt,
  formatWhen,
  priorityLabel,
  priorityPillClass,
} from "../lib/growToday";

interface GrowAccess {
  entitled: boolean;
  entitlements: string[];
  billingProviderName: string;
}

interface GrowRelationship {
  id: number;
  relationshipType: string;
  role: string | null;
  status: string;
  isPrimary: boolean;
  partyFirstName: string | null;
  partyLastName: string | null;
  partyOrganisationName: string | null;
  propertyAddress: string;
}

interface GrowActivity {
  id: number;
  activityType: string;
  occurredAt: string;
  summary: string;
}

interface GrowOpportunity {
  id: number;
  opportunityType: string;
  status: string;
  stage: string;
  reason: string;
}

// Minimal proving UI for Stage A (ARCHITECTURE.md Grow Subscription/Entitlement/Core Data
// build): a locked upgrade screen for brokerages without grow.access, and a real workspace once
// entitled. This page's own /grow/access check is a rendering convenience only - every
// data-bearing request below is independently re-checked server-side via requireEntitlement.
//
// AE GROW Priority 1 — Daily Command Centre: the entitled workspace below (GrowWorkspace) is now
// tabbed rather than one long flat page — Today (this priority's actual deliverable, and the
// default landing tab), Opportunities, Contacts, Nurture, Performance, Ask AE — mirroring
// PitCrewCommandCentre.tsx's own internal `.pc-tabs` sub-navigation pattern rather than adding
// new top-level wouter routes (RUN already owns the top-level /today route — see App.tsx).
// Nurture and Performance are clearly-labelled "coming soon" placeholders: no backend exists for
// either yet, and Priority 1 does not build one.
export default function Grow() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const access = useQuery<GrowAccess>({
    queryKey: ["grow-access"],
    queryFn: () => apiFetch("/grow/access"),
  });

  const checkout = useMutation({
    mutationFn: () =>
      apiFetch("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ productCode: "grow" }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grow-access"] });
    },
  });

  if (access.isLoading) {
    return <div className="app-loading">Loading…</div>;
  }

  if (!access.data?.entitled) {
    return (
      <div>
        <h1>Grow</h1>
        <section className="card grow-locked">
          <h2>Grow is not active for your brokerage</h2>
          <p className="muted">
            Grow turns every appraisal, buyer enquiry, and past client into a tracked relationship
            and a visible next action - no separate contact database, no unexplained scores.
          </p>
          {access.data?.billingProviderName === "mock" && (
            <p className="muted pilot-mode-note">
              Sandbox billing — this is test-mode only. No real card is charged and no real subscription is created.
            </p>
          )}
          {user?.role === "Brokerage Administrator" ? (
            <>
              <button className="btn btn-primary" onClick={() => checkout.mutate()} disabled={checkout.isPending}>
                {checkout.isPending ? "Starting checkout…" : "Add Grow"}
              </button>
              {checkout.isError && <p className="error-text">{(checkout.error as ApiError).friendly}</p>}
            </>
          ) : (
            <p className="muted">Ask a Brokerage Administrator to add Grow from Settings → Billing.</p>
          )}
        </section>
      </div>
    );
  }

  return <GrowWorkspace />;
}

type GrowTab = "today" | "opportunities" | "contacts" | "nurture" | "performance" | "askAE";

const GROW_TABS: Array<{ key: GrowTab; label: string }> = [
  { key: "today", label: "Today" },
  { key: "opportunities", label: "Opportunities" },
  { key: "contacts", label: "Contacts" },
  { key: "nurture", label: "Nurture" },
  { key: "performance", label: "Performance" },
  { key: "askAE", label: "Ask AE" },
];

function GrowWorkspace() {
  const [tab, setTab] = useState<GrowTab>("today");
  // Re-uses the "grow-access" query the outer Grow() component already fetched (react-query
  // dedupes by key, so this is not a second network request) purely to read
  // billingProviderName for the sandbox-billing note below.
  const access = useQuery<GrowAccess>({
    queryKey: ["grow-access"],
    queryFn: () => apiFetch("/grow/access"),
  });

  return (
    <div>
      <h1>Grow</h1>
      <p className="muted">
        <Link href="/grow/import">Import contacts &amp; properties &rarr;</Link>
      </p>
      {access.data?.billingProviderName === "mock" && (
        <p className="muted pilot-mode-note">Sandbox billing is active — no real charge or subscription exists behind this workspace.</p>
      )}

      <nav className="pc-tabs grow-tabs" aria-label="Grow sections">
        {GROW_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`pc-tab${tab === t.key ? " active" : ""}`}
            aria-current={tab === t.key ? "page" : undefined}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "today" && <GrowToday onAskAE={() => setTab("askAE")} />}
      {tab === "opportunities" && <GrowOpportunitiesTab />}
      {tab === "contacts" && <GrowContactsTab />}
      {tab === "nurture" && (
        <GrowComingSoon
          title="Nurture"
          description="Automated nurture sequences and campaigns are planned for a future Grow release. Nothing here is active yet."
        />
      )}
      {tab === "performance" && (
        <GrowComingSoon
          title="Performance"
          description="Agent performance coaching and reporting are planned for a future Grow release. Nothing here is active yet."
        />
      )}
      {tab === "askAE" && <GrowAskAETab />}
    </div>
  );
}

// AE GROW Priority 1 — Daily Command Centre. The screen this priority actually exists to build:
// a small set of headline indicators (never vanity metrics -- each one is a real, countable
// thing on this brokerage's own Grow data) plus a deterministically-prioritised action feed, each
// item explaining, in plain language, why AE is surfacing it (see
// apps/api/src/lib/growToday.ts's own header comment for the full rule set -- nothing here is
// predictive scoring). One request (GET /grow/today) renders this whole tab.
function GrowToday({ onAskAE }: { onAskAE: () => void }) {
  const { user } = useSession();
  const { hasEntitlement } = useEntitlements();

  const today = useQuery<GrowTodaySummary>({
    queryKey: ["grow-today"],
    queryFn: () => apiFetch("/grow/today"),
  });

  if (today.isLoading) {
    return <p className="muted">Loading today's priorities…</p>;
  }

  if (today.isError || !today.data) {
    return <p className="error-text">{today.error instanceof ApiError ? today.error.friendly : "Couldn't load Today."}</p>;
  }

  const data = today.data;
  const canAddNote = hasEntitlement("grow.activities.manage");
  const canManageOpportunities = hasEntitlement("grow.opportunities.manage");

  const doNow = data.priorityActions.filter((a) => a.priority === "DoNow");
  const doToday = data.priorityActions.filter((a) => a.priority === "DoToday");
  const keepWarm = data.priorityActions.filter((a) => a.priority === "KeepWarm");

  return (
    <div>
      <div className="primary-action">
        <div className="eyebrow">Grow</div>
        <h2>{user ? `Hi ${user.firstName} — here's what needs your attention today` : "Today"}</h2>
        <p className="muted">As of {formatGeneratedAt(data.generatedAt)}.</p>
      </div>

      <div className="stat-tiles">
        <StatTile label="Priority Actions" value={data.counts.priorityActions} />
        <StatTile label="Follow-Ups Due" value={data.counts.followUpsDue} />
        <StatTile label="Open Opportunities" value={data.counts.openOpportunities} />
        <StatTile label="Contacts Needing Attention" value={data.counts.contactsNeedingAttention} />
      </div>

      {!data.hasAnyGrowData ? (
        <section className="card">
          <h2>Let's find your next opportunity</h2>
          <p className="muted">
            Grow turns every appraisal, buyer enquiry, and past client into a tracked relationship and a visible
            next action. Get started:
          </p>
          <div className="grow-empty-actions">
            <Link href="/grow/import" className="btn btn-primary btn-small">
              Import contacts &amp; properties
            </Link>
          </div>
        </section>
      ) : data.priorityActions.length === 0 ? (
        <section className="card">
          <p className="empty-state">You're all caught up — nothing needs your attention right now.</p>
        </section>
      ) : (
        <>
          {doNow.length > 0 && (
            <section className="card">
              <h2>Do Now ({doNow.length})</h2>
              <ul className="item-list grow-action-list">
                {doNow.map((item) => (
                  <GrowActionCard
                    key={item.id}
                    item={item}
                    canAddNote={canAddNote}
                    canManageOpportunities={canManageOpportunities}
                    onAskAE={onAskAE}
                  />
                ))}
              </ul>
            </section>
          )}

          {doToday.length > 0 && (
            <section className="card">
              <h2>Do Today ({doToday.length})</h2>
              <ul className="item-list grow-action-list">
                {doToday.map((item) => (
                  <GrowActionCard
                    key={item.id}
                    item={item}
                    canAddNote={canAddNote}
                    canManageOpportunities={canManageOpportunities}
                    onAskAE={onAskAE}
                  />
                ))}
              </ul>
            </section>
          )}

          {keepWarm.length > 0 && (
            <details className="section" open={doNow.length === 0 && doToday.length === 0}>
              <summary>Keep Warm ({keepWarm.length})</summary>
              <ul className="item-list grow-action-list">
                {keepWarm.map((item) => (
                  <GrowActionCard
                    key={item.id}
                    item={item}
                    canAddNote={canAddNote}
                    canManageOpportunities={canManageOpportunities}
                    onAskAE={onAskAE}
                  />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-tile">
      <div className="stat-tile-label">{label}</div>
      <div className="stat-tile-value">{value}</div>
    </div>
  );
}

interface GrowActionCardProps {
  item: GrowTodayAction;
  canAddNote: boolean;
  canManageOpportunities: boolean;
  onAskAE: () => void;
}

// One card renders every supported action for that item, same "no separate detail screen"
// convention PitCrewCommandCentre.tsx's PcItemCard already established for this codebase. Every
// button rendered here is backed by a real, already-working capability (POST /grow/activities,
// PATCH /grow/opportunities/:id, or a real /properties/:id link) -- nothing here is a dead
// button, and each one is additionally hidden unless the signed-in user actually holds the
// entitlement that write requires (see canAddNote/canManageOpportunities above), so a button
// that would just 403 is never shown in the first place.
function GrowActionCard({ item, canAddNote, canManageOpportunities, onAskAE }: GrowActionCardProps) {
  const queryClient = useQueryClient();
  const [openForm, setOpenForm] = useState<"note" | "nextAction" | null>(null);
  const [noteText, setNoteText] = useState("");
  const [nextActionDate, setNextActionDate] = useState("");
  const [nextActionText, setNextActionText] = useState("");

  function invalidateToday() {
    queryClient.invalidateQueries({ queryKey: ["grow-today"] });
  }

  const addNote = useMutation({
    mutationFn: (summary: string) =>
      apiFetch("/grow/activities", {
        method: "POST",
        body: JSON.stringify({
          activityType: "note",
          summary,
          partyId: item.partyId,
          ...(item.propertyId ? { propertyId: item.propertyId } : {}),
          ...(item.opportunityId ? { opportunityId: item.opportunityId } : {}),
        }),
      }),
    onSuccess: () => {
      setOpenForm(null);
      setNoteText("");
      invalidateToday();
    },
  });

  const updateNextAction = useMutation({
    mutationFn: (vars: { nextActionDueAt?: string; recommendedNextAction?: string }) =>
      apiFetch(`/grow/opportunities/${item.opportunityId}`, {
        method: "PATCH",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      setOpenForm(null);
      setNextActionDate("");
      setNextActionText("");
      invalidateToday();
    },
  });

  const showAddNote = canAddNote && item.availableActions.some((b) => b.action === "add_note");
  const showUpdateNextAction =
    canManageOpportunities && item.opportunityId !== null && item.availableActions.some((b) => b.action === "update_next_action");
  const showViewProperty = item.propertyId !== null && item.availableActions.some((b) => b.action === "view_property");
  const showAskAE = item.availableActions.some((b) => b.action === "ask_ae");

  const busy = addNote.isPending || updateNextAction.isPending;
  const errorMessage: string | null = addNote.isError
    ? addNote.error instanceof ApiError
      ? addNote.error.friendly
      : "Something went wrong. Try again."
    : updateNextAction.isError
    ? updateNextAction.error instanceof ApiError
      ? updateNextAction.error.friendly
      : "Something went wrong. Try again."
    : null;

  return (
    <li className="grow-action-card">
      <div className="grow-action-card-header">
        <span className={priorityPillClass(item.priority)}>{priorityLabel(item.priority)}</span>
        <strong>{item.contactName}</strong>
        {item.propertyLabel ? <span className="muted"> — {item.propertyLabel}</span> : null}
      </div>
      <p className="muted grow-action-reason">{item.reason}</p>
      <p>Recommended: {item.recommendedAction}</p>
      <p className="muted">
        {item.dueAt
          ? `Due ${formatWhen(item.dueAt)}`
          : item.lastActivityAt
          ? `Last contact ${formatWhen(item.lastActivityAt)}`
          : "No contact recorded yet"}
        {item.relationshipType ? ` · ${item.relationshipType.replace(/_/g, " ")}` : null}
      </p>

      {errorMessage && <p className="error-text">{errorMessage}</p>}

      <div className="grow-action-card-actions">
        {showAddNote && (
          <button
            className="btn btn-secondary btn-small"
            disabled={busy}
            onClick={() => setOpenForm(openForm === "note" ? null : "note")}
          >
            Add note
          </button>
        )}
        {showUpdateNextAction && (
          <button
            className="btn btn-secondary btn-small"
            disabled={busy}
            onClick={() => setOpenForm(openForm === "nextAction" ? null : "nextAction")}
          >
            Create follow-up
          </button>
        )}
        {showViewProperty && item.propertyId !== null && (
          <Link href={`/properties/${item.propertyId}`} className="btn btn-link btn-small">
            View property
          </Link>
        )}
        {showAskAE && (
          <button type="button" className="btn btn-link btn-small" onClick={onAskAE}>
            Ask AE
          </button>
        )}
      </div>

      {openForm === "note" && (
        <form
          className="stack grow-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!noteText.trim()) return;
            addNote.mutate(noteText.trim());
          }}
        >
          <label htmlFor={`grow-note-${item.id}`}>Note</label>
          <textarea
            id={`grow-note-${item.id}`}
            placeholder="Add a note about this contact"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            required
            rows={2}
          />
          <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
            Save note
          </button>
        </form>
      )}

      {openForm === "nextAction" && (
        <form
          className="stack grow-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const vars: { nextActionDueAt?: string; recommendedNextAction?: string } = {};
            if (nextActionDate) vars.nextActionDueAt = new Date(nextActionDate).toISOString();
            if (nextActionText.trim()) vars.recommendedNextAction = nextActionText.trim();
            if (!vars.nextActionDueAt && !vars.recommendedNextAction) return;
            updateNextAction.mutate(vars);
          }}
        >
          <label htmlFor={`grow-next-action-date-${item.id}`}>Next action due</label>
          <input
            id={`grow-next-action-date-${item.id}`}
            type="date"
            value={nextActionDate}
            onChange={(e) => setNextActionDate(e.target.value)}
          />
          <label htmlFor={`grow-next-action-text-${item.id}`}>Recommended next action</label>
          <input
            id={`grow-next-action-text-${item.id}`}
            type="text"
            placeholder="e.g. Call to confirm appraisal time"
            value={nextActionText}
            onChange={(e) => setNextActionText(e.target.value)}
          />
          <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
            Save follow-up
          </button>
        </form>
      )}
    </li>
  );
}

function GrowComingSoon({ title, description }: { title: string; description: string }) {
  return (
    <section className="card grow-coming-soon">
      <h2>{title}</h2>
      <p className="muted">{description}</p>
      <span className="pill">Coming soon</span>
    </section>
  );
}

// Voice command readiness (AE GROW Priority 1): architectural/visual seam ONLY. No speech-to-text
// provider, no microphone stream, and no voice-driven action exists anywhere in this build -- the
// button below is permanently disabled and says so, rather than pretending to listen.
// AskAgentEngine itself is reused completely unmodified (contextType="business" is already a
// real, supported value on the existing /ai/ask endpoint -- see apps/api/src/routes/ai.ts).
function GrowAskAETab() {
  return (
    <div>
      <AskAgentEngine contextType="business" contextId={null} />
      <section className="card grow-voice-seam">
        <h2>Voice command</h2>
        <p className="muted">
          Asking Agent Engine by voice is planned for a future release. This is a placeholder for that entry point
          only -- no microphone, speech-to-text, or voice-driven action is active yet, and nothing here records or
          transcribes audio.
        </p>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled
          aria-label="Voice command (coming soon)"
          title="Voice command — coming soon"
        >
          🎤 Voice command — coming soon
        </button>
      </section>
    </div>
  );
}

function GrowContactsTab() {
  const relationships = useQuery<{ relationships: GrowRelationship[] }>({
    queryKey: ["grow-relationships"],
    queryFn: () => apiFetch("/grow/relationships"),
  });
  const activities = useQuery<{ activities: GrowActivity[] }>({
    queryKey: ["grow-activities"],
    queryFn: () => apiFetch("/grow/activities"),
  });

  return (
    <div>
      <section className="card">
        <h2>Relationships</h2>
        <p className="muted">Every person linked to a property, with why the link exists - never just an owner field.</p>
        {relationships.isLoading && <p className="muted">Loading…</p>}
        {relationships.data?.relationships.length === 0 && <p className="empty-state">No relationships yet.</p>}
        {relationships.data && relationships.data.relationships.length > 0 && (
          <table className="grow-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Property</th>
                <th>Type</th>
                <th>Role</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {relationships.data.relationships.map((r) => (
                <tr key={r.id}>
                  <td>{r.partyOrganisationName ?? `${r.partyFirstName ?? ""} ${r.partyLastName ?? ""}`.trim()}</td>
                  <td>{r.propertyAddress}</td>
                  <td>{r.relationshipType}</td>
                  <td>{r.role ?? "–"}</td>
                  <td>
                    <span
                      className={`pill ${r.status === "Active" ? "pill-success" : r.status === "PendingReview" ? "pill-warning" : ""}`}
                    >
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Recent activity</h2>
        {activities.isLoading && <p className="muted">Loading…</p>}
        {activities.data?.activities.length === 0 && <p className="empty-state">No activity logged yet.</p>}
        {activities.data && activities.data.activities.length > 0 && (
          <ul className="timeline">
            {activities.data.activities.map((a) => (
              <li key={a.id}>
                <span className="when">{new Date(a.occurredAt).toLocaleString()}</span>
                <div className="eyebrow">{a.activityType}</div>
                <p>{a.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function GrowOpportunitiesTab() {
  const opportunities = useQuery<{ opportunities: GrowOpportunity[] }>({
    queryKey: ["grow-opportunities"],
    queryFn: () => apiFetch("/grow/opportunities"),
  });

  return (
    <section className="card">
      <h2>Opportunities</h2>
      <p className="muted">Explainable by design - every opportunity carries a reason, never just a score.</p>
      {opportunities.isLoading && <p className="muted">Loading…</p>}
      {opportunities.data?.opportunities.length === 0 && <p className="empty-state">No opportunities yet.</p>}
      {opportunities.data && opportunities.data.opportunities.length > 0 && (
        <table className="grow-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Stage</th>
              <th>Status</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {opportunities.data.opportunities.map((o) => (
              <tr key={o.id}>
                <td>{o.opportunityType}</td>
                <td>{o.stage}</td>
                <td>
                  <span className={`pill ${o.status === "Open" ? "pill-success" : o.status === "Lost" ? "pill-danger" : ""}`}>
                    {o.status}
                  </span>
                </td>
                <td>{o.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
