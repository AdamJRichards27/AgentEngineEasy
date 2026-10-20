import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch, apiErrorMessage } from "../lib/api";
import { useSession, useEntitlements } from "../lib/session";
import { AskAgentEngine } from "../components/AskAgentEngine";
// AE GROW Priority 3 — Contact 360's communications section, reused unmodified here (see that
// component's own header comment). Grow Today's Email/SMS action buttons below route into it via
// GrowWorkspace's pendingComposeChannel state rather than opening a second composer.
import { ContactCommunicationsSection } from "../components/CommunicationsSection";
// AE GROW Priority 5 Remediation — Property Intelligence. Reused, unmodified, from Contact 360's
// own perspective (anchor="contact"); the Property Workspace embeds the same component with
// anchor="property". See that component's own header comment for why this is a shared panel
// rather than a second bespoke screen.
import { PropertyIntelligencePanel } from "../components/PropertyIntelligencePanel";
import { GrowContactTranscriptPanel } from "../components/GrowContactTranscriptPanel";
// AE GROW Completion W3-A (A-7) — Contact 360's contactability/consent surface.
// Extracted into its own component rather than added to this file, which is
// already Grow Today, Contact 360 and the call panel at once;
// that extraction is the explicit mitigation recorded in the roadmap.
import { GrowContactConsentPanel } from "../components/GrowContactConsentPanel";
import { GrowContactEditForm } from "../components/GrowContactEditForm";
import type { GrowContact360, GrowContact360Commitment } from "../lib/growContact360";
import { opportunityStatusLabel } from "../lib/growContact360";
import { GrowContactCallPanel } from "../components/GrowContactCallPanel";
import { GrowLinkPropertyForm } from "../components/GrowLinkPropertyForm";
import { GrowNewOpportunityForm } from "../components/GrowNewOpportunityForm";
import {
  GrowAppraisalRecord,
  GrowContactOpportunitiesSection,
  GrowManualActivityForm,
  GrowNextActionForm,
  GrowNoteForm,
  GrowOpportunityRowActions,
  appraisalWriteErrorMessage,
  invalidateAppraisalReads,
  useAddGrowNote,
  useAppraisalPipeline,
  useCanManageAppraisals,
  useCanReadAppraisals,
  useLogManualActivity,
  useUpdateOpportunityNextAction,
} from "../components/GrowOpportunityRowActions";
import type { GrowContactListItem } from "../lib/growContact360";
import { growErrorMessage } from "../lib/growErrors";
import { GrowPendingCommitmentProposals } from "../components/GrowPendingCommitmentProposals";
import { ErrorBoundary } from "../components/ErrorBoundary";
// AE GROW Pilot Readiness WP6b (D6) — the shared loading/failed/empty region
// presentation, and the pure state logic behind it and the tab bar.
import { GrowDataRegionStatus } from "../components/GrowDataRegion";
// AE GROW Pilot Readiness WP8 (D11) — turns the server's fail-closed recording
// outcome into one plain sentence for the agent; see that module's header.
import { growCallingSurfaces } from "../lib/growCalling";
import {
  applyGrowNavigation,
  canonicalGrowContactHref,
  contactsEmptyMessage,
  growComposeChannelFromSearch,
  growDataRegionState,
  growContactIdFromPath,
  growContactPath,
  growNavigationMode,
  growTabHref,
  growTabLabel,
  growWorkspaceEntryState,
  isGrowContactPath,
  queueCanonicalGrowContactRedirect,
  GROW_TABS,
  type GrowTab,
} from "../lib/growWorkspace";
import {
  type GrowTodayAction,
  type GrowTodayFirstRun,
  type GrowTodaySummary,
  actionTypeLabel,
  canOfferChannel,
  contactabilityNotice,
  formatGeneratedAt,
  formatWhen,
  hasLinkedContact,
  priorityLabel,
  priorityPillClass,
  rankExplanationLines,
  rankSummaryLine,
  signalWithholdingNotice,
  unlinkedContactNotice,
} from "../lib/growToday";
import { growFirstRunIncomplete, growFirstRunSteps, type GrowFirstRunSection } from "../lib/growFirstRun";
import { TodaySurfaceCrossLink } from "../components/TodaySurfaceCrossLink";
import {
  GROW_TODAY_EYEBROW,
  GROW_TODAY_PURPOSE,
  growTodayCrossLink,
  growTodayHeading,
} from "../lib/todaySurfaces";
import {
  DUE_TODAY_COUNT_HINT,
  DUE_TODAY_COUNT_LABEL,
  NEXT_COMMITMENT_LABEL,
  NO_OPEN_COMMITMENT,
  SET_DUE_FOLLOW_UP_LABEL,
} from "../lib/growTerms";
import { GrowTableScroll } from "../components/GrowTableScroll";
import { GrowVirtualTable, GrowVirtualTimeline, memoRow, useGrowCursorPages } from "../components/GrowVirtualList";
import { growListPath, listSearchEmptyMessage } from "../lib/growListQuery";
import {
  GROW_OPPORTUNITY_LIST_TYPE_FILTER_LABELS,
  GROW_OPPORTUNITY_LIST_TYPE_FILTERS,
  parseGrowOpportunityListTypeFilter,
  type GrowOpportunityListTypeFilter,
} from "@aee/domain";
import { appraisalWorkspacePath } from "../lib/appraisalUi";
import {
  LINK_PROPERTY_BEFORE_APPRAISAL,
  appraisalForProperty,
  appraisalPropertyChoices,
  appraisalStartPropertyChoices,
  appraisalsForContact,
  otherContactAppraisalsForProperties,
  type GrowAppraisalSummary,
} from "../lib/growAppraisals";

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

function growActivityTypeLabel(activityType: string): string {
  if (activityType === "call_summary") return "Call summary";
  return activityType.replace(/_/g, " ");
}

// Hand-mirrors the row GET /grow/opportunities returns — that route selects the
// whole grow_opportunities row (apps/api/src/routes/grow.ts:383-391), so every
// field below already came down the wire; the previous four-field declaration
// was simply reading less of it than it received.
//
// AE GROW Completion W2-B (E-3): partyId / propertyId / recommendedNextAction /
// nextActionDueAt are read now because the Opportunities tab needs them to be
// something other than a dead end. partyId is NOT NULL and propertyId IS
// nullable in packages/db/src/schema/grow.ts:236-237; `reason` is nullable there
// too, which this mirror previously declared as `string` and rendered as an
// empty cell.
interface GrowOpportunity {
  id: number;
  opportunityType: string;
  status: string;
  stage: string;
  reason: string | null;
  /** Set when the opportunity was marked Lost. Already on GET /grow/opportunities. */
  lostReason?: string | null;
  partyId: number;
  propertyId: number | null;
  recommendedNextAction: string | null;
  nextActionDueAt: string | null;
  /** Same-brokerage contact name from GET /grow/opportunities. Null when the party join misses. */
  contactName?: string | null;
}

// AE GROW Priority 2 — Contact Intelligence & Relationship Timeline, frontend types.
// Mirrors apps/api/src/routes/contacts.ts's response shape and
// apps/api/src/lib/{relationshipTimeline,contactIntelligence}.ts by hand — same convention
// lib/growToday.ts already established for Priority 1 (the web app doesn't share a package
// with the API). GROW_CONTACT_ROLES / GROW_CONTACT_RELATIONSHIP_TYPES mirror the same-named
// arrays in packages/db/src/schema/contacts.ts; if those ever change, this list needs a
// matching hand-edit (documented here so that dependency is visible).

const GROW_CONTACT_ROLES = [
  "Prospect",
  "PastClient",
  "CurrentClient",
  "Seller",
  "Buyer",
  "Landlord",
  "Tenant",
  "Investor",
  "PropertyOwner",
  "AppraisalProspect",
  "ReferralSource",
  "ProfessionalPartner",
  "Other",
] as const;

const GROW_CONTACT_RELATIONSHIP_TYPES = [
  "spouse_partner",
  "family",
  "co_owner",
  "business_partner",
  "related_contact",
  "other",
] as const;

type GrowContactListPage = {
  contacts: GrowContactListItem[];
  nextCursor?: string | null;
  total?: number;
};

type GrowRelationshipListPage = {
  relationships: GrowRelationship[];
  nextCursor?: string | null;
  total?: number;
};

type GrowActivityListPage = {
  activities: GrowActivity[];
  nextCursor?: string | null;
  total?: number;
};

type GrowOpportunityListPage = {
  opportunities: GrowOpportunity[];
  nextCursor?: string | null;
  total?: number;
};

const GrowContactCells = memoRow(function GrowContactCells({ contact }: { contact: GrowContactListItem }) {
  return (
    <>
      <td>{contact.displayName}</td>
      <td>{contact.partyType}</td>
      <td>{contact.roles.length > 0 ? contact.roles.join(", ") : "–"}</td>
      <td>{contact.relatedPropertyCount}</td>
      <td>
        <Link href={growContactPath(contact.id)} className="btn btn-link btn-small">
          View Contact 360 &rarr;
        </Link>
      </td>
    </>
  );
});

const GrowRelationshipCells = memoRow(function GrowRelationshipCells({ relationship }: { relationship: GrowRelationship }) {
  const person = relationship.partyOrganisationName ?? `${relationship.partyFirstName ?? ""} ${relationship.partyLastName ?? ""}`.trim();
  return (
    <>
      <td>{person}</td>
      <td>{relationship.propertyAddress}</td>
      <td>{relationship.relationshipType}</td>
      <td>{relationship.role ?? "–"}</td>
      <td>
        <span className={`pill ${relationship.status === "Active" ? "pill-success" : relationship.status === "PendingReview" ? "pill-warning" : ""}`}>
          {relationship.status}
        </span>
      </td>
    </>
  );
});

const GrowActivityItem = memoRow(function GrowActivityItem({ activity }: { activity: GrowActivity }) {
  return (
    <>
      <span className="when">{new Date(activity.occurredAt).toLocaleString()}</span>
      <div className="eyebrow">{growActivityTypeLabel(activity.activityType)}</div>
      <p style={activity.activityType === "call_summary" ? { whiteSpace: "pre-wrap" } : undefined}>{activity.summary}</p>
    </>
  );
});

// Minimal proving UI for Stage A (ARCHITECTURE.md Grow Subscription/Entitlement/Core Data
// build): a locked upgrade screen for brokerages without grow.access, and a real workspace once
// entitled. This page's own /grow/access check is a rendering convenience only - every
// data-bearing request below is independently re-checked server-side via requireEntitlement.
//
// AE GROW Priority 1 — Grow Today: the entitled workspace below (GrowWorkspace) is now
// tabbed rather than one long flat page — Today (this priority's actual deliverable, and the
// default landing tab), Opportunities, Contacts, Nurture, Performance, Ask AE — mirroring
// PitCrewCommandCentre.tsx's own internal `.pc-tabs` sub-navigation pattern rather than adding
// new top-level wouter routes (RUN already owns the top-level /today Command Centre — see App.tsx).
//
// AE GROW Completion W2-B (G-8): this comment used to say "Nurture AND Performance are
// clearly-labelled coming soon placeholders". Performance stopped being one in Priority 6 Stage C
// — it renders the real AI Business Coach (GrowBusinessCoachTab below). Nurture is still a
// genuine placeholder and stays one until a backend for it exists.
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
              {/* AE GROW Completion W2-B (G-5): was `(checkout.error as ApiError).friendly`, which
                  renders the string "undefined" for any failure that isn't an ApiError — a network
                  drop mid-checkout being the obvious one. See growErrorMessage above. */}
              {checkout.isError && (
                <p className="error-text">{growErrorMessage(checkout.error, "Couldn't start checkout. Try again.")}</p>
              )}
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

// Re-exported so existing callers that load this module (the deep-link tests)
// keep finding it here. The rules live in lib/growWorkspace.ts.
export { growWorkspaceEntryState };
export { growErrorMessage };
// Contact 360 PR4: re-exported so existing importers of pages/Grow keep working.
export { GrowLinkPropertyForm, GrowNewOpportunityForm };
// Contact 360 PR5: re-exported so existing importers of pages/Grow keep working.
export { GrowContactOpportunitiesSection };

// Contact 360 is /grow/contacts/:id (App.tsx). The workspace reads that path
// on every render, so a refresh or a pasted link opens the same contact, and
// pushing the path is what makes the browser Back button return to the Grow
// view the agent was on. Older ?contact= links are rewritten to the path.
function currentGrowPath(): string {
  return typeof window === "undefined" ? "/grow" : window.location.pathname;
}

function GrowWorkspace() {
  const search = useSearch();
  const path = currentGrowPath();
  const routedContactId = growContactIdFromPath(path);
  const invalidContactPath = isGrowContactPath(path) && routedContactId === null;
  const entry = growWorkspaceEntryState(search);
  // A legacy ?contact= link still names a contact until the address bar is
  // rewritten. An invalid /grow/contacts/:id does not fall through to it.
  const legacyContactId = invalidContactPath || routedContactId !== null ? null : entry.contactPartyId;
  const contactPartyId = routedContactId ?? legacyContactId;
  const tab: GrowTab = contactPartyId !== null || invalidContactPath ? "contacts" : entry.tab;
  // Email/SMS from Grow Today open the composer via ?compose=, which survives
  // the route change. Contact 360 clears it once the composer has started.
  const pendingComposeChannel = contactPartyId !== null ? growComposeChannelFromSearch(search) : null;

  const legacyHref = canonicalGrowContactHref(path, search);
  if (legacyHref !== null) queueCanonicalGrowContactRedirect(legacyHref);

  function openContact(partyId: number, compose?: "EMAIL" | "SMS") {
    applyGrowNavigation(window.history, growContactPath(partyId, compose), "push");
  }

  function viewContact(partyId: number) {
    openContact(partyId);
  }

  function emailContact(partyId: number) {
    openContact(partyId, "EMAIL");
  }

  function smsContact(partyId: number) {
    openContact(partyId, "SMS");
  }

  function backToContacts() {
    applyGrowNavigation(window.history, growTabHref("contacts"), "push");
  }

  // Clicking a tab goes to that tab's own landing view. From Contact 360 that
  // is a new history entry, so Back returns to the contact. From another tab
  // it replaces the current Grow address, so tab clicks do not pile up.
  function selectTab(next: GrowTab) {
    applyGrowNavigation(window.history, growTabHref(next), growNavigationMode(currentGrowPath()));
  }

  function onComposeHandled() {
    if (contactPartyId === null || pendingComposeChannel === null) return;
    applyGrowNavigation(window.history, growContactPath(contactPartyId), "replace");
  }

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
        {GROW_TABS.flatMap((t) => {
          const tabButton = (
            <button
              key={t.key}
              type="button"
              className={`pc-tab${tab === t.key ? " active" : ""}`}
              aria-current={tab === t.key ? "page" : undefined}
              onClick={() => selectTab(t.key)}
            >
              {t.label}
            </button>
          );
          if (t.key !== "opportunities") return [tabButton];
          return [
            tabButton,
            <Link key="appraisals" href="/grow/appraisals" className="pc-tab">
              Appraisals
            </Link>,
          ];
        })}
      </nav>

      {/* AE GROW Pilot Readiness WP5 — one failing tab shows a contained
          fallback; the tab bar above stays usable and switching tab resets it. */}
      <ErrorBoundary label={`the ${growTabLabel(tab)} tab`} resetKey={tab}>
        {tab === "today" && (
          <GrowToday
            onAskAE={() => selectTab("askAE")}
            onViewContact={viewContact}
            onEmailContact={emailContact}
            onSmsContact={smsContact}
            onOpenSection={selectTab}
          />
        )}
        {/* E-3: the same contact jump and Ask AE tab switch Grow Today already
            uses. Not a second navigation mechanism. */}
        {tab === "opportunities" && (
          <GrowOpportunitiesTab onViewContact={viewContact} onAskAE={() => selectTab("askAE")} />
        )}
        {tab === "contacts" && invalidContactPath && <GrowMissingContact onBack={backToContacts} />}
        {tab === "contacts" && !invalidContactPath && (
          <GrowContactsTab
            selectedPartyId={contactPartyId}
            onBack={backToContacts}
            pendingComposeChannel={pendingComposeChannel}
            onComposeHandled={onComposeHandled}
          />
        )}
        {tab === "nurture" && (
          <GrowComingSoon
            title="Nurture"
            description="Automated nurture sequences and campaigns are planned for a future Grow release. Nothing here is active yet."
          />
        )}
        {tab === "performance" && <GrowBusinessCoachTab />}
        {tab === "askAE" && <GrowAskAETab />}
      </ErrorBoundary>
    </div>
  );
}

// AE GROW Priority 1 — Grow Today. Relationships, follow-ups, and opportunities
// (GET /grow/today). This is not the RUN Command Centre at /today. The name,
// purpose line, and cross-link are lib/todaySurfaces.ts. The screen this
// priority actually exists to build:
// a small set of headline indicators (never vanity metrics -- each one is a real, countable
// thing on this brokerage's own Grow data) plus a deterministically-prioritised action feed, each
// item explaining, in plain language, why AE is surfacing it (see
// apps/api/src/lib/growToday.ts's own header comment for the full rule set -- nothing here is
// predictive scoring). One request (GET /grow/today) renders this whole tab.
//
// AE GROW Priority 2 §12: gained one new prop (onViewContact) so a card's contact can open
// directly into Contact 360 — see GrowWorkspace.viewContact above. No other change to this
// component or to the /grow/today contract it consumes.
//
// AE GROW Priority 3 §4: gained two more (onEmailContact/onSmsContact), the same "route into
// Contact 360" precedent as onViewContact — see GrowWorkspace.emailContact/smsContact. Still no
// change to the /grow/today contract or to this component's own ranking/filtering logic; the
// only new read is the contactEmail/contactMobile/availableActions fields growToday.ts's types
// already carry.
// Exported so the E-2 behavior test can render this feed directly. The page
// still mounts it only from GrowWorkspace.
export function GrowToday({
  onAskAE,
  onViewContact,
  onEmailContact,
  onSmsContact,
  onOpenSection,
}: {
  onAskAE: () => void;
  onViewContact: (partyId: number) => void;
  onEmailContact: (partyId: number) => void;
  onSmsContact: (partyId: number) => void;
  onOpenSection?: (section: GrowFirstRunSection) => void;
}) {
  const { user } = useSession();
  const { hasEntitlement } = useEntitlements();

  const today = useQuery<GrowTodaySummary>({
    queryKey: ["grow-today"],
    queryFn: () => apiFetch("/grow/today"),
  });

  const canAddNote = hasEntitlement("grow.activities.manage");
  const canManageOpportunities = hasEntitlement("grow.opportunities.manage");
  const canViewContacts = hasEntitlement("grow.contacts.read");
  // AE GROW Priority 3 §4: Email/SMS action buttons start a contact-first communication thread
  // (POST /grow/contacts/:partyId/communications/threads), which the server gates on
  // grow.contacts.manage — see routes/communications.ts's own header comment. Gating the buttons
  // on the same entitlement here keeps a button that would just 403 from ever being shown.
  const canManageContactComms = hasEntitlement("grow.contacts.manage");

  // G-3: the relationship to the RUN Command Centre stays visible while this
  // feed is loading or has failed. The feed itself is still GET /grow/today.
  const data = today.data;
  const feedReady = !today.isLoading && !today.isError && !!data;
  const doNow = data ? data.priorityActions.filter((a) => a.priority === "DoNow") : [];
  const doToday = data ? data.priorityActions.filter((a) => a.priority === "DoToday") : [];
  const keepWarm = data ? data.priorityActions.filter((a) => a.priority === "KeepWarm") : [];

  return (
    <div>
      <div className="primary-action">
        <div className="eyebrow">{GROW_TODAY_EYEBROW}</div>
        <h2>{growTodayHeading(user?.firstName)}</h2>
        <p className="muted">{GROW_TODAY_PURPOSE}</p>
        {data ? <p className="muted">As of {formatGeneratedAt(data.generatedAt)}.</p> : null}
        <TodaySurfaceCrossLink link={growTodayCrossLink} />
      </div>

      {/* AE GROW Completion W2-B (G-4) — Today had an error branch already, but it
          was a bare sentence with no way out: an agent whose session had just expired
          saw one line of red and had to reload the whole app. It now uses the same
          region presentation (message + support reference + Try again) the four
          regions on the Contacts and Opportunities tabs have had since WP6b. */}
      {!feedReady || !data ? (
        <GrowDataRegionStatus
          query={today}
          itemCount={undefined}
          loadingMessage="Loading today's priorities…"
          errorFallback="Couldn't load Today."
          emptyMessage="Nothing to show yet."
          onRetry={() => void today.refetch()}
        />
      ) : (
        <>
      <div className="stat-tiles">
        <StatTile label="Priority Actions" value={data.counts.priorityActions} />
        <StatTile label={DUE_TODAY_COUNT_LABEL} value={data.counts.followUpsDue} hint={DUE_TODAY_COUNT_HINT} />
        <StatTile label="Open Opportunities" value={data.counts.openOpportunities} />
        <StatTile label="Contacts Needing Attention" value={data.counts.contactsNeedingAttention} />
      </div>
      <p className="muted">{DUE_TODAY_COUNT_HINT}</p>

      {/* AE GROW Signal Sweep stage 3: Today must be honest about what it is
          NOT showing. An Emerging signal held back by the daily cap, or a
          signal withheld because its contact must not be contacted, is
          reported as a count here rather than silently vanishing. */}
      {signalWithholdingNotice(data.signalSummary) && (
        <p className="muted grow-signal-withholding-notice">{signalWithholdingNotice(data.signalSummary)}</p>
      )}

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
      ) : null}

      {data.firstRun && growFirstRunIncomplete(data.firstRun) ? (
        <GrowFirstRunChecklist
          flags={data.firstRun}
          hasEntitlement={hasEntitlement}
          onOpenSection={onOpenSection ?? (() => {})}
        />
      ) : null}

      {!data.hasAnyGrowData ? null : data.priorityActions.length === 0 ? (
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
                    canViewContacts={canViewContacts}
                    canManageContactComms={canManageContactComms}
                    onAskAE={onAskAE}
                    onViewContact={onViewContact}
                    onEmailContact={onEmailContact}
                    onSmsContact={onSmsContact}
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
                    canViewContacts={canViewContacts}
                    canManageContactComms={canManageContactComms}
                    onAskAE={onAskAE}
                    onViewContact={onViewContact}
                    onEmailContact={onEmailContact}
                    onSmsContact={onSmsContact}
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
                    canViewContacts={canViewContacts}
                    canManageContactComms={canManageContactComms}
                    onAskAE={onAskAE}
                    onViewContact={onViewContact}
                    onEmailContact={onEmailContact}
                    onSmsContact={onSmsContact}
                  />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
        </>
      )}
    </div>
  );
}

// G-UAT-7 — Getting started. Done/not-done is the Today payload's firstRun
// block. Hide and show is component state only: nothing is written.
function GrowFirstRunChecklist({
  flags,
  hasEntitlement,
  onOpenSection,
}: {
  flags: GrowTodayFirstRun;
  hasEntitlement: (key: string) => boolean;
  onOpenSection: (section: GrowFirstRunSection) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const steps = growFirstRunSteps(flags, hasEntitlement);
  const doneCount = steps.filter((step) => step.done).length;

  return (
    <section className="card grow-first-run" aria-label="Getting started">
      <div className="grow-first-run-header">
        <div>
          <h2>Getting started</h2>
          <p className="muted">
            {doneCount} of {steps.length} done
          </p>
        </div>
        <button type="button" className="btn btn-link btn-small" onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? "Show checklist" : "Hide checklist"}
        </button>
      </div>
      {collapsed ? null : (
        <ul className="grow-first-run-list">
          {steps.map((step) => (
            <li key={step.id} id={`grow-first-run-${step.id}`} className="grow-first-run-step">
              <div>
                <strong>{step.title}</strong>
                <p className="muted">{step.hint}</p>
              </div>
              <span className={`pill grow-first-run-status${step.done ? " pill-success" : ""}`}>{step.done ? "Done" : "Not done"}</span>
              {!step.done && !step.available ? <span className="muted">Not available</span> : null}
              {!step.done && step.available ? (
                <div className="grow-empty-actions">
                  {step.actionLabel ? (
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => onOpenSection(step.section)}>
                      {step.actionLabel}
                    </button>
                  ) : null}
                  {step.importHref ? (
                    <Link href={step.importHref} className="btn btn-link btn-small">
                      Import contacts
                    </Link>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatTile({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="stat-tile" title={hint}>
      <div className="stat-tile-label">{label}</div>
      <div className="stat-tile-value">{value}</div>
    </div>
  );
}

// ── Follow-ups on an opportunity (AE GROW Completion W2-B, E-3) ───────────
//
// PATCH /grow/opportunities/:id is the one write behind "Create follow-up".
// Grow Today's action card has offered it since Priority 1; the Opportunities
// tab and Contact 360's opportunities table offered nothing at all, so the SAME
// opportunity record was actionable on one screen and inert on the other two.
//
// The fix is deliberately not a second mutation. This hook and
// GrowNextActionForm below are the Today card's own mutation and form, lifted
// out unchanged in behaviour (same route, same method, same body shape, same
// "at least one field or don't submit" rule), and all three surfaces now call
// them. There is exactly one definition of what creating a follow-up means.

// PATCH /grow/contacts/commitments/:id is the one write behind Complete,
// Cancel, and Reschedule. A status change sends { status }. A reschedule
// sends { dueAt } alone — the route rejects a body that names both. Grow
// Today and Contact 360 share this hook so the two surfaces cannot drift.
type GrowCommitmentPatch =
  | { id: number; status: "Completed" | "Cancelled" }
  | { id: number; dueAt: string };

function useUpdateGrowCommitment(onSaved: (vars: GrowCommitmentPatch) => void) {
  return useMutation<unknown, unknown, GrowCommitmentPatch>({
    mutationFn: (vars) =>
      apiFetch(`/grow/contacts/commitments/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify("dueAt" in vars ? { dueAt: vars.dueAt } : { status: vars.status }),
      }),
    onSuccess: (_result, vars) => {
      onSaved(vars);
    },
  });
}

// Date/time picker for an Open commitment. Shown only by a caller that has
// already checked grow.activities.manage. 400, 404 and 403 surface through
// the shared mutation's growErrorMessage, which is the plain sentence
// apiFetch already stored on the error.
function GrowRescheduleControl({
  idPrefix,
  busy,
  onSubmit,
}: {
  idPrefix: string;
  busy: boolean;
  onSubmit: (dueAt: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dueLocal, setDueLocal] = useState("");

  return (
    <>
      <button
        type="button"
        className="btn btn-link btn-small"
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? "Close" : "Reschedule"}
      </button>
      {open && (
        <form
          className="stack grow-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!dueLocal) return;
            const dueAt = new Date(dueLocal);
            if (Number.isNaN(dueAt.getTime())) return;
            onSubmit(dueAt.toISOString());
          }}
        >
          <label htmlFor={`${idPrefix}-due`}>New due time</label>
          <input
            id={`${idPrefix}-due`}
            type="datetime-local"
            value={dueLocal}
            onChange={(e) => setDueLocal(e.target.value)}
            required
          />
          <button className="btn btn-primary btn-small" type="submit" disabled={busy || !dueLocal}>
            Save new time
          </button>
        </form>
      )}
    </>
  );
}

// Contact 360's commitment list. Exported so the Reschedule action can be
// exercised on its own; GrowContactDetail mounts this same component.
export function GrowContactCommitmentsList({
  commitments,
  canManageActivities,
  onChanged,
}: {
  commitments: GrowContact360Commitment[];
  canManageActivities: boolean;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const updateCommitment = useUpdateGrowCommitment((vars) => {
    onChanged();
    if ("dueAt" in vars) {
      queryClient.invalidateQueries({ queryKey: ["grow-today"] });
    }
  });

  return (
    <>
      {commitments.length === 0 && <p className="empty-state">No commitments recorded.</p>}
      {commitments.length > 0 && (
        <ul className="item-list">
          {commitments.map((cm) => (
            <li key={cm.id}>
              <span className={`pill ${cm.status === "Open" ? "pill-warning" : cm.status === "Completed" ? "pill-success" : "pill-danger"}`}>
                {cm.status}
              </span>{" "}
              {cm.description} — due {formatWhen(cm.dueAt)}
              {cm.status === "Open" && canManageActivities && (
                <>
                  <button
                    type="button"
                    className="btn btn-link btn-small"
                    disabled={updateCommitment.isPending}
                    onClick={() => updateCommitment.mutate({ id: cm.id, status: "Completed" })}
                  >
                    Complete
                  </button>
                  <button
                    type="button"
                    className="btn btn-link btn-small"
                    disabled={updateCommitment.isPending}
                    onClick={() => updateCommitment.mutate({ id: cm.id, status: "Cancelled" })}
                  >
                    Cancel
                  </button>
                  <GrowRescheduleControl
                    idPrefix={`grow-contact-commitment-${cm.id}`}
                    busy={updateCommitment.isPending}
                    onSubmit={(dueAt) => updateCommitment.mutate({ id: cm.id, dueAt })}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {updateCommitment.isError && (
        <p className="error-text">{growErrorMessage(updateCommitment.error, "Something went wrong. Try again.")}</p>
      )}
    </>
  );
}

// Contact 360's recent-activity log. Opportunity rows use the same form.
export function GrowContactActivityLog({ partyId, canLog }: { partyId: number; canLog: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const logActivity = useLogManualActivity(() => {
    setOpen(false);
    queryClient.invalidateQueries({ queryKey: ["grow-contact", partyId] });
    queryClient.invalidateQueries({ queryKey: ["grow-today"] });
    queryClient.invalidateQueries({ queryKey: ["grow-activities"] });
  });
  if (!canLog) return null;
  return (
    <div className="grow-manual-activity">
      <button type="button" className="btn btn-secondary btn-small" disabled={logActivity.isPending} onClick={() => setOpen((value) => !value)}>
        {open ? "Cancel" : "Log call or meeting"}
      </button>
      {logActivity.isError && <p className="error-text">{growErrorMessage(logActivity.error, "Something went wrong. Try again.")}</p>}
      {open && (
        <GrowManualActivityForm
          idPrefix={`grow-contact-activity-${partyId}`}
          submitting={logActivity.isPending}
          onSubmit={(input) =>
            logActivity.mutate({
              ...input,
              partyId,
              propertyId: null,
              opportunityId: null,
            })
          }
        />
      )}
    </div>
  );
}

// Contact 360 lists this contact's appraisals from GET /grow/appraisals/pipeline,
// filtered here by partyId. The pipeline is already limited to properties the
// caller can see. Start posts partyId and one linked property id.
export function GrowContactAppraisalsSection({
  partyId,
  linkedProperties,
}: {
  partyId: number;
  linkedProperties: Array<{ propertyId: number | null; propertyAddress: string | null }>;
}) {
  const queryClient = useQueryClient();
  const canRead = useCanReadAppraisals();
  const canWrite = useCanManageAppraisals();
  const pipeline = useAppraisalPipeline(canRead);
  const [chosenPropertyId, setChosenPropertyId] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const choices = appraisalPropertyChoices(linkedProperties);
  const pipelineRows = pipeline.data?.appraisals ?? [];
  const startChoices = appraisalStartPropertyChoices(choices, pipelineRows);
  const propertyId =
    chosenPropertyId !== null && startChoices.some((choice) => choice.id === chosenPropertyId)
      ? chosenPropertyId
      : (startChoices[0]?.id ?? null);

  const start = useMutation({
    mutationFn: (selectedPropertyId: number) =>
      apiFetch("/grow/appraisals/from-contact", {
        method: "POST",
        body: JSON.stringify({ partyId, propertyId: selectedPropertyId }),
      }),
    onSuccess: () => {
      setErrorMessage(null);
      invalidateAppraisalReads(queryClient, partyId);
    },
    onError: (error) => setErrorMessage(appraisalWriteErrorMessage(error)),
  });

  if (!canRead) return null;

  const rows = appraisalsForContact(pipelineRows, partyId);
  const otherRows = otherContactAppraisalsForProperties(
    pipelineRows,
    partyId,
    choices.map((choice) => choice.id),
  );

  return (
    <section className="card">
      <h2>Appraisals</h2>
      {pipeline.isError && <p className="error-text">{growErrorMessage(pipeline.error, "Couldn't load appraisals.")}</p>}
      {canWrite && choices.length === 0 && <p className="muted">{LINK_PROPERTY_BEFORE_APPRAISAL}</p>}
      {canWrite && startChoices.length > 0 && (
        <div className="stack grow-inline-form">
          <label htmlFor="grow-contact-appraisal-property">Property</label>
          <select
            id="grow-contact-appraisal-property"
            value={propertyId ?? ""}
            onChange={(event) => {
              const id = Number(event.target.value);
              setChosenPropertyId(Number.isInteger(id) && id > 0 ? id : null);
            }}
          >
            {startChoices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-primary btn-small"
            id="grow-contact-start-appraisal"
            disabled={propertyId === null || start.isPending}
            onClick={() => {
              if (propertyId === null) return;
              start.mutate(propertyId);
            }}
          >
            Start appraisal
          </button>
        </div>
      )}
      {errorMessage && (
        <p className="error-text" role="alert">
          {errorMessage}
        </p>
      )}
      {rows.length === 0 && otherRows.length === 0 && <p className="empty-state">No appraisals yet.</p>}
      {(rows.length > 0 || otherRows.length > 0) && (
        <ul className="item-list">
          {rows.map((appraisal) => (
            <li key={appraisal.id}>
              <GrowAppraisalRecord appraisal={appraisal} partyId={partyId} />
            </li>
          ))}
          {otherRows.map((appraisal) => (
            <li key={appraisal.id}>
              <GrowAppraisalRecord appraisal={appraisal} partyId={partyId} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface GrowActionCardProps {
  item: GrowTodayAction;
  canAddNote: boolean;
  canManageOpportunities: boolean;
  canViewContacts: boolean;
  // AE GROW Priority 3 §4.
  canManageContactComms: boolean;
  onAskAE: () => void;
  onViewContact: (partyId: number) => void;
  onEmailContact: (partyId: number) => void;
  onSmsContact: (partyId: number) => void;
}

// One card renders every supported action for that item, same "no separate detail screen"
// convention PitCrewCommandCentre.tsx's PcItemCard already established for this codebase. Every
// button rendered here is backed by a real, already-working capability (POST /grow/activities,
// PATCH /grow/opportunities/:id, or a real /properties/:id link) -- nothing here is a dead
// button, and each one is additionally hidden unless the signed-in user actually holds the
// entitlement that write requires (see canAddNote/canManageOpportunities above), so a button
// that would just 403 is never shown in the first place.
//
// AE GROW Priority 2 §12: "View Contact" follows the exact same precedent as "View property"
// below (showViewProperty) — a plain button, gated on the read entitlement the destination tab
// itself requires (canViewContacts = grow.contacts.read), never on item.availableActions, since
// every GrowTodayAction already carries a real item.partyId and no change to
// apps/api/src/lib/growToday.ts (Priority 1's own, already-shipped ranking logic) was needed or
// made to add this.
function GrowActionCard({
  item,
  canAddNote,
  canManageOpportunities,
  canViewContacts,
  canManageContactComms,
  onAskAE,
  onViewContact,
  onEmailContact,
  onSmsContact,
}: GrowActionCardProps) {
  const queryClient = useQueryClient();
  const [openForm, setOpenForm] = useState<"note" | "nextAction" | null>(null);

  function invalidateToday() {
    queryClient.invalidateQueries({ queryKey: ["grow-today"] });
  }

  // Same note write the Opportunities tab uses. The form unmounts on success,
  // which clears its field — there is no second copy of the POST body.
  const addNote = useAddGrowNote(() => {
    setOpenForm(null);
    invalidateToday();
  });

  // AE GROW Completion W2-B (E-3): this card's follow-up mutation now lives in
  // useUpdateOpportunityNextAction above, so the two opportunity tables offer
  // the identical write rather than each growing their own copy. Nothing about
  // what this card does changed — the form's own field state simply moved into
  // GrowNextActionForm, which unmounts (and therefore clears) when it closes.
  const updateNextAction = useUpdateOpportunityNextAction(item.opportunityId, () => {
    setOpenForm(null);
    invalidateToday();
  });

  // G-UAT-1 / G-UAT-4 — same commitment PATCH Contact 360 uses. Completing
  // drops the row from Today because Grow Today only reads Open commitments.
  // Rescheduling changes dueAt; invalidating Today lets the card leave
  // Overdue when the new time is no longer due. Cancel stays on Contact 360.
  const completeCommitment = useUpdateGrowCommitment(() => {
    invalidateToday();
  });

  // AE GROW Signal Sweep stage 3: every contact-anchored affordance is now
  // additionally gated on the card actually HAVING a contact. A Property
  // Intelligence signal derived from a provider observation is anchored to a
  // property and has no party at all — it used to be dropped from Today
  // entirely, which is the defect stage 3 fixes, so the UI has to cope with
  // it rather than assume item.partyId is always a number.
  const linkedContact = hasLinkedContact(item);
  const showAddNote = canAddNote && linkedContact && item.availableActions.some((b) => b.action === "add_note");
  const showUpdateNextAction =
    canManageOpportunities && item.opportunityId !== null && item.availableActions.some((b) => b.action === "update_next_action");
  const showViewProperty = item.propertyId !== null && item.availableActions.some((b) => b.action === "view_property");
  // E-2: Rule E's primary action is view_appraisal. It opens the Appraisal
  // Workspace at /grow/appraisals/:id. A card with no appraisal id does not
  // invent a link. View property stays on /properties/:id.
  const viewAppraisal = item.availableActions.find(
    (b): b is { action: "view_appraisal"; appraisalId: number } => b.action === "view_appraisal",
  );
  const showViewAppraisal = viewAppraisal !== undefined && viewAppraisal.appraisalId > 0;
  const showViewContact = canViewContacts && linkedContact;
  // AE GROW Priority 3 §4: gated on both the grow.contacts.manage entitlement (see
  // canManageContactComms above) and the contact actually having that channel on file.
  //
  // AE GROW Signal Sweep stage 3: that check now lives in ONE place —
  // lib/growToday.ts's canOfferChannel — which additionally refuses any card
  // marked do_not_contact and fails closed on an unrecognised contactability
  // value. The server already withholds prospecting items for a suppressed
  // contact and nulls their contact fields, so this is a third independent
  // guard, not the only one.
  const showEmail = canManageContactComms && canOfferChannel(item, "email");
  const showSms = canManageContactComms && canOfferChannel(item, "sms");
  const showAskAE = item.availableActions.some((b) => b.action === "ask_ae");
  // canAddNote is grow.activities.manage, the same entitlement Contact 360
  // checks before it offers Complete on an Open commitment.
  const showCompleteCommitment = canAddNote && item.commitmentId !== null;

  const consentNotice = contactabilityNotice(item);
  const kindLabel = actionTypeLabel(item.type);
  const unlinkedNotice = unlinkedContactNotice(item);
  const why = item.whyItMatters;
  const rankSummary = rankSummaryLine(item);
  const rankLines = rankExplanationLines(item);

  const busy = addNote.isPending || updateNextAction.isPending || completeCommitment.isPending;
  const errorMessage: string | null = addNote.isError
    ? growErrorMessage(addNote.error, "Something went wrong. Try again.")
    : updateNextAction.isError
    ? growErrorMessage(updateNextAction.error, "Something went wrong. Try again.")
    : completeCommitment.isError
    ? growErrorMessage(completeCommitment.error, "Something went wrong. Try again.")
    : null;

  return (
    <li className="grow-action-card">
      <div className="grow-action-card-header">
        <span className={priorityPillClass(item.priority)}>{priorityLabel(item.priority)}</span>
        {kindLabel ? <span className="pill">{kindLabel}</span> : null}
        <strong>{item.contactName}</strong>
        {item.propertyLabel ? <span className="muted"> — {item.propertyLabel}</span> : null}
      </div>
      {/* AE GROW Signal Sweep stage 3: a do-not-contact notice leads the card,
          above the reason and the recommendation, so it can never be missed by
          somebody skimming. It only ever appears on an agent's own dated
          commitment — prospecting items for a suppressed contact are withheld
          by the server and never reach this component. */}
      {consentNotice && (
        <p className="error-text grow-action-consent-notice" role="note">
          <strong>Do not contact.</strong> {consentNotice}
        </p>
      )}

      <p className="muted grow-action-reason">{item.reason}</p>

      {/* AE GROW Signal Sweep stage 3 — EXPLAINABILITY. A ranked signal must
          say why it matters in language the agent can act on and repeat to a
          homeowner, and the rank itself is only ever shown alongside the
          itemised factors that produced it. A bare score is not an
          explanation. */}
      {why && (
        <div className="grow-action-why">
          <p className="grow-action-why-headline">{why.headline}</p>
          {why.talkingPoint && (
            <p className="grow-action-why-talking-point">
              <strong>You could ask:</strong> {why.talkingPoint}
            </p>
          )}
          <p className="muted grow-action-why-caution">{why.caution}</p>
          {rankLines.length > 0 && (
            <details className="grow-action-why-factors">
              <summary>{rankSummary ?? "Why AE ranked this here"}</summary>
              <ul>
                {rankLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <p>Recommended: {item.recommendedAction}</p>
      {unlinkedNotice && <p className="muted grow-action-unlinked-notice">{unlinkedNotice}</p>}
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
        {showCompleteCommitment && (
          <button
            type="button"
            className="btn btn-link btn-small"
            disabled={busy}
            onClick={() => {
              if (item.commitmentId === null) return;
              completeCommitment.mutate({ id: item.commitmentId, status: "Completed" });
            }}
          >
            Complete
          </button>
        )}
        {showCompleteCommitment && item.commitmentId !== null && (
          <GrowRescheduleControl
            idPrefix={`grow-today-commitment-${item.commitmentId}`}
            busy={busy}
            onSubmit={(dueAt) => {
              if (item.commitmentId === null) return;
              completeCommitment.mutate({ id: item.commitmentId, dueAt });
            }}
          />
        )}
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
            {SET_DUE_FOLLOW_UP_LABEL}
          </button>
        )}
        {showViewAppraisal && viewAppraisal && (
          <Link href={appraisalWorkspacePath(viewAppraisal.appraisalId)} className="btn btn-link btn-small">
            View appraisal
          </Link>
        )}
        {showViewProperty && item.propertyId !== null && (
          <Link href={`/properties/${item.propertyId}`} className="btn btn-link btn-small">
            View property
          </Link>
        )}
        {/* The `item.partyId !== null` repeated below is what proves to the
            compiler what showViewContact/showEmail/showSms already guarantee:
            a contact-anchored button is never rendered for a card that has no
            contact. */}
        {showViewContact && item.partyId !== null && (
          <button type="button" className="btn btn-link btn-small" onClick={() => onViewContact(item.partyId as number)}>
            View contact
          </button>
        )}
        {showEmail && item.partyId !== null && (
          <button type="button" className="btn btn-link btn-small" onClick={() => onEmailContact(item.partyId as number)}>
            Email
          </button>
        )}
        {showSms && item.partyId !== null && (
          <button type="button" className="btn btn-link btn-small" onClick={() => onSmsContact(item.partyId as number)}>
            SMS
          </button>
        )}
        {showAskAE && (
          <button type="button" className="btn btn-link btn-small" onClick={onAskAE}>
            Ask AE
          </button>
        )}
      </div>

      {openForm === "note" && item.partyId !== null && (
        <GrowNoteForm
          idPrefix={`grow-note-${item.id}`}
          submitting={busy}
          onSubmit={(summary) =>
            addNote.mutate({
              summary,
              partyId: item.partyId as number,
              propertyId: item.propertyId,
              opportunityId: item.opportunityId,
            })
          }
        />
      )}

      {openForm === "nextAction" && (
        <GrowNextActionForm idPrefix={`grow-next-action-${item.id}`} submitting={busy} onSubmit={(vars) => updateNextAction.mutate(vars)} />
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

// AE GROW Pilot Readiness WP6b (P3-a): the "Voice command — coming soon" seam card that used to
// sit below AskAgentEngine here has been removed. It was Priority 1's placeholder for an entry
// point Stage E then actually shipped — the real, working mic control now lives inside
// AskAgentEngine itself (see its Stage E header comment), so the card was telling the agent that
// the control they had just successfully used did not exist yet. Nothing replaces it: voice is
// part of Ask AE's own input row, not a separate surface.
// AE GROW Priority 6 Stage B: AskAgentEngine now gets contextType="grow" here (previously
// "business" - the Grow tab's Ask AE was never actually Grow-scoped before this stage, despite
// living on this page). AskAgentEngine itself required no changes to accept this beyond its own
// Stage B extension (see that component's header comment) - it is still the exact same shared
// component, not a second Ask AE surface.
function GrowAskAETab() {
  return <AskAgentEngine contextType="grow" contextId={null} />;
}

// AE GROW Priority 6 Stage C — AI Business Coach. Replaces this tab's
// previous GrowComingSoon placeholder with the real thing: the same shared
// AskAgentEngine component GrowAskAETab (above) already uses, switched into
// mode="coach" rather than a second, bespoke coaching surface. Read-only
// analysis only, per the Stage C authorisation - AskAgentEngine's coach
// rendering never offers a button that implies AE will carry out an
// action, only questions about the agent's own already-recorded Grow data.
function GrowBusinessCoachTab() {
  return <AskAgentEngine contextType="grow" contextId={null} mode="coach" />;
}

// AE GROW Priority 2 §11 — Contact 360. Replaces Priority 1's flat, read-only stand-in (a plain
// relationships table + activity feed — see Priority 1's own completion report, which explicitly
// deferred "a dedicated View Contact screen" to a future priority) with the real thing: a
// searchable contact list, and a per-contact detail view built to answer "who is this person,
// what are they connected to, and what should I do next" in one screen. `selectedPartyId` is
// owned by GrowWorkspace (not local state here) purely so a Grow Today card's "View Contact"
// button can open this tab directly into a contact's detail rather than its list — see
// GrowWorkspace.viewContact.
function GrowContactsTab({
  selectedPartyId,
  onBack,
  pendingComposeChannel,
  onComposeHandled,
}: {
  selectedPartyId: number | null;
  onBack: () => void;
  // AE GROW Priority 3 §4 — threaded straight through to GrowContactDetail's own
  // ContactCommunicationsSection; see GrowWorkspace.pendingComposeChannel.
  pendingComposeChannel: "EMAIL" | "SMS" | null;
  onComposeHandled: () => void;
}) {
  // AE GROW Pilot Readiness WP5 — Contact 360 gets its own boundary so a
  // failing contact detail offers "Back to contacts" (and resets when a
  // different contact, or the list, is shown) without losing the Grow tabs.
  return (
    <ErrorBoundary
      label={selectedPartyId !== null ? "Contact 360" : "contacts"}
      resetKey={selectedPartyId}
      secondaryAction={selectedPartyId !== null ? { label: "Back to contacts", onClick: onBack } : undefined}
    >
      {selectedPartyId !== null ? (
        <GrowContactDetail
          partyId={selectedPartyId}
          onBack={onBack}
          pendingComposeChannel={pendingComposeChannel}
          onComposeHandled={onComposeHandled}
        />
      ) : (
        <GrowContactList />
      )}
    </ErrorBoundary>
  );
}

// A /grow/contacts/:id that is not a contact id. A real id the agent cannot
// see is handled by Contact 360's own request (404, same sentence).
function GrowMissingContact({ onBack }: { onBack: () => void }) {
  return (
    <div>
      <button type="button" className="btn btn-link btn-small" onClick={onBack}>
        &larr; Back to contacts
      </button>
      <p className="error-text" role="alert">
        That couldn't be found — it may have been removed.
      </p>
    </div>
  );
}

type NewContactNotice =
  | { kind: "created"; contactId: number }
  | { kind: "duplicate"; contactId: number }
  | { kind: "error"; message: string };

// G-UAT-2 — New contact on the Contacts tab. Creates a party with no property
// (POST /grow/contacts). Property linking stays a separate action. Hidden
// without grow.contacts.manage, the same key the route enforces.
export function GrowNewContactForm() {
  const { hasEntitlement } = useEntitlements();
  const canCreateContact = hasEntitlement("grow.contacts.manage");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notice, setNotice] = useState<NewContactNotice | null>(null);
  const queryClient = useQueryClient();

  const createContact = useMutation<{ contact: { id: number } }, unknown, { name: string; email: string; phone: string }>({
    mutationFn: (input) =>
      apiFetch("/grow/contacts", {
        method: "POST",
        body: JSON.stringify({ name: input.name, email: input.email, phone: input.phone }),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["grow-contacts"] });
      // Getting started reads firstRun from grow-today. Without this the
      // checklist stays "0 of 6" until a reload (UAT D5).
      void queryClient.invalidateQueries({ queryKey: ["grow-today"] });
      setNotice({ kind: "created", contactId: result.contact.id });
      setName("");
      setEmail("");
      setPhone("");
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409 && error.contactId) {
        setNotice({ kind: "duplicate", contactId: error.contactId });
        return;
      }
      setNotice({ kind: "error", message: apiErrorMessage(error, "Couldn't create that contact.") });
    },
  });

  if (!canCreateContact) return null;

  return (
    <div className="grow-new-contact">
      {!open ? (
        <button type="button" className="btn btn-primary btn-small" onClick={() => setOpen(true)}>
          New contact
        </button>
      ) : (
        <form
          className="stack grow-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            setNotice(null);
            createContact.mutate({ name: name.trim(), email: email.trim(), phone: phone.trim() });
          }}
        >
          <h3>New contact</h3>
          <label htmlFor="new-contact-name">Name</label>
          <input id="new-contact-name" type="text" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
          <label htmlFor="new-contact-email">Email</label>
          <input id="new-contact-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
          <label htmlFor="new-contact-phone">Phone</label>
          <input id="new-contact-phone" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" />
          <button className="btn btn-primary btn-small" type="submit" disabled={createContact.isPending}>
            Create contact
          </button>
        </form>
      )}
      {notice?.kind === "created" && (
        <p>
          Contact created.{" "}
          <Link href={growContactPath(notice.contactId)} className="btn btn-link btn-small">
            View Contact 360
          </Link>
        </p>
      )}
      {notice?.kind === "duplicate" && (
        <p role="alert">
          This contact already exists.{" "}
          <Link href={growContactPath(notice.contactId)} className="btn btn-link btn-small">
            View Contact 360
          </Link>
        </p>
      )}
      {notice?.kind === "error" && (
        <p className="error-text" role="alert">
          {notice.message}
        </p>
      )}
    </div>
  );
}

const GROW_LIST_SEARCH_DEBOUNCE_MS = 300;

function useDebouncedListSearch() {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), GROW_LIST_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return {
    text,
    query,
    setText,
    commit() {
      setQuery(text.trim());
    },
  };
}

function GrowListSearch({
  id,
  label,
  placeholder,
  text,
  onText,
  onCommit,
}: {
  id: string;
  label: string;
  placeholder: string;
  text: string;
  onText: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <form
      className="grow-inline-form-row"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onCommit();
      }}
    >
      <label className="grow-list-filter" htmlFor={id}>
        {label}
        <input
          id={id}
          type="search"
          value={text}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(event) => onText(event.target.value)}
        />
      </label>
    </form>
  );
}

export function GrowContactList() {
  const [search, setSearch] = useState("");
  const [committedSearch, setCommittedSearch] = useState("");
  const [role, setRole] = useState("");
  const relationshipSearch = useDebouncedListSearch();
  const activitySearch = useDebouncedListSearch();

  const contacts = useQuery<GrowContactListPage>({
    queryKey: ["grow-contacts", committedSearch, role],
    queryFn: () => apiFetch(growListPath("/grow/contacts", { search: committedSearch, role })),
  });
  const contactPages = useGrowCursorPages({
    resetKey: `${committedSearch}\0${role}`,
    page: contacts.data
      ? { items: contacts.data.contacts, nextCursor: contacts.data.nextCursor, total: contacts.data.total }
      : undefined,
    getId: (contact) => contact.id,
    fetchPage: (cursor) =>
      apiFetch<GrowContactListPage>(growListPath("/grow/contacts", { search: committedSearch, role, cursor })).then((page) => ({
        items: page.contacts,
        nextCursor: page.nextCursor,
        total: page.total,
      })),
  });

  // Kept unchanged from Priority 1 (GET /grow/relationships, GET /grow/activities) — a
  // brokerage-wide "every property relationship" / "everything that happened recently" view is
  // still useful alongside the new per-contact Contact 360 below, and nothing about Contact 360
  // required removing it. Both lists are paged the same way as contacts.
  const relationships = useQuery<GrowRelationshipListPage>({
    queryKey: ["grow-relationships", relationshipSearch.query],
    queryFn: () => apiFetch(growListPath("/grow/relationships", { search: relationshipSearch.query })),
  });
  const relationshipPages = useGrowCursorPages({
    resetKey: `relationships\0${relationshipSearch.query}`,
    page: relationships.data
      ? { items: relationships.data.relationships, nextCursor: relationships.data.nextCursor, total: relationships.data.total }
      : undefined,
    getId: (relationship) => relationship.id,
    fetchPage: (cursor) =>
      apiFetch<GrowRelationshipListPage>(growListPath("/grow/relationships", { search: relationshipSearch.query, cursor })).then((page) => ({
        items: page.relationships,
        nextCursor: page.nextCursor,
        total: page.total,
      })),
  });
  const activities = useQuery<GrowActivityListPage>({
    queryKey: ["grow-activities", activitySearch.query],
    queryFn: () => apiFetch(growListPath("/grow/activities", { search: activitySearch.query })),
  });
  const activityPages = useGrowCursorPages({
    resetKey: `activities\0${activitySearch.query}`,
    page: activities.data
      ? { items: activities.data.activities, nextCursor: activities.data.nextCursor, total: activities.data.total }
      : undefined,
    getId: (activity) => activity.id,
    fetchPage: (cursor) =>
      apiFetch<GrowActivityListPage>(growListPath("/grow/activities", { search: activitySearch.query, cursor })).then((page) => ({
        items: page.activities,
        nextCursor: page.nextCursor,
        total: page.total,
      })),
  });

  const contactCount = contacts.data ? contactPages.items.length : undefined;
  const contactState = growDataRegionState(contacts, contactCount);
  const relationshipCount = relationships.data ? relationshipPages.items.length : undefined;
  const relationshipState = growDataRegionState(relationships, relationshipCount);
  const activityCount = activities.data ? activityPages.items.length : undefined;
  const activityState = growDataRegionState(activities, activityCount);

  return (
    <div>
      <section className="card">
        <h2>Contacts</h2>
        <p className="muted">Search AE's canonical contacts. Open one to see Contact 360 — everything Grow knows about that relationship.</p>
        <GrowNewContactForm />
        <form
          className="grow-inline-form-row"
          onSubmit={(e) => {
            e.preventDefault();
            setCommittedSearch(search.trim());
          }}
        >
          <input
            type="search"
            placeholder="Search by name, organisation, or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search contacts"
          />
          <label className="grow-list-filter" htmlFor="grow-contacts-role">
            Role
            <select
              id="grow-contacts-role"
              value={role}
              onChange={(event) => {
                setRole(event.target.value);
                setCommittedSearch(search.trim());
              }}
            >
              <option value="">All roles</option>
              {GROW_CONTACT_ROLES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-secondary btn-small">
            Search
          </button>
        </form>

        {/* AE GROW Pilot Readiness WP6b (D6) — an explicit failed state with a
            Try again that refetches this region's own query, plus a distinct
            "nothing matched that search" vs "no contacts at all" empty state.
            The empty sentence is the current filter only: a later result
            replaces it instead of leaving it above the rows. */}
        <GrowDataRegionStatus
          key={`${committedSearch}\0${role}`}
          query={contacts}
          itemCount={contactCount}
          errorFallback="Couldn't load contacts."
          emptyMessage={contactsEmptyMessage(committedSearch, role)}
          onRetry={() => void contacts.refetch()}
        />
        {contactState === "ready" && (
          <GrowVirtualTable
            label="Contacts"
            singular="contact"
            plural="contacts"
            colSpan={5}
            resetKey={`${committedSearch}\0${role}`}
            items={contactPages.items}
            total={contactPages.total}
            getKey={(contact) => contact.id}
            renderCells={(contact) => <GrowContactCells contact={contact} />}
            hasMore={contactPages.hasMore}
            loadingMore={contactPages.loadingMore}
            moreError={contactPages.moreError}
            onLoadMore={contactPages.loadMore}
            head={
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Roles</th>
                <th>Properties</th>
                <th></th>
              </tr>
            }
          />
        )}
      </section>

      <section className="card">
        <h2>Relationships</h2>
        <p className="muted">Every person linked to a property, with why the link exists - never just an owner field.</p>
        <GrowListSearch
          id="grow-relationships-search"
          label="Search relationships"
          placeholder="Name, organisation, or address"
          text={relationshipSearch.text}
          onText={relationshipSearch.setText}
          onCommit={relationshipSearch.commit}
        />
        <GrowDataRegionStatus
          key={relationshipSearch.query}
          query={relationships}
          itemCount={relationshipCount}
          errorFallback="Couldn't load relationships."
          emptyMessage={listSearchEmptyMessage(relationshipSearch.query, "relationships", "No relationships yet.")}
          onRetry={() => void relationships.refetch()}
        />
        {relationshipState === "ready" && (
          <GrowVirtualTable
            label="Relationships"
            singular="relationship"
            plural="relationships"
            colSpan={5}
            resetKey={`relationships\0${relationshipSearch.query}`}
            items={relationshipPages.items}
            total={relationshipPages.total}
            getKey={(relationship) => relationship.id}
            renderCells={(relationship) => <GrowRelationshipCells relationship={relationship} />}
            hasMore={relationshipPages.hasMore}
            loadingMore={relationshipPages.loadingMore}
            moreError={relationshipPages.moreError}
            onLoadMore={relationshipPages.loadMore}
            head={
              <tr>
                <th>Person</th>
                <th>Property</th>
                <th>Type</th>
                <th>Role</th>
                <th>Status</th>
              </tr>
            }
          />
        )}
      </section>

      <section className="card">
        <h2>Recent activity</h2>
        <GrowListSearch
          id="grow-activities-search"
          label="Search activity"
          placeholder="Search summaries"
          text={activitySearch.text}
          onText={activitySearch.setText}
          onCommit={activitySearch.commit}
        />
        <GrowDataRegionStatus
          key={activitySearch.query}
          query={activities}
          itemCount={activityCount}
          errorFallback="Couldn't load recent activity."
          emptyMessage={listSearchEmptyMessage(activitySearch.query, "activities", "No activity logged yet.")}
          onRetry={() => void activities.refetch()}
        />
        {activityState === "ready" && (
          <GrowVirtualTimeline
            label="Recent activity"
            singular="activity"
            plural="activities"
            resetKey={`activities\0${activitySearch.query}`}
            items={activityPages.items}
            total={activityPages.total}
            getKey={(activity) => activity.id}
            renderItem={(activity) => <GrowActivityItem activity={activity} />}
            hasMore={activityPages.hasMore}
            loadingMore={activityPages.loadingMore}
            moreError={activityPages.moreError}
            onLoadMore={activityPages.loadMore}
          />
        )}
      </section>
    </div>
  );
}

// AE GROW Priority 2 §11 — Contact 360 detail. One request (GET /grow/contacts/:partyId, built
// in this priority's API layer) backs the whole screen — header/identity, relationship-role
// summary, household relationships, properties, the Relationship Timeline, notes/activities/
// commitments, and opportunities — matching the "understand this relationship in seconds" UX
// goal rather than a screen that fires off five separate requests or a generic CRM record view.
export function GrowContactDetail({
  partyId,
  onBack,
  pendingComposeChannel,
  onComposeHandled,
}: {
  partyId: number;
  onBack: () => void;
  // AE GROW Priority 3 §2/§4 — see GrowWorkspace.pendingComposeChannel and
  // ContactCommunicationsSection's own quickComposeChannel prop below.
  pendingComposeChannel: "EMAIL" | "SMS" | null;
  onComposeHandled: () => void;
}) {
  const queryClient = useQueryClient();
  const { hasEntitlement, isLoading: entitlementsLoading } = useEntitlements();
  const canManageContacts = hasEntitlement("grow.contacts.manage");
  const canManageActivities = hasEntitlement("grow.activities.manage");
  // GP-5 — the workspace already loads this. Optional calling/provider flags
  // hide the cards; a missing flag does not. Entitlements still decide.
  const access = useQuery<GrowAccess & { callingEnabled?: boolean; providerEnabled?: boolean }>({
    queryKey: ["grow-access"],
    queryFn: () => apiFetch("/grow/access"),
  });
  const callingSurfaces = growCallingSurfaces({
    entitlementsKnown: entitlementsLoading !== true && access.isLoading !== true,
    hasEntitlement,
    callingEnabled: access.data?.callingEnabled,
    providerEnabled: access.data?.providerEnabled,
  });

  const detail = useQuery<GrowContact360>({
    queryKey: ["grow-contact", partyId],
    queryFn: () => apiFetch(`/grow/contacts/${partyId}`),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["grow-contact", partyId] });
    queryClient.invalidateQueries({ queryKey: ["grow-contacts"] });
  }

  const assignRole = useMutation({
    mutationFn: (role: string) => apiFetch(`/grow/contacts/${partyId}/roles`, { method: "POST", body: JSON.stringify({ role }) }),
    onSuccess: invalidate,
  });
  const removeRole = useMutation({
    mutationFn: (role: string) => apiFetch(`/grow/contacts/${partyId}/roles/${encodeURIComponent(role)}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const [showAddRelationship, setShowAddRelationship] = useState(false);
  const [relatedSearch, setRelatedSearch] = useState("");
  const [relatedResults, setRelatedResults] = useState<GrowContactListItem[]>([]);
  const [relatedPartyId, setRelatedPartyId] = useState<number | null>(null);
  const [relationshipType, setRelationshipType] = useState<string>(GROW_CONTACT_RELATIONSHIP_TYPES[0]);
  const [relationshipNote, setRelationshipNote] = useState("");

  const searchRelated = useMutation({
    mutationFn: (query: string) =>
      apiFetch<GrowContactListPage>(growListPath("/grow/contacts", { search: query, excludePartyId: partyId })),
    onSuccess: (result) => setRelatedResults(result.contacts),
  });

  const addRelationship = useMutation({
    mutationFn: () =>
      apiFetch(`/grow/contacts/${partyId}/relationships`, {
        method: "POST",
        body: JSON.stringify({
          relatedPartyId,
          relationshipType,
          ...(relationshipNote.trim() ? { note: relationshipNote.trim() } : {}),
        }),
      }),
    onSuccess: () => {
      setShowAddRelationship(false);
      setRelatedSearch("");
      setRelatedResults([]);
      setRelatedPartyId(null);
      setRelationshipNote("");
      invalidate();
    },
  });

  const removeRelationship = useMutation({
    mutationFn: (id: number) => apiFetch(`/grow/contacts/relationships/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const [showAddCommitment, setShowAddCommitment] = useState(false);
  const [commitmentDescription, setCommitmentDescription] = useState("");
  const [commitmentDueAt, setCommitmentDueAt] = useState("");
  const [commitmentPropertyId, setCommitmentPropertyId] = useState("");
  const [commitmentOpportunityId, setCommitmentOpportunityId] = useState("");

  const addCommitment = useMutation({
    mutationFn: () =>
      apiFetch(`/grow/contacts/${partyId}/commitments`, {
        method: "POST",
        body: JSON.stringify({
          description: commitmentDescription.trim(),
          dueAt: new Date(commitmentDueAt).toISOString(),
          ...(commitmentPropertyId ? { propertyId: Number(commitmentPropertyId) } : {}),
          ...(commitmentOpportunityId ? { opportunityId: Number(commitmentOpportunityId) } : {}),
        }),
      }),
    onSuccess: () => {
      setShowAddCommitment(false);
      setCommitmentDescription("");
      setCommitmentDueAt("");
      setCommitmentPropertyId("");
      setCommitmentOpportunityId("");
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["grow-today"] });
    },
  });

  // AE GROW Completion W2-B (G-4) — same region presentation as every other
  // Grow region, so a Contact 360 that failed to load offers Try again rather
  // than only "Back to contacts". The back button stays: it is this view's own
  // navigation, not part of the failure.
  if (detail.isLoading || detail.isError || !detail.data) {
    return (
      <div>
        <button type="button" className="btn btn-link btn-small" onClick={onBack}>
          &larr; Back to contacts
        </button>
        <GrowDataRegionStatus
          query={detail}
          itemCount={undefined}
          loadingMessage="Loading contact…"
          errorFallback="Couldn't load this contact."
          emptyMessage="Nothing to show for this contact."
          onRetry={() => void detail.refetch()}
        />
      </div>
    );
  }

  const data = detail.data;
  const c = data.contact;

  return (
    <div>
      <button type="button" className="btn btn-link btn-small" onClick={onBack}>
        &larr; Back to contacts
      </button>

      <div className="primary-action">
        <div className="eyebrow">{c.partyType}</div>
        <h2>{c.displayName}</h2>
        <p className="muted">
          {c.email ?? "No email on file"}
          {c.mobile ? ` · ${c.mobile}` : ""}
        </p>
        <GrowContactEditForm partyId={partyId} contact={c} canEdit={canManageContacts} />
        <div className="grow-contact-roles">
          {GROW_CONTACT_ROLES.map((role) => {
            const active = data.roles.includes(role);
            return (
              <button
                key={role}
                type="button"
                className={`pill${active ? " pill-success" : ""}`}
                disabled={!canManageContacts || assignRole.isPending || removeRole.isPending}
                onClick={() => (active ? removeRole.mutate(role) : assignRole.mutate(role))}
                title={
                  canManageContacts
                    ? active
                      ? `Remove ${role} role`
                      : `Assign ${role} role`
                    : "Requires Grow contact management access"
                }
              >
                {role}
              </button>
            );
          })}
        </div>
      </div>

      {/* AE GROW Completion W3-A (A-7) — above the call and communications
          panels on purpose: whether this contact may be reached, and why not,
          has to be readable BEFORE the affordances that reach them. The block
          comes from the Contact 360 request this view already makes, so the
          panel adds no second round trip. */}
      <GrowContactConsentPanel partyId={partyId} contactability={data.contactability} onChanged={invalidate} />

      {callingSurfaces.call && <GrowContactCallPanel partyId={partyId} contactName={c.displayName} />}
      {callingSurfaces.transcripts && (
        <GrowContactTranscriptPanel
          partyId={partyId}
          contactName={c.displayName}
          onReviewSaved={() => {
            // The API writes the approved call-summary activity atomically with Save.
            // Refresh only read models here; the browser never persists the activity.
            queryClient.invalidateQueries({ queryKey: ["grow-contact", partyId] });
            queryClient.invalidateQueries({ queryKey: ["grow-activities"] });
          }}
        />
      )}

      <div className="stat-tiles">
        <StatTile label="Related Properties" value={data.intelligence.relatedPropertyCount} />
        <StatTile label="Open Opportunities" value={data.intelligence.activeOpportunityCount} />
        <StatTile label="Recent Activity (30d)" value={data.intelligence.recentActivityCount} />
        <StatTile label="Outstanding Commitments" value={data.intelligence.outstandingCommitmentCount} />
      </div>

      {/* AE GROW Priority 3 §2 — Contact 360's communications section: Email/SMS actions,
          reusing the Communications Hub's own composer (components/CommunicationsSection.tsx),
          wired to the new contact-first routes. The thread/message list rendered inside it is
          this page's "communications history" — see that component's own header comment. */}
      <ContactCommunicationsSection
        partyId={partyId}
        canStartThread={canManageContacts}
        quickComposeChannel={pendingComposeChannel}
        onQuickComposeHandled={onComposeHandled}
        contactability={data.contactability}
      />

      <section className="card">
        <h2>Relationship summary</h2>
        <p className="muted">
          {data.intelligence.relationshipAgeDays !== null
            ? `Known to AE for ${data.intelligence.relationshipAgeDays} day(s). `
            : "No recorded history yet. "}
          {data.intelligence.mostRecentInteractionAt
            ? `Last interaction ${data.intelligence.daysSinceLastInteraction} day(s) ago (${formatWhen(
                data.intelligence.mostRecentInteractionAt,
              )}).`
            : "No interactions logged yet."}
        </p>
        {data.intelligence.nextFollowUpAt ? (
          <p>
            <strong>{NEXT_COMMITMENT_LABEL}</strong> {data.intelligence.nextFollowUpDescription} — due{" "}
            {formatWhen(data.intelligence.nextFollowUpAt)}
          </p>
        ) : (
          <p className="muted">{NO_OPEN_COMMITMENT}</p>
        )}
      </section>

      <section className="card">
        <h2>Household &amp; related contacts</h2>
        <p className="muted">Person-to-person context, recorded explicitly by an agent — AE never auto-infers this.</p>
        {data.householdRelationships.length === 0 && <p className="empty-state">No related contacts recorded.</p>}
        {data.householdRelationships.length > 0 && (
          <ul className="item-list">
            {data.householdRelationships.map((h) => (
              <li key={h.id}>
                <strong>{h.relatedPartyDisplayName}</strong> — {h.relationshipType.replace(/_/g, " ")}
                {h.note ? <span className="muted"> ({h.note})</span> : null}
                {canManageContacts && (
                  <button
                    type="button"
                    className="btn btn-link btn-small"
                    disabled={removeRelationship.isPending}
                    onClick={() => removeRelationship.mutate(h.id)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManageContacts && (
          <>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setShowAddRelationship((v) => !v)}>
              {showAddRelationship ? "Cancel" : "Add related contact"}
            </button>
            {showAddRelationship && (
              <form
                className="stack grow-inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!relatedPartyId) return;
                  addRelationship.mutate();
                }}
              >
                <label htmlFor="grow-related-search">Find contact</label>
                <div className="grow-inline-form-row">
                  <input
                    id="grow-related-search"
                    type="text"
                    placeholder="Search by name or email"
                    value={relatedSearch}
                    onChange={(e) => setRelatedSearch(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    disabled={!relatedSearch.trim() || searchRelated.isPending}
                    onClick={() => searchRelated.mutate(relatedSearch.trim())}
                  >
                    Search
                  </button>
                </div>
                {relatedResults.length > 0 && (
                  <ul className="item-list">
                    {relatedResults.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          className={`btn btn-link btn-small${relatedPartyId === r.id ? " active" : ""}`}
                          onClick={() => setRelatedPartyId(r.id)}
                        >
                          {relatedPartyId === r.id ? "✓ " : ""}
                          {r.displayName}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <label htmlFor="grow-relationship-type">Relationship</label>
                <select id="grow-relationship-type" value={relationshipType} onChange={(e) => setRelationshipType(e.target.value)}>
                  {GROW_CONTACT_RELATIONSHIP_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
                <label htmlFor="grow-relationship-note">Note (optional)</label>
                <input
                  id="grow-relationship-note"
                  type="text"
                  value={relationshipNote}
                  onChange={(e) => setRelationshipNote(e.target.value)}
                />
                <button className="btn btn-primary btn-small" type="submit" disabled={!relatedPartyId || addRelationship.isPending}>
                  Save relationship
                </button>
              </form>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2>Properties</h2>
        <p className="muted">Reuses AE's canonical properties — Grow does not keep a second property record.</p>
        {data.properties.length === 0 && <p className="empty-state">No property relationships recorded.</p>}
        {data.properties.length > 0 && (
          <GrowTableScroll>
          <table className="grow-table">
            <thead>
              <tr>
                <th>Property</th>
                <th>Type</th>
                <th>Role</th>
                <th>Status</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {data.properties.map((p) => (
                <tr key={p.relationshipId}>
                  <td>
                    {p.propertyId !== null ? (
                      <Link href={`/properties/${p.propertyId}`}>{p.propertyAddress ?? "View property"}</Link>
                    ) : (
                      p.propertyAddress ?? "–"
                    )}
                  </td>
                  <td>
                    {p.relationshipType}
                    {p.isPrimary ? " (primary)" : ""}
                  </td>
                  <td>{p.role ?? "–"}</td>
                  <td>
                    <span className={`pill ${p.status === "Active" ? "pill-success" : p.status === "PendingReview" ? "pill-warning" : ""}`}>
                      {p.status}
                    </span>
                  </td>
                  <td>{formatWhen(p.validFrom)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </GrowTableScroll>
        )}
        <GrowLinkPropertyForm partyId={partyId} onLinked={invalidate} />
      </section>

      <GrowContactAppraisalsSection partyId={partyId} linkedProperties={data.properties} />

      {/* AE GROW Priority 5 Remediation — Property Intelligence. Extends this existing Contact
          360 view rather than adding a second contact screen, per the remediation objective's
          own instruction. The panel independently gates itself on grow.propertyIntelligence.read
          via useEntitlements() and renders nothing (not even a placeholder) when the viewer lacks
          it, so no wiring is needed here beyond mounting it. */}
      <PropertyIntelligencePanel anchor="contact" partyId={partyId} />

      <section className="card">
        <h2>Relationship Timeline</h2>
        <p className="muted">Every interaction, in one place, chronological — never a predictive score.</p>
        {data.timeline.length === 0 && <p className="empty-state">No history yet.</p>}
        {data.timeline.length > 0 && (
          <ul className="timeline">
            {data.timeline.map((e) => (
              <li key={e.id}>
                <span className="when">{new Date(e.occurredAt).toLocaleString()}</span>
                <div className="eyebrow">{e.type.replace(/_/g, " ")}</div>
                <p style={{ whiteSpace: "pre-wrap" }}>{e.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Notes, activity &amp; commitments</h2>
        <h3>Recent activity</h3>
        {data.activities.length === 0 && <p className="empty-state">No activity logged yet.</p>}
        {data.activities.length > 0 && (
          <ul className="timeline">
            {data.activities.map((a) => (
              <li key={a.id}>
                <span className="when">{new Date(a.occurredAt).toLocaleString()}</span>
                <div className="eyebrow">{growActivityTypeLabel(a.activityType)}</div>
                <p style={a.activityType === "call_summary" ? { whiteSpace: "pre-wrap" } : undefined}>{a.summary}</p>
              </li>
            ))}
          </ul>
        )}

        <GrowContactActivityLog partyId={partyId} canLog={canManageActivities} />

        {/* Stage F4.3: the caller's own pending CREATE_GROW_COMMITMENT
            proposals for this contact, approved/rejected only by explicit
            clicks on the shared review card. Renders nothing when empty. */}
        {canManageActivities && <GrowPendingCommitmentProposals partyId={partyId} contactName={c.displayName} />}

        <h3>Commitments</h3>
        <GrowContactCommitmentsList
          commitments={data.commitments}
          canManageActivities={canManageActivities}
          onChanged={invalidate}
        />
        {canManageActivities && (
          <>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setShowAddCommitment((v) => !v)}>
              {showAddCommitment ? "Cancel" : "Add commitment"}
            </button>
            {showAddCommitment && (
              <form
                className="stack grow-inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!commitmentDescription.trim() || !commitmentDueAt) return;
                  addCommitment.mutate();
                }}
              >
                <label htmlFor="grow-commitment-description">What was promised</label>
                <input
                  id="grow-commitment-description"
                  type="text"
                  placeholder="e.g. Call next month about listing"
                  value={commitmentDescription}
                  onChange={(e) => setCommitmentDescription(e.target.value)}
                  required
                />
                <label htmlFor="grow-commitment-due">Due</label>
                <input
                  id="grow-commitment-due"
                  type="date"
                  value={commitmentDueAt}
                  onChange={(e) => setCommitmentDueAt(e.target.value)}
                  required
                />
                {data.properties.length > 0 && (
                  <>
                    <label htmlFor="grow-commitment-property">Property (optional)</label>
                    <select
                      id="grow-commitment-property"
                      value={commitmentPropertyId}
                      onChange={(e) => setCommitmentPropertyId(e.target.value)}
                    >
                      <option value="">None</option>
                      {data.properties
                        .filter((p) => p.propertyId !== null)
                        .map((p) => (
                          <option key={p.propertyId as number} value={p.propertyId as number}>
                            {p.propertyAddress}
                          </option>
                        ))}
                    </select>
                  </>
                )}
                {data.opportunities.length > 0 && (
                  <>
                    <label htmlFor="grow-commitment-opportunity">Opportunity (optional)</label>
                    <select
                      id="grow-commitment-opportunity"
                      value={commitmentOpportunityId}
                      onChange={(e) => setCommitmentOpportunityId(e.target.value)}
                    >
                      <option value="">None</option>
                      {data.opportunities.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.opportunityType} — {o.stage}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <button className="btn btn-primary btn-small" type="submit" disabled={addCommitment.isPending}>
                  Save commitment
                </button>
              </form>
            )}
          </>
        )}
      </section>

      <GrowContactOpportunitiesSection
        partyId={partyId}
        contactName={c.displayName}
        linkedProperties={data.properties}
        opportunities={data.opportunities}
        onChanged={invalidate}
      />
    </div>
  );
}

// E-3 — this tab was four read-only cells per row. #56 added View contact,
// View property, and Create follow-up, the same jumps and follow-up write Grow
// Today already had. Add note and Ask AE are the remaining non-outreach actions
// on Today's opportunity card, wired through the same handlers. The existing
// next action stays visible so creating one changes the row.
const GrowOpportunityCells = memoRow(function GrowOpportunityCells({
  opportunity,
  appraisal,
  canManageOpportunities,
  canAddNote,
  canViewContacts,
  onViewContact,
  onAskAE,
  onSaved,
}: {
  opportunity: GrowOpportunity;
  appraisal: GrowAppraisalSummary | null;
  canManageOpportunities: boolean;
  canAddNote: boolean;
  canViewContacts: boolean;
  onViewContact: (partyId: number) => void;
  onAskAE: (() => void) | null;
  onSaved: () => void;
}) {
  const contactName = opportunity.contactName?.trim() ? opportunity.contactName.trim() : null;
  return (
    <>
      <td>
        {contactName && canViewContacts ? (
          <Link href={growContactPath(opportunity.partyId)} className="btn btn-link btn-small">
            {contactName}
          </Link>
        ) : (
          (contactName ?? "–")
        )}
      </td>
      <td>{opportunity.opportunityType}</td>
      <td>{opportunity.stage}</td>
      <td>
        <span className={`pill ${opportunity.status === "Open" ? "pill-success" : opportunity.status === "Lost" ? "pill-danger" : ""}`}>
          {opportunityStatusLabel(opportunity.status, opportunity.lostReason)}
        </span>
      </td>
      <td>{opportunity.reason ?? "–"}</td>
      <td>
        {opportunity.recommendedNextAction ?? "–"}
        {opportunity.nextActionDueAt ? ` (due ${formatWhen(opportunity.nextActionDueAt)})` : ""}
      </td>
      <td className="grow-opportunity-actions-cell">
        <GrowOpportunityRowActions
          opportunityId={opportunity.id}
          partyId={opportunity.partyId}
          propertyId={opportunity.propertyId}
          stage={opportunity.stage}
          status={opportunity.status}
          appraisal={appraisal}
          canManageOpportunities={canManageOpportunities}
          canAddNote={canAddNote}
          canViewContacts={canViewContacts}
          onViewContact={onViewContact}
          onAskAE={onAskAE}
          onSaved={onSaved}
        />
      </td>
    </>
  );
});

export function GrowOpportunitiesTab({
  onViewContact,
  onAskAE,
}: {
  onViewContact: (partyId: number) => void;
  onAskAE?: () => void;
}) {
  const queryClient = useQueryClient();
  const { hasEntitlement } = useEntitlements();
  const canManageOpportunities = hasEntitlement("grow.opportunities.manage");
  const canAddNote = hasEntitlement("grow.activities.manage");
  const canViewContacts = hasEntitlement("grow.contacts.read");
  const canReadAppraisals = useCanReadAppraisals();
  const [typeFilter, setTypeFilter] = useState<GrowOpportunityListTypeFilter>("all");
  const [listVersion, setListVersion] = useState(0);
  const opportunitySearch = useDebouncedListSearch();
  // An empty search keeps the key C-5a already asserts: ["grow-opportunities", type].
  // A search is appended so the two filters refetch together.
  const opportunityQueryKey = opportunitySearch.query
    ? ["grow-opportunities", typeFilter, opportunitySearch.query]
    : ["grow-opportunities", typeFilter];

  const opportunities = useQuery<GrowOpportunityListPage>({
    queryKey: opportunityQueryKey,
    queryFn: () => apiFetch(growListPath("/grow/opportunities", { search: opportunitySearch.query, type: typeFilter })),
  });
  const opportunityPages = useGrowCursorPages({
    resetKey: `${typeFilter}\0${opportunitySearch.query}\0${listVersion}`,
    page: opportunities.data
      ? { items: opportunities.data.opportunities, nextCursor: opportunities.data.nextCursor, total: opportunities.data.total }
      : undefined,
    getId: (opportunity) => opportunity.id,
    fetchPage: (cursor) =>
      apiFetch<GrowOpportunityListPage>(
        growListPath("/grow/opportunities", { search: opportunitySearch.query, type: typeFilter, cursor }),
      ).then((page) => ({
        items: page.opportunities,
        nextCursor: page.nextCursor,
        total: page.total,
      })),
  });
  const pipeline = useAppraisalPipeline(canReadAppraisals);
  const appraisalRows = canReadAppraisals ? (pipeline.data?.appraisals ?? []) : [];
  const opportunityCount = opportunities.data ? opportunityPages.items.length : undefined;
  const opportunityState = growDataRegionState(opportunities, opportunityCount);

  function onSaved() {
    setListVersion((version) => version + 1);
    void opportunities.refetch();
    queryClient.invalidateQueries({ queryKey: ["grow-today"] });
    queryClient.invalidateQueries({ queryKey: ["grow-activities"] });
  }

  return (
    <section className="card">
      <h2>Opportunities</h2>
      <p className="muted">Explainable by design - every opportunity carries a reason, never just a score.</p>
      <GrowNewOpportunityForm />
      <div className="grow-inline-form-row">
        <label htmlFor="grow-opportunity-type-filter">Opportunity type</label>
        <select
          id="grow-opportunity-type-filter"
          value={typeFilter}
          onChange={(event) => {
            const parsed = parseGrowOpportunityListTypeFilter(event.target.value);
            if (parsed.ok) setTypeFilter(parsed.filter);
          }}
        >
          {GROW_OPPORTUNITY_LIST_TYPE_FILTERS.map((filter) => (
            <option key={filter} value={filter}>
              {GROW_OPPORTUNITY_LIST_TYPE_FILTER_LABELS[filter]}
            </option>
          ))}
        </select>
      </div>
      <GrowListSearch
        id="grow-opportunities-search"
        label="Search opportunities"
        placeholder="Search by contact or reason"
        text={opportunitySearch.text}
        onText={opportunitySearch.setText}
        onCommit={opportunitySearch.commit}
      />
      {/* AE GROW Pilot Readiness WP6b (D6) — see GrowContactList above. */}
      <GrowDataRegionStatus
        key={`${typeFilter}\0${opportunitySearch.query}`}
        query={opportunities}
        itemCount={opportunityCount}
        errorFallback="Couldn't load opportunities."
        emptyMessage={listSearchEmptyMessage(opportunitySearch.query, "opportunities", "No opportunities yet.")}
        onRetry={() => void opportunities.refetch()}
      />
      {opportunityState === "ready" && (
        <GrowVirtualTable
          label="Opportunities"
          singular="opportunity"
          plural="opportunities"
          colSpan={7}
          estimate={160}
          resetKey={`${typeFilter}\0${opportunitySearch.query}\0${listVersion}`}
          items={opportunityPages.items}
          total={opportunityPages.total}
          getKey={(opportunity) => opportunity.id}
          hasMore={opportunityPages.hasMore}
          loadingMore={opportunityPages.loadingMore}
          moreError={opportunityPages.moreError}
          onLoadMore={opportunityPages.loadMore}
          head={
            <tr>
              <th>Contact</th>
              <th>Type</th>
              <th>Stage</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Next action</th>
              <th className="grow-opportunity-actions-cell"></th>
            </tr>
          }
          renderCells={(opportunity) => (
            <GrowOpportunityCells
              opportunity={opportunity}
              appraisal={appraisalForProperty(appraisalRows, opportunity.propertyId, opportunity.partyId)}
              canManageOpportunities={canManageOpportunities}
              canAddNote={canAddNote}
              canViewContacts={canViewContacts}
              onViewContact={onViewContact}
              onAskAE={onAskAE ?? null}
              onSaved={onSaved}
            />
          )}
        />
      )}
    </section>
  );
}
