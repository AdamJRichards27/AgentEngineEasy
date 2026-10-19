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
import type { GrowContact360, GrowContact360Commitment, GrowContact360Opportunity } from "../lib/growContact360";
import { GrowPendingCommitmentProposals } from "../components/GrowPendingCommitmentProposals";
import { ErrorBoundary } from "../components/ErrorBoundary";
// AE GROW Pilot Readiness WP6b (D6) — the shared loading/failed/empty region
// presentation, and the pure state logic behind it and the tab bar.
import { GrowDataRegionStatus } from "../components/GrowDataRegion";
// AE GROW Pilot Readiness WP8 (D11) — turns the server's fail-closed recording
// outcome into one plain sentence for the agent; see that module's header.
import { describeRecordingRefusal } from "../lib/callRecording";
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
  DUE_FOLLOW_UP_FORM_HINT,
  DUE_TODAY_COUNT_HINT,
  DUE_TODAY_COUNT_LABEL,
  NEXT_COMMITMENT_LABEL,
  NO_OPEN_COMMITMENT,
  SAVE_DUE_FOLLOW_UP_LABEL,
  SET_DUE_FOLLOW_UP_LABEL,
} from "../lib/growTerms";
import { GrowTableScroll } from "../components/GrowTableScroll";
import { GrowVirtualTable, GrowVirtualTimeline, memoRow, useGrowCursorPages } from "../components/GrowVirtualList";
import { growListPath, listSearchEmptyMessage } from "../lib/growListQuery";
import {
  ACTIVITY_TYPE_NOT_MANUAL,
  GROW_OPPORTUNITY_LIST_TYPE_FILTER_LABELS,
  GROW_OPPORTUNITY_LIST_TYPE_FILTERS,
  GROW_OPPORTUNITY_MANUAL_STAGES,
  GROW_OPPORTUNITY_TYPES,
  parseGrowOpportunityListTypeFilter,
  type GrowOpportunityListTypeFilter,
  type GrowOpportunityManualStage,
} from "@aee/domain";
import { appraisalWorkspacePath } from "../lib/appraisalUi";
import {
  LINK_PROPERTY_BEFORE_APPRAISAL,
  appraisalForProperty,
  appraisalPropertyChoices,
  appraisalReadOnlyReason,
  appraisalStartPropertyChoices,
  appraisalStatusLabel,
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

// Hand-mirror of GROW_RELATIONSHIP_TYPES (packages/db/src/schema/grow.ts).
// These are property links (POST /grow/relationships). They are not the
// household types above (POST /grow/contacts/:partyId/relationships).
const GROW_PROPERTY_RELATIONSHIP_OPTIONS = [
  ["owner", "Owner"],
  ["co_owner", "Co-owner"],
  ["former_owner", "Former owner"],
  ["occupier", "Occupier"],
  ["tenant", "Tenant"],
  ["landlord", "Landlord"],
  ["buyer", "Buyer"],
  ["prospective_buyer", "Prospective buyer"],
  ["seller", "Seller"],
  ["prospective_seller", "Future seller"],
  ["appraisal_contact", "Appraisal contact"],
  ["vendor", "Vendor"],
  ["investor", "Investor"],
  ["developer", "Developer"],
  ["referrer", "Referrer"],
  ["related_party", "Related party"],
  ["unknown_pending_review", "Unknown, pending review"],
] as const;

interface LinkableProperty {
  id: number;
  formattedAddress: string;
}

interface GrowContactListItem {
  id: number;
  displayName: string;
  partyType: string;
  email: string | null;
  mobile: string | null;
  roles: string[];
  relatedPropertyCount: number;
}

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

type CallEligibilityStatus =
  | "Ready to call"
  | "Consent needs review"
  | "Do Not Call check required"
  | "Calling unavailable at this time";

interface GrowCallFiveGateResult {
  evaluatedAt: string;
  permitted: boolean;
  allPassed: boolean;
  gates: {
    entitlement: { passed: boolean; entitlementKey: string; reason: string; humanReason: string };
    legalPolicy: {
      passed: boolean;
      jurisdiction: string | null;
      policyVersion: string | null;
      reason: string;
      humanReason: string;
    };
    legacyConsentAndDisclosure: {
      passed: boolean;
      consentId: number | null;
      consentJurisdiction: string | null;
      disclosedInCall: boolean;
      confirmedInCall: boolean;
      reason: string;
      humanReason: string;
    };
    adapterCapability: { passed: boolean; provider: string; reason: string; humanReason: string };
    operationalApproval: { passed: boolean; flag: string; reason: string; humanReason: string };
  };
  outboundDecisionId: number | null;
  outboundReasonCode: string | null;
}

interface GrowCallEligibility {
  eligible: boolean;
  status: CallEligibilityStatus;
  eligibilityStatus?: CallEligibilityStatus;
  reason: string;
  displayNumber: string | null;
  requiresCountryConfirmation: boolean;
  consentDecisionId?: number | null;
  recording: {
    available: boolean;
    permitted: boolean;
    status: "Recording not permitted" | "Recording available";
    statusCode: string;
    reason: string;
    provider: string;
    fiveGateResult: GrowCallFiveGateResult;
  };
}

interface GrowCallSession {
  id: number;
  partyId: number;
  destinationRaw: string;
  destinationNormalized: string;
  destinationCountry: string;
  provider: string;
  providerCallId: string | null;
  status: string;
  recordingRequested: boolean;
  recordingPermitted: boolean;
  recordingStatus: string;
  confirmedAt: string | null;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  failureReason: string | null;
  cancelledReason: string | null;
}

interface GrowCallSessionRead {
  callSession: GrowCallSession;
  recording: {
    available: boolean;
    permitted: boolean;
    status: "Recording not permitted" | "Recording available";
    statusCode: string;
    provider: string;
    fiveGateResult: GrowCallFiveGateResult;
  };
}

const TERMINAL_CALL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

function sandboxCallStatusLabel(status: string): string {
  switch (status) {
    case "READY":
      return "Ready to confirm";
    case "DIAL_REQUESTED":
      return "Sandbox dial requested";
    case "RINGING":
      return "Sandbox ringing";
    case "CONNECTED":
      return "Connected in sandbox";
    case "COMPLETED":
      return "Sandbox call completed";
    case "FAILED":
      return "Sandbox call failed";
    case "CANCELLED":
      return "Sandbox call cancelled";
    default:
      return "Preparing sandbox call";
  }
}

// AE GROW Completion W2-B (G-5) — the one way this page turns a failure into a
// sentence. It was already here (as callErrorMessage, used by the call panel);
// every remaining `(error as ApiError).friendly` cast on this page now goes
// through it instead, because that cast renders the literal string "undefined"
// whenever the failure isn't an ApiError — a dropped connection, an aborted
// request, or anything thrown before the response was parsed.
// A hand-log refusal carries the server's sentence ("Only calls, meetings and
// notes can be logged by hand."). Show that text. Other failures stay on
// apiErrorMessage, which is the plain sentence every other panel already uses.
export function growErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === ACTIVITY_TYPE_NOT_MANUAL) {
    const serverMessage = (error as { serverMessage?: unknown }).serverMessage;
    if (typeof serverMessage === "string" && serverMessage.trim().length > 0) return serverMessage;
  }
  return apiErrorMessage(error, fallback);
}

function recordingGateName(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (first) => first.toUpperCase())
    .trim();
}

function RecordingGateReasons({ result }: { result: GrowCallFiveGateResult }) {
  return (
    <ul className="grow-call-gates">
      {Object.entries(result.gates).map(([key, gate]) => (
        <li key={key}>
          <div>
            <strong>{recordingGateName(key)}</strong>
            <div className="muted">{gate.humanReason}</div>
          </div>
          <span className={gate.passed ? "text-success" : "muted"}>{gate.passed ? "Passed" : "Not passed"}</span>
        </li>
      ))}
    </ul>
  );
}

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

interface GrowNextActionInput {
  nextActionDueAt?: string;
  recommendedNextAction?: string;
}

function useUpdateOpportunityNextAction(opportunityId: number | null, onSaved: () => void) {
  return useMutation<unknown, unknown, GrowNextActionInput>({
    mutationFn: (vars) =>
      apiFetch(`/grow/opportunities/${opportunityId}`, {
        method: "PATCH",
        body: JSON.stringify(vars),
      }),
    onSuccess: onSaved,
  });
}

type GrowOpportunityLifecycleInput =
  | { stage: GrowOpportunityManualStage }
  | { status: "Lost"; lostReason: string }
  | { status: "Closed" };

function useUpdateOpportunityLifecycle(opportunityId: number, onSaved: () => void) {
  return useMutation<unknown, unknown, GrowOpportunityLifecycleInput>({
    mutationFn: (body) =>
      apiFetch(`/grow/opportunities/${opportunityId}/lifecycle`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: onSaved,
  });
}

function opportunityLifecycleOpen(status: string, stage: string): boolean {
  return status === "Open" && stage !== "Lost" && stage !== "Converted";
}

/** Status cell for a Lost row names the stored lost reason. Other statuses stay as they are. */
function opportunityStatusLabel(status: string, lostReason: string | null | undefined): string {
  if (status !== "Lost") return status;
  const reason = typeof lostReason === "string" ? lostReason.trim() : "";
  return reason.length > 0 ? `Lost: ${reason}` : "Lost";
}

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

// Owns its own field state, so closing the form is what clears it — the caller
// no longer has to remember to reset two strings on success. `idPrefix` keeps
// the label/input association unique when several of these are on screen at
// once (one per row of a table).
function GrowNextActionForm({
  idPrefix,
  submitting,
  onSubmit,
}: {
  idPrefix: string;
  submitting: boolean;
  onSubmit: (vars: GrowNextActionInput) => void;
}) {
  const [nextActionDate, setNextActionDate] = useState("");
  const [nextActionText, setNextActionText] = useState("");

  return (
    <form
      className="stack grow-inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        const vars: GrowNextActionInput = {};
        if (nextActionDate) vars.nextActionDueAt = new Date(nextActionDate).toISOString();
        if (nextActionText.trim()) vars.recommendedNextAction = nextActionText.trim();
        if (!vars.nextActionDueAt && !vars.recommendedNextAction) return;
        onSubmit(vars);
      }}
    >
      <label htmlFor={`${idPrefix}-date`}>Next action due</label>
      <input id={`${idPrefix}-date`} type="date" value={nextActionDate} onChange={(e) => setNextActionDate(e.target.value)} />
      <label htmlFor={`${idPrefix}-text`}>Recommended next action</label>
      <input
        id={`${idPrefix}-text`}
        type="text"
        placeholder="e.g. Call to confirm appraisal time"
        value={nextActionText}
        onChange={(e) => setNextActionText(e.target.value)}
      />
      <p className="muted">{DUE_FOLLOW_UP_FORM_HINT}</p>
      <button className="btn btn-primary btn-small" type="submit" disabled={submitting}>
        {SAVE_DUE_FOLLOW_UP_LABEL}
      </button>
    </form>
  );
}

interface GrowNoteInput {
  summary: string;
  partyId: number;
  propertyId: number | null;
  opportunityId: number | null;
}

// POST /grow/activities with activityType "note" is the one write behind
// "Add note". Grow Today's card has used it since Priority 1. Opportunity rows
// call this same helper so a note saved from the Opportunities tab cannot drift
// from a note saved on Today.
function useAddGrowNote(onSaved: () => void) {
  return useMutation<unknown, unknown, GrowNoteInput>({
    mutationFn: (input) =>
      apiFetch("/grow/activities", {
        method: "POST",
        body: JSON.stringify({
          activityType: "note",
          summary: input.summary,
          partyId: input.partyId,
          ...(input.propertyId ? { propertyId: input.propertyId } : {}),
          ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
        }),
      }),
    onSuccess: onSaved,
  });
}

interface GrowManualActivityInput {
  activityType: "call" | "meeting";
  summary: string;
  occurredAt: string;
  partyId: number;
  propertyId: number | null;
  opportunityId: number | null;
  durationMinutes: number | null;
  outcome: string | null;
}

// POST /grow/activities for a call or meeting that already happened.
// The body is an activity row. Nothing here opens a call, a recording,
// transcription, or a provider.
function useLogManualActivity(onSaved: () => void) {
  return useMutation<unknown, unknown, GrowManualActivityInput>({
    mutationFn: (input) =>
      apiFetch("/grow/activities", {
        method: "POST",
        body: JSON.stringify({
          activityType: input.activityType,
          summary: input.summary,
          occurredAt: input.occurredAt,
          partyId: input.partyId,
          ...(input.propertyId ? { propertyId: input.propertyId } : {}),
          ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
          ...(input.durationMinutes !== null ? { durationMinutes: input.durationMinutes } : {}),
          ...(input.outcome ? { outcome: input.outcome } : {}),
        }),
      }),
    onSuccess: onSaved,
  });
}

function localDatetimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function datetimeLocalToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function GrowNoteForm({
  idPrefix,
  submitting,
  onSubmit,
}: {
  idPrefix: string;
  submitting: boolean;
  onSubmit: (summary: string) => void;
}) {
  const [noteText, setNoteText] = useState("");

  return (
    <form
      className="stack grow-inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        const summary = noteText.trim();
        if (!summary) return;
        onSubmit(summary);
      }}
    >
      <label htmlFor={`${idPrefix}-note`}>Note</label>
      <textarea
        id={`${idPrefix}-note`}
        placeholder="Add a note about this contact"
        value={noteText}
        onChange={(e) => setNoteText(e.target.value)}
        required
        rows={2}
      />
      <button className="btn btn-primary btn-small" type="submit" disabled={submitting}>
        Save note
      </button>
    </form>
  );
}

function GrowManualActivityForm({
  idPrefix,
  submitting,
  onSubmit,
}: {
  idPrefix: string;
  submitting: boolean;
  onSubmit: (input: {
    activityType: "call" | "meeting";
    summary: string;
    occurredAt: string;
    durationMinutes: number | null;
    outcome: string | null;
  }) => void;
}) {
  const [activityType, setActivityType] = useState<"call" | "meeting">("call");
  const [occurredAt, setOccurredAt] = useState(() => localDatetimeValue(new Date()));
  const [durationMinutes, setDurationMinutes] = useState("");
  const [outcome, setOutcome] = useState("");
  const [summary, setSummary] = useState("");

  return (
    <form
      className="stack grow-inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = summary.trim();
        const iso = datetimeLocalToIso(occurredAt);
        if (!trimmed || !iso) return;
        const durationText = durationMinutes.trim();
        const duration = durationText.length === 0 ? null : Number(durationText);
        if (duration !== null && (!Number.isInteger(duration) || duration < 1)) return;
        const trimmedOutcome = outcome.trim();
        onSubmit({
          activityType,
          summary: trimmed,
          occurredAt: iso,
          durationMinutes: duration,
          outcome: trimmedOutcome.length > 0 ? trimmedOutcome : null,
        });
      }}
    >
      <p className="muted">Records a call or meeting that already happened. It does not place a call.</p>
      <label htmlFor={`${idPrefix}-type`}>Type</label>
      <select
        id={`${idPrefix}-type`}
        value={activityType}
        onChange={(event) => setActivityType(event.target.value === "meeting" ? "meeting" : "call")}
      >
        <option value="call">Call</option>
        <option value="meeting">Meeting</option>
      </select>
      <label htmlFor={`${idPrefix}-occurred`}>When it happened</label>
      <input
        id={`${idPrefix}-occurred`}
        type="datetime-local"
        value={occurredAt}
        onChange={(event) => setOccurredAt(event.target.value)}
        required
      />
      <label htmlFor={`${idPrefix}-duration`}>Duration in minutes (optional)</label>
      <input
        id={`${idPrefix}-duration`}
        type="number"
        min={1}
        max={1440}
        step={1}
        value={durationMinutes}
        onChange={(event) => setDurationMinutes(event.target.value)}
      />
      <label htmlFor={`${idPrefix}-outcome`}>Outcome (optional)</label>
      <input
        id={`${idPrefix}-outcome`}
        type="text"
        maxLength={200}
        value={outcome}
        onChange={(event) => setOutcome(event.target.value)}
      />
      <label htmlFor={`${idPrefix}-summary`}>Summary</label>
      <textarea
        id={`${idPrefix}-summary`}
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
        required
        rows={2}
        maxLength={2000}
      />
      <button className="btn btn-primary btn-small" type="submit" disabled={submitting}>
        Save call or meeting
      </button>
    </form>
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

// G-UAT-6 — appraisal writes use the existing Grow appraisal routes.
// grow.access + grow.opportunities.manage, the same keys those routes require.
// A missing property is an explanation, never a button that would 409.
function useCanReadAppraisals(): boolean {
  const { hasEntitlement } = useEntitlements();
  return hasEntitlement("grow.access");
}

function useCanManageAppraisals(): boolean {
  const { hasEntitlement } = useEntitlements();
  return hasEntitlement("grow.access") && hasEntitlement("grow.opportunities.manage");
}

function useAppraisalPipeline(enabled: boolean) {
  return useQuery<{ appraisals: GrowAppraisalSummary[] }>({
    queryKey: ["grow-appraisals"],
    queryFn: () => apiFetch("/grow/appraisals/pipeline"),
    enabled,
  });
}

function invalidateAppraisalReads(
  queryClient: { invalidateQueries: (filter: { queryKey: unknown[] }) => void },
  partyId: number | null,
) {
  if (partyId !== null) queryClient.invalidateQueries({ queryKey: ["grow-contact", partyId] });
  queryClient.invalidateQueries({ queryKey: ["grow-opportunities"] });
  queryClient.invalidateQueries({ queryKey: ["grow-today"] });
  queryClient.invalidateQueries({ queryKey: ["grow-appraisals"] });
}

function appraisalWriteErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return "That couldn't be found.";
  if (error instanceof ApiError && error.status === 400) return apiErrorMessage(error, "Check the details and try again.");
  if (error instanceof ApiError && error.status === 403) {
    return apiErrorMessage(error, "You don't have permission to update this appraisal.");
  }
  if (error instanceof ApiError && error.status === 409) {
    return apiErrorMessage(error, "That step isn't available for this appraisal.");
  }
  return apiErrorMessage(error, "Couldn't update that appraisal. Try again.");
}

function GrowAppraisalRecord({
  appraisal,
  partyId = null,
}: {
  appraisal: GrowAppraisalSummary | null;
  partyId?: number | null;
}) {
  if (!appraisal) return null;
  const readOnlyReason = appraisalReadOnlyReason(appraisal, partyId);

  return (
    <div className="grow-appraisal-record">
      <p>
        {appraisal.propertyAddress} — Status: {appraisalStatusLabel(appraisal.status)}
        {appraisal.outcome ? ` — Outcome: ${appraisal.outcome}` : " — Outcome: Not recorded"}
      </p>
      {readOnlyReason && <p className="muted">{readOnlyReason}</p>}
      <Link href={appraisalWorkspacePath(appraisal.id)} className="btn btn-link btn-small" id={`grow-appraisal-${appraisal.id}-open`}>
        Open appraisal
      </Link>
    </div>
  );
}

function GrowOpportunityAppraisalActions({
  opportunityId,
  partyId,
  propertyId,
  appraisal,
  canWrite,
}: {
  opportunityId: number;
  partyId: number | null;
  propertyId: number | null;
  appraisal: GrowAppraisalSummary | null;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () =>
      apiFetch("/grow/appraisals/from-opportunity", {
        method: "POST",
        body: JSON.stringify({ opportunityId }),
      }),
    onSuccess: () => {
      setErrorMessage(null);
      invalidateAppraisalReads(queryClient, partyId);
    },
    onError: (error) => setErrorMessage(appraisalWriteErrorMessage(error)),
  });

  return (
    <div className="grow-opportunity-appraisal">
      {errorMessage && (
        <p className="error-text" role="alert">
          {errorMessage}
        </p>
      )}
      {canWrite && propertyId === null && <p className="muted">{LINK_PROPERTY_BEFORE_APPRAISAL}</p>}
      {canWrite && propertyId !== null && appraisal == null && (
        <button
          type="button"
          className="btn btn-secondary btn-small"
          id={`grow-opportunity-start-appraisal-${opportunityId}`}
          disabled={start.isPending}
          onClick={() => start.mutate()}
        >
          Start appraisal
        </button>
      )}
      <GrowAppraisalRecord appraisal={appraisal} partyId={partyId} />
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

// The actions an opportunity ROW offers, shared by the Opportunities tab and
// Contact 360's opportunities table. View contact, View property, and Create
// follow-up landed with #56. Add note and Ask AE are the other non-outreach
// actions Grow Today already offers on the same opportunity record; they reuse
// Today's note write and Today's tab switch.
//
// Email and SMS are intentionally not copied here. Grow Today only shows them
// when the card carries a channel and the contact is not do-not-contact. This
// list does not have that contactability payload, and offering outreach without
// it would bypass the gate. View contact opens the record where those actions
// already live.
//
// onViewContact and onAskAE are null on Contact 360 — that table is already
// inside the contact, and Ask AE is a workspace-tab jump the contact screen
// does not own. Everywhere else they are the same jumps Grow Today makes.
function GrowOpportunityRowActions({
  opportunityId,
  partyId,
  propertyId,
  stage,
  status,
  appraisal,
  canManageOpportunities,
  canAddNote,
  canViewContacts,
  onViewContact,
  onAskAE,
  onSaved,
}: {
  opportunityId: number;
  partyId: number | null;
  propertyId: number | null;
  stage: string;
  status: string;
  appraisal: GrowAppraisalSummary | null;
  canManageOpportunities: boolean;
  canAddNote: boolean;
  canViewContacts: boolean;
  onViewContact: ((partyId: number) => void) | null;
  onAskAE: (() => void) | null;
  onSaved: () => void;
}) {
  const [openForm, setOpenForm] = useState<"note" | "log" | "nextAction" | "lost" | null>(null);
  const [lostReason, setLostReason] = useState("");
  const canManageAppraisals = useCanManageAppraisals();
  const updateNextAction = useUpdateOpportunityNextAction(opportunityId, () => {
    setOpenForm(null);
    onSaved();
  });
  const addNote = useAddGrowNote(() => {
    setOpenForm(null);
    onSaved();
  });
  const logActivity = useLogManualActivity(() => {
    setOpenForm(null);
    onSaved();
  });
  const updateLifecycle = useUpdateOpportunityLifecycle(opportunityId, () => {
    setOpenForm(null);
    setLostReason("");
    onSaved();
  });
  const busy = addNote.isPending || logActivity.isPending || updateNextAction.isPending || updateLifecycle.isPending;
  const showAddNote = canAddNote && partyId !== null;
  const showLifecycle = canManageOpportunities && opportunityLifecycleOpen(status, stage);
  const stageChoices = (GROW_OPPORTUNITY_MANUAL_STAGES as readonly string[]).includes(stage)
    ? [...GROW_OPPORTUNITY_MANUAL_STAGES]
    : [stage, ...GROW_OPPORTUNITY_MANUAL_STAGES];
  const stageFieldId = `grow-opportunity-stage-${opportunityId}`;
  const lostReasonFieldId = `grow-opportunity-lost-reason-${opportunityId}`;
  const trimmedLostReason = lostReason.trim();
  const errorMessage = addNote.isError
    ? growErrorMessage(addNote.error, "Something went wrong. Try again.")
    : logActivity.isError
      ? growErrorMessage(logActivity.error, "Something went wrong. Try again.")
      : updateNextAction.isError
        ? growErrorMessage(updateNextAction.error, "Something went wrong. Try again.")
        : updateLifecycle.isError
          ? growErrorMessage(updateLifecycle.error, "Something went wrong. Try again.")
          : null;

  return (
    <div className="grow-action-card-actions">
      {showAddNote && (
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy}
          onClick={() => setOpenForm(openForm === "note" ? null : "note")}
        >
          {openForm === "note" ? "Cancel" : "Add note"}
        </button>
      )}
      {showAddNote && (
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy}
          onClick={() => setOpenForm(openForm === "log" ? null : "log")}
        >
          {openForm === "log" ? "Cancel" : "Log call or meeting"}
        </button>
      )}
      {canManageOpportunities && (
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy}
          onClick={() => setOpenForm(openForm === "nextAction" ? null : "nextAction")}
        >
          {openForm === "nextAction" ? "Cancel" : SET_DUE_FOLLOW_UP_LABEL}
        </button>
      )}
      {propertyId !== null && (
        <Link href={`/properties/${propertyId}`} className="btn btn-link btn-small">
          View property
        </Link>
      )}
      {onViewContact !== null && canViewContacts && partyId !== null && (
        <button type="button" className="btn btn-link btn-small" onClick={() => onViewContact(partyId)}>
          View contact
        </button>
      )}
      {onAskAE !== null && (
        <button type="button" className="btn btn-link btn-small" onClick={onAskAE}>
          Ask AE
        </button>
      )}
      <GrowOpportunityAppraisalActions
        opportunityId={opportunityId}
        partyId={partyId}
        propertyId={propertyId}
        appraisal={appraisal}
        canWrite={canManageAppraisals}
      />
      {showLifecycle && (
        <div className="grow-opportunity-lifecycle">
          <label htmlFor={stageFieldId}>Change stage</label>
          <select
            id={stageFieldId}
            value={stage}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value;
              if (!(GROW_OPPORTUNITY_MANUAL_STAGES as readonly string[]).includes(next) || next === stage) return;
              updateLifecycle.mutate({ stage: next as GrowOpportunityManualStage });
            }}
          >
            {stageChoices.map((choice) => (
              <option
                key={choice}
                value={choice}
                disabled={!(GROW_OPPORTUNITY_MANUAL_STAGES as readonly string[]).includes(choice)}
              >
                {choice}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={busy}
            onClick={() => setOpenForm(openForm === "lost" ? null : "lost")}
          >
            {openForm === "lost" ? "Cancel" : "Mark lost"}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            id={`grow-opportunity-close-${opportunityId}`}
            disabled={busy}
            aria-label="Close opportunity"
            onClick={() => updateLifecycle.mutate({ status: "Closed" })}
          >
            Close
          </button>
          {openForm === "lost" && (
            <form
              className="stack grow-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!trimmedLostReason) return;
                updateLifecycle.mutate({ status: "Lost", lostReason: trimmedLostReason });
              }}
            >
              <label htmlFor={lostReasonFieldId}>Lost reason</label>
              <input
                id={lostReasonFieldId}
                type="text"
                value={lostReason}
                required
                aria-required="true"
                onChange={(event) => setLostReason(event.target.value)}
              />
              <button type="submit" className="btn btn-primary btn-small" disabled={busy || trimmedLostReason.length === 0}>
                Mark lost
              </button>
            </form>
          )}
        </div>
      )}
      {errorMessage && <p className="error-text" role="alert">{errorMessage}</p>}
      {openForm === "note" && partyId !== null && (
        <GrowNoteForm
          idPrefix={`grow-opportunity-note-${opportunityId}`}
          submitting={busy}
          onSubmit={(summary) =>
            addNote.mutate({
              summary,
              partyId,
              propertyId,
              opportunityId,
            })
          }
        />
      )}
      {openForm === "log" && partyId !== null && (
        <GrowManualActivityForm
          idPrefix={`grow-opportunity-activity-${opportunityId}`}
          submitting={busy}
          onSubmit={(input) =>
            logActivity.mutate({
              ...input,
              partyId,
              propertyId,
              opportunityId,
            })
          }
        />
      )}
      {openForm === "nextAction" && (
        <GrowNextActionForm
          idPrefix={`grow-opportunity-${opportunityId}`}
          submitting={busy}
          onSubmit={(vars) => updateNextAction.mutate(vars)}
        />
      )}
    </div>
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

function GrowContactCallPanel({ partyId, contactName }: { partyId: number; contactName: string }) {
  const queryClient = useQueryClient();
  const [recordingRequested, setRecordingRequested] = useState(false);
  const [assumedCountry, setAssumedCountry] = useState<"" | "AU" | "NZ">("");
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [sessionFromMutation, setSessionFromMutation] = useState<GrowCallSession | null>(null);

  const eligibility = useQuery<GrowCallEligibility>({
    queryKey: ["grow-call-eligibility", partyId, assumedCountry],
    queryFn: () =>
      apiFetch(
        `/grow/calls/contacts/${partyId}/eligibility${assumedCountry ? `?assumedCountry=${assumedCountry}` : ""}`,
      ),
  });

  const session = useQuery<GrowCallSessionRead>({
    queryKey: ["grow-call-session", activeSessionId],
    queryFn: () => apiFetch(`/grow/calls/${activeSessionId}`),
    enabled: activeSessionId !== null,
    refetchInterval: (query) => {
      const currentStatus = query.state.data?.callSession.status;
      return activeSessionId !== null && (!currentStatus || !TERMINAL_CALL_STATUSES.has(currentStatus)) ? 3000 : false;
    },
  });

  function refreshSession(sessionId: number) {
    queryClient.invalidateQueries({ queryKey: ["grow-call-session", sessionId] });
  }

  const createCall = useMutation<{ callSession: GrowCallSession }, unknown, void>({
    mutationFn: () =>
      apiFetch("/grow/calls", {
        method: "POST",
        body: JSON.stringify({
          partyId,
          ...(assumedCountry ? { assumedCountry } : {}),
          recordingRequested,
        }),
      }),
    onSuccess: (result) => {
      setActiveSessionId(result.callSession.id);
      setSessionFromMutation(result.callSession);
    },
  });

  const confirmCall = useMutation<{ callSession: GrowCallSession }, unknown, number>({
    mutationFn: (sessionId) => apiFetch(`/grow/calls/${sessionId}/confirm`, { method: "POST" }),
    onSuccess: (result, sessionId) => {
      setSessionFromMutation(result.callSession);
      refreshSession(sessionId);
    },
  });

  const cancelCall = useMutation<{ callSession: GrowCallSession }, unknown, number>({
    mutationFn: (sessionId) =>
      apiFetch(`/grow/calls/${sessionId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "Cancelled from Contact 360." }),
      }),
    onSuccess: (result, sessionId) => {
      setSessionFromMutation(result.callSession);
      refreshSession(sessionId);
    },
  });

  // AE GROW Pilot Readiness WP8 — D11. This route answers 200 whether or not
  // recording was actually enabled: the server records the attestation,
  // re-evaluates the five recording gates and settles on either
  // PERMITTED_NOT_CAPTURED (on) or UNRECORDED (refused), because a denied gate
  // must never fail the call itself. The refusal therefore never reaches the
  // mutationError path below, which is why the panel used to drop straight
  // back to "Disclose recording" with nothing said. `.data` is kept and read
  // back out via describeRecordingRefusal() at render time.
  const confirmRecording = useMutation<{ callSession: GrowCallSession }, unknown, number>({
    mutationFn: (sessionId) => apiFetch(`/grow/calls/${sessionId}/recording/confirm`, { method: "POST" }),
    onSuccess: (result, sessionId) => {
      setSessionFromMutation(result.callSession);
      refreshSession(sessionId);
    },
  });

  const discloseRecording = useMutation<{ callSession: GrowCallSession }, unknown, number>({
    mutationFn: (sessionId) => apiFetch(`/grow/calls/${sessionId}/recording/disclosure`, { method: "POST" }),
    // A fresh disclosure starts a new recording attempt, so the previous
    // attempt's refusal message must not linger over it.
    onMutate: () => confirmRecording.reset(),
    onSuccess: (result, sessionId) => {
      setSessionFromMutation(result.callSession);
      refreshSession(sessionId);
    },
  });

  const declineRecording = useMutation<{ callSession: GrowCallSession }, unknown, number>({
    mutationFn: (sessionId) => apiFetch(`/grow/calls/${sessionId}/recording/decline`, { method: "POST" }),
    // Declining settles the recording question outright — an earlier refusal
    // is no longer the reason recording is off.
    onMutate: () => confirmRecording.reset(),
    onSuccess: (result, sessionId) => {
      setSessionFromMutation(result.callSession);
      refreshSession(sessionId);
    },
  });

  const activeSession = session.data?.callSession ?? sessionFromMutation;
  const recordingPresentation = session.data?.recording;
  // Present only after a confirmation attempt that came back with recording
  // still off. The gate result comes from the session read refreshed by that
  // same attempt, so the reason shown is the post-confirmation one (the
  // in-call disclosure/confirmation gates have already been satisfied by
  // then), not the stale pre-confirmation evaluation.
  const recordingRefusal = describeRecordingRefusal(
    confirmRecording.data?.callSession ?? null,
    recordingPresentation?.fiveGateResult ?? null,
  );
  const mutationError =
    createCall.error ??
    confirmCall.error ??
    cancelCall.error ??
    discloseRecording.error ??
    confirmRecording.error ??
    declineRecording.error;
  const isMutating =
    createCall.isPending ||
    confirmCall.isPending ||
    cancelCall.isPending ||
    discloseRecording.isPending ||
    confirmRecording.isPending ||
    declineRecording.isPending;
  const eligibilityStatus = eligibility.data?.status;
  const statusPillClass =
    eligibilityStatus === "Ready to call" ? "pill-success" : eligibilityStatus ? "pill-warning" : "";

  function startAnotherSandboxCall() {
    setActiveSessionId(null);
    setSessionFromMutation(null);
    setRecordingRequested(false);
    setAssumedCountry("");
    createCall.reset();
    confirmCall.reset();
    cancelCall.reset();
    discloseRecording.reset();
    confirmRecording.reset();
    declineRecording.reset();
  }

  return (
    <section className="card grow-call-panel">
      <div className="grow-call-panel-header">
        <div>
          <h2>Call {contactName}</h2>
          <p className="muted">Sandbox only — no live call is placed.</p>
        </div>
        {!activeSession && eligibilityStatus && <span className={`pill ${statusPillClass}`}>{eligibilityStatus}</span>}
      </div>

      {eligibility.isLoading && <p className="muted">Checking call eligibility…</p>}
      {eligibility.isError && (
        <p className="error-text">
          {growErrorMessage(eligibility.error, "Call eligibility could not be loaded. Refresh and try again.")}
        </p>
      )}
      {eligibility.data && !activeSession && (
        <>
          <p className="muted">
            {eligibility.data.displayNumber ? `Number on file: ${eligibility.data.displayNumber}` : "No callable phone number on file."}
          </p>
          <p className="muted">
            Recording: <strong>{eligibility.data.recording.status}</strong>. {eligibility.data.recording.reason}
          </p>
          <RecordingGateReasons result={eligibility.data.recording.fiveGateResult} />
          {eligibility.data.requiresCountryConfirmation && (
            <label className="grow-call-country">
              Phone country
              <select value={assumedCountry} onChange={(event) => setAssumedCountry(event.target.value as "" | "AU" | "NZ")} disabled={isMutating}>
                <option value="">Select country</option>
                <option value="AU">Australia (AU)</option>
                <option value="NZ">New Zealand (NZ)</option>
              </select>
              <span className="muted">The server will re-validate the selected country and consent before preparing the call.</span>
            </label>
          )}
          {eligibility.data.eligible && (
            <label className="grow-call-recording-request">
              <input
                type="checkbox"
                checked={recordingRequested}
                onChange={(event) => setRecordingRequested(event.target.checked)}
                disabled={isMutating}
              />{" "}
              Request recording (the server re-checks this in-call)
            </label>
          )}
          <div className="grow-call-actions">
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={!eligibility.data.eligible || (eligibility.data.requiresCountryConfirmation && !assumedCountry) || isMutating}
              onClick={() => createCall.mutate()}
            >
              {createCall.isPending ? "Preparing…" : "Call"}
            </button>
          </div>
        </>
      )}

      {activeSession && (
        <div className="grow-call-session">
          <div className="grow-call-session-header">
            <div>
              <div className="eyebrow">Call status</div>
              <strong>{sandboxCallStatusLabel(activeSession.status)}</strong>
            </div>
            <span className="pill">{activeSession.provider === "sandbox" ? "Sandbox" : activeSession.provider}</span>
          </div>
          <p className="muted">
            Number prepared by the server: {activeSession.destinationNormalized}
          </p>
          {activeSession.status === "READY" && (
            <p className="muted">
              Confirm to request the sandbox dial. The number is checked again by the server before dialling.
            </p>
          )}
          {activeSession.status === "DIAL_REQUESTED" || activeSession.status === "RINGING" ? (
            <p className="muted">Sandbox lifecycle updates appear here when the server receives them; no live connection is promised.</p>
          ) : null}
          {activeSession.status === "CONNECTED" && <p className="muted">The sandbox reports this call as connected.</p>}
          {activeSession.status === "FAILED" && activeSession.failureReason && <p className="error-text">{activeSession.failureReason}</p>}
          {activeSession.status === "CANCELLED" && activeSession.cancelledReason && <p className="muted">{activeSession.cancelledReason}</p>}
          {activeSession.status === "COMPLETED" && activeSession.durationSeconds !== null && (
            <p className="muted">Sandbox duration: {activeSession.durationSeconds}s</p>
          )}

          {session.isLoading && <p className="muted">Refreshing call status…</p>}
          {session.isError && (
            <p className="error-text">
              {growErrorMessage(session.error, "Call status could not be refreshed. Try again.")}
            </p>
          )}
          {activeSession.status === "READY" && (
            <div className="grow-call-actions">
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={isMutating}
                onClick={() => confirmCall.mutate(activeSession.id)}
              >
                {confirmCall.isPending ? "Confirming…" : "Confirm Call"}
              </button>
              <button type="button" className="btn btn-secondary btn-small" disabled={isMutating} onClick={() => cancelCall.mutate(activeSession.id)}>
                Cancel
              </button>
            </div>
          )}

          <div className="grow-call-recording">
            <div className="eyebrow">Recording decision</div>
            {!recordingPresentation && session.isLoading && <p className="muted">Checking the server recording gates…</p>}
            {/* AE GROW Pilot Readiness WP8 (D11) — a confirmation the server
                accepted but which did not turn recording on. Rendered outside
                the recordingPresentation block below so it still appears if the
                follow-up session read is slow or fails, and styled as a notice
                rather than an error: the call itself is unaffected. */}
            {recordingRefusal && (
              <p className="grow-call-recording-notice" role="status">
                {recordingRefusal}
              </p>
            )}
            {recordingPresentation && (
              <>
                <p>
                  <strong>{recordingPresentation.status}</strong>
                  <span className="muted"> · {recordingPresentation.provider} provider</span>
                </p>
                <RecordingGateReasons result={recordingPresentation.fiveGateResult} />
                {activeSession.status === "CONNECTED" && activeSession.recordingRequested && (
                  <div className="grow-call-actions">
                    {(recordingPresentation.statusCode === "DISCLOSURE_REQUIRED" ||
                      recordingPresentation.statusCode === "UNRECORDED") && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={isMutating}
                        onClick={() => discloseRecording.mutate(activeSession.id)}
                      >
                        {discloseRecording.isPending ? "Saving disclosure…" : "Disclose recording"}
                      </button>
                    )}
                    {recordingPresentation.statusCode === "DISCLOSED" && (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary btn-small"
                          disabled={isMutating}
                          onClick={() => confirmRecording.mutate(activeSession.id)}
                        >
                          {confirmRecording.isPending ? "Checking gates…" : "Confirm recording"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          disabled={isMutating}
                          onClick={() => declineRecording.mutate(activeSession.id)}
                        >
                          {declineRecording.isPending ? "Saving…" : "Decline recording"}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {mutationError ? (
            <p className="error-text">{growErrorMessage(mutationError, "The server did not apply that call action. Refresh and try again.")}</p>
          ) : null}
          {TERMINAL_CALL_STATUSES.has(activeSession.status) && (
            <button type="button" className="btn btn-link btn-small" onClick={startAnotherSandboxCall}>
              Start another sandbox call
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// G-UAT-3 — Contact 360 "Link property". Posts partyId, propertyId and
// relationshipType to POST /grow/relationships. The route requires
// grow.relationships.manage for every relationship and grow.properties.link
// when a property id is present, so the form is shown only when both are
// held. The property list is GET /properties (already own-property scoped
// for Agents). The route has no notes field, so this form does not collect
// one. Household "Add related contact" stays a separate list.
export function GrowLinkPropertyForm({ partyId, onLinked }: { partyId: number; onLinked: () => void }) {
  const queryClient = useQueryClient();
  const { hasEntitlement } = useEntitlements();
  const canLink = hasEntitlement("grow.properties.link") && hasEntitlement("grow.relationships.manage");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<LinkableProperty[]>([]);
  const [propertyId, setPropertyId] = useState<number | null>(null);
  const [relationshipType, setRelationshipType] = useState<string>(GROW_PROPERTY_RELATIONSHIP_OPTIONS[0][0]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const searchProperties = useMutation({
    mutationFn: (query: string) => {
      const path = query.length > 0 ? `/properties?q=${encodeURIComponent(query)}` : "/properties";
      return apiFetch<{ properties: LinkableProperty[] }>(path);
    },
    onSuccess: (result) => {
      const properties = result.properties ?? [];
      setResults(properties);
      setPropertyId((current) => (properties.some((property) => property.id === current) ? current : null));
      setErrorMessage(null);
    },
    onError: (error) => setErrorMessage(apiErrorMessage(error, "Couldn't load properties.")),
  });

  const linkProperty = useMutation({
    mutationFn: () =>
      apiFetch("/grow/relationships", {
        method: "POST",
        body: JSON.stringify({ partyId, propertyId, relationshipType }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grow-contact", partyId] });
      queryClient.invalidateQueries({ queryKey: ["grow-contacts"] });
      // The Relationships card and the checklist's property step stay on
      // screen (or remount within staleTime) unless these are invalidated (UAT D5).
      queryClient.invalidateQueries({ queryKey: ["grow-relationships"] });
      queryClient.invalidateQueries({ queryKey: ["grow-today"] });
      onLinked();
      setOpen(false);
      setSearch("");
      setResults([]);
      setPropertyId(null);
      setRelationshipType(GROW_PROPERTY_RELATIONSHIP_OPTIONS[0][0]);
      setErrorMessage(null);
    },
    onError: (error) => setErrorMessage(linkPropertyErrorMessage(error)),
  });

  if (!canLink) return null;

  return (
    <div className="grow-link-property">
      <button type="button" className="btn btn-secondary btn-small" onClick={() => setOpen((value) => !value)}>
        {open ? "Cancel" : "Link property"}
      </button>
      {open && (
        <form
          className="stack grow-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (propertyId === null) return;
            setErrorMessage(null);
            linkProperty.mutate();
          }}
        >
          <label htmlFor="grow-link-property-search">Property</label>
          <div className="grow-inline-form-row">
            <input
              id="grow-link-property-search"
              type="search"
              placeholder="Address, suburb, or postcode"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-secondary btn-small"
              disabled={searchProperties.isPending}
              onClick={() => searchProperties.mutate(search.trim())}
            >
              Search
            </button>
          </div>
          {results.length > 0 && (
            <ul className="item-list">
              {results.map((property) => (
                <li key={property.id}>
                  <button
                    type="button"
                    className={`btn btn-link btn-small${propertyId === property.id ? " active" : ""}`}
                    onClick={() => setPropertyId(property.id)}
                  >
                    {propertyId === property.id ? "✓ " : ""}
                    {property.formattedAddress}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label htmlFor="grow-link-property-type">Relationship</label>
          <select
            id="grow-link-property-type"
            value={relationshipType}
            onChange={(event) => setRelationshipType(event.target.value)}
          >
            {GROW_PROPERTY_RELATIONSHIP_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button className="btn btn-primary btn-small" type="submit" disabled={propertyId === null || linkProperty.isPending}>
            Save link
          </button>
        </form>
      )}
      {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
    </div>
  );
}

function linkPropertyErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return "That property couldn't be found.";
  if (error instanceof ApiError && error.status === 403) {
    return apiErrorMessage(error, "You don't have permission to link a property.");
  }
  if (error instanceof ApiError && error.status === 409) {
    return apiErrorMessage(error, "This contact is already linked to that property.");
  }
  return apiErrorMessage(error, "Couldn't link that property.");
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

interface NewOpportunityInput {
  partyId: number;
  opportunityType: string;
  reason: string;
  propertyId?: number;
}

// G-UAT-5 — blank "New opportunity" on the Opportunities tab and on Contact 360.
// Posts to the existing POST /grow/opportunities. Shown only with
// grow.opportunities.manage, the key that route already requires.
// Contact 360 passes fixedParty so the contact is pre-filled and has no editor.
// Property is optional. The Opportunities tab searches GET /properties, which
// is already limited to properties this user can see. Contact 360 offers the
// contact's linked properties from the Contact 360 read, which is the same
// visibility filter.
export function GrowNewOpportunityForm({
  fixedParty,
  linkedProperties,
}: {
  fixedParty?: { id: number; displayName: string };
  linkedProperties?: Array<{ propertyId: number | null; propertyAddress: string | null }>;
}) {
  const queryClient = useQueryClient();
  const { hasEntitlement } = useEntitlements();
  const canCreate = hasEntitlement("grow.opportunities.manage");
  const [open, setOpen] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [contactResults, setContactResults] = useState<GrowContactListItem[] | null>(null);
  const [selectedPartyId, setSelectedPartyId] = useState<number | null>(null);
  const [opportunityType, setOpportunityType] = useState<string>(GROW_OPPORTUNITY_TYPES[0]);
  const [reason, setReason] = useState("");
  const [propertySearch, setPropertySearch] = useState("");
  const [propertyResults, setPropertyResults] = useState<LinkableProperty[] | null>(null);
  const [selectedPropertyId, setSelectedPropertyId] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const propertyChoices = linkedProperties === undefined ? null : linkedPropertyChoices(linkedProperties);

  const searchContacts = useMutation({
    mutationFn: (query: string) =>
      apiFetch<{ contacts: GrowContactListItem[] }>(`/grow/contacts?search=${encodeURIComponent(query)}`),
    onSuccess: (result) => {
      const contacts = result.contacts ?? [];
      setContactResults(contacts);
      setSelectedPartyId((current) => (contacts.some((contact) => contact.id === current) ? current : null));
      setErrorMessage(null);
    },
    onError: (error) => setErrorMessage(apiErrorMessage(error, "Couldn't search contacts.")),
  });

  const searchProperties = useMutation({
    mutationFn: (query: string) => {
      const path = query.length > 0 ? `/properties?q=${encodeURIComponent(query)}` : "/properties";
      return apiFetch<{ properties: LinkableProperty[] }>(path);
    },
    onSuccess: (result) => {
      const properties = result.properties ?? [];
      setPropertyResults(properties);
      setSelectedPropertyId((current) => (properties.some((property) => property.id === current) ? current : null));
      setErrorMessage(null);
    },
    onError: (error) => setErrorMessage(apiErrorMessage(error, "Couldn't load properties.")),
  });

  const createOpportunity = useMutation({
    mutationFn: (input: NewOpportunityInput) => {
      const body: NewOpportunityInput = {
        partyId: input.partyId,
        opportunityType: input.opportunityType,
        reason: input.reason,
      };
      if (input.propertyId !== undefined) body.propertyId = input.propertyId;
      return apiFetch("/grow/opportunities", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (_result, input) => {
      // Opportunities tab, this contact's Contact 360, and Grow Today's open
      // opportunities all read these queries.
      queryClient.invalidateQueries({ queryKey: ["grow-opportunities"] });
      queryClient.invalidateQueries({ queryKey: ["grow-contact", input.partyId] });
      queryClient.invalidateQueries({ queryKey: ["grow-today"] });
      setSuccessMessage("Opportunity created.");
      setErrorMessage(null);
      setOpen(false);
      setContactSearch("");
      setContactResults(null);
      setSelectedPartyId(null);
      setOpportunityType(GROW_OPPORTUNITY_TYPES[0]);
      setReason("");
      setPropertySearch("");
      setPropertyResults(null);
      setSelectedPropertyId(null);
    },
    onError: (error) => setErrorMessage(newOpportunityErrorMessage(error)),
  });

  if (!canCreate) return null;

  const partyId = fixedParty?.id ?? selectedPartyId;
  const trimmedReason = reason.trim();

  return (
    <div className="grow-new-opportunity">
      {successMessage ? <p role="status">{successMessage}</p> : null}
      <button
        type="button"
        className="btn btn-primary btn-small"
        onClick={() => {
          setOpen((value) => !value);
          setErrorMessage(null);
        }}
      >
        {open ? "Cancel" : "New opportunity"}
      </button>
      {open && (
        <form
          className="stack grow-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (partyId === null || !trimmedReason) return;
            setErrorMessage(null);
            setSuccessMessage(null);
            createOpportunity.mutate({
              partyId,
              opportunityType,
              reason: trimmedReason,
              ...(selectedPropertyId !== null ? { propertyId: selectedPropertyId } : {}),
            });
          }}
        >
          <h3>New opportunity</h3>
          {fixedParty ? (
            <p id="grow-new-opportunity-contact">
              Contact: <strong>{fixedParty.displayName}</strong>
            </p>
          ) : (
            <>
              <label htmlFor="grow-new-opportunity-contact-search">Contact</label>
              <div className="grow-inline-form-row">
                <input
                  id="grow-new-opportunity-contact-search"
                  type="search"
                  placeholder="Search by name, organisation, or email"
                  value={contactSearch}
                  onChange={(event) => setContactSearch(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={!contactSearch.trim() || searchContacts.isPending}
                  onClick={() => searchContacts.mutate(contactSearch.trim())}
                >
                  Search contacts
                </button>
              </div>
              {contactResults !== null && contactResults.length === 0 && <p className="muted">No contacts matched that search.</p>}
              {contactResults !== null && contactResults.length > 0 && (
                <ul className="item-list">
                  {contactResults.map((contact) => (
                    <li key={contact.id}>
                      <button
                        type="button"
                        className={`btn btn-link btn-small${selectedPartyId === contact.id ? " active" : ""}`}
                        onClick={() => setSelectedPartyId(contact.id)}
                      >
                        {selectedPartyId === contact.id ? "✓ " : ""}
                        {contact.displayName}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <label htmlFor="grow-new-opportunity-type">Type</label>
          <select
            id="grow-new-opportunity-type"
            value={opportunityType}
            onChange={(event) => setOpportunityType(event.target.value)}
          >
            {GROW_OPPORTUNITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <label htmlFor="grow-new-opportunity-reason">Reason</label>
          <input
            id="grow-new-opportunity-reason"
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
          {propertyChoices !== null ? (
            <>
              <label htmlFor="grow-new-opportunity-property">Property (optional)</label>
              <select
                id="grow-new-opportunity-property"
                value={selectedPropertyId ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "") {
                    setSelectedPropertyId(null);
                    return;
                  }
                  const id = Number(value);
                  setSelectedPropertyId(Number.isInteger(id) && id > 0 ? id : null);
                }}
              >
                <option value="">No property</option>
                {propertyChoices.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.label}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <label htmlFor="grow-new-opportunity-property-search">Property (optional)</label>
              <div className="grow-inline-form-row">
                <input
                  id="grow-new-opportunity-property-search"
                  type="search"
                  placeholder="Address, suburb, or postcode"
                  value={propertySearch}
                  onChange={(event) => setPropertySearch(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={searchProperties.isPending}
                  onClick={() => searchProperties.mutate(propertySearch.trim())}
                >
                  Search properties
                </button>
              </div>
              {propertyResults !== null && propertyResults.length === 0 && <p className="muted">No properties matched that search.</p>}
              {propertyResults !== null && propertyResults.length > 0 && (
                <ul className="item-list">
                  {propertyResults.map((property) => (
                    <li key={property.id}>
                      <button
                        type="button"
                        className={`btn btn-link btn-small${selectedPropertyId === property.id ? " active" : ""}`}
                        onClick={() => setSelectedPropertyId(property.id)}
                      >
                        {selectedPropertyId === property.id ? "✓ " : ""}
                        {property.formattedAddress}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <button
            className="btn btn-primary btn-small"
            type="submit"
            disabled={partyId === null || !trimmedReason || createOpportunity.isPending}
          >
            Create opportunity
          </button>
        </form>
      )}
      {errorMessage ? (
        <p className="error-text" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}

function linkedPropertyChoices(
  properties: Array<{ propertyId: number | null; propertyAddress: string | null }>,
): Array<{ id: number; label: string }> {
  const seen = new Set<number>();
  const choices: Array<{ id: number; label: string }> = [];
  for (const property of properties) {
    if (property.propertyId === null || seen.has(property.propertyId)) continue;
    seen.add(property.propertyId);
    const address = property.propertyAddress?.trim();
    choices.push({
      id: property.propertyId,
      label: address && address.length > 0 ? address : `Property ${property.propertyId}`,
    });
  }
  return choices;
}

function newOpportunityErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return "That contact or property couldn't be found.";
  if (error instanceof ApiError && error.status === 403) {
    return apiErrorMessage(error, "You don't have permission to create an opportunity.");
  }
  if (error instanceof ApiError && error.status === 400) {
    return apiErrorMessage(error, "Check the contact, type, and reason, then try again.");
  }
  return apiErrorMessage(error, "Couldn't create that opportunity.");
}

// AE GROW Completion W2-B (E-3) — Contact 360's opportunities table. Extracted
// from GrowContactDetail above only so the row actions it now carries can be
// exercised on their own; the markup is otherwise the table that was inline
// here, plus an Actions column.
export function GrowContactOpportunitiesSection({
  partyId,
  contactName,
  linkedProperties,
  opportunities,
  onChanged,
}: {
  partyId: number;
  contactName?: string;
  linkedProperties?: Array<{ propertyId: number | null; propertyAddress: string | null }>;
  opportunities: GrowContact360Opportunity[];
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const { hasEntitlement } = useEntitlements();
  const canManageOpportunities = hasEntitlement("grow.opportunities.manage");
  const canAddNote = hasEntitlement("grow.activities.manage");
  const canReadAppraisals = useCanReadAppraisals();
  const pipeline = useAppraisalPipeline(canReadAppraisals);
  const appraisalRows = canReadAppraisals ? (pipeline.data?.appraisals ?? []) : [];

  function onSaved() {
    // A follow-up or a note changes what Today and the activity list show.
    onChanged();
    queryClient.invalidateQueries({ queryKey: ["grow-today"] });
    queryClient.invalidateQueries({ queryKey: ["grow-opportunities"] });
    queryClient.invalidateQueries({ queryKey: ["grow-activities"] });
  }

  return (
    <section className="card">
      <h2>Opportunities</h2>
      <p className="muted">Explainable by design - every opportunity carries a reason, never just a score.</p>
      <GrowNewOpportunityForm
        fixedParty={{ id: partyId, displayName: contactName?.trim() || "This contact" }}
        linkedProperties={linkedProperties ?? []}
      />
      {opportunities.length === 0 && <p className="empty-state">No opportunities yet.</p>}
      {opportunities.length > 0 && (
        <GrowTableScroll>
        <table className="grow-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Stage</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Next action</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {opportunities.map((o) => (
              <tr key={o.id}>
                <td>{o.opportunityType}</td>
                <td>{o.stage}</td>
                <td>
                  <span className={`pill ${o.status === "Open" ? "pill-success" : o.status === "Lost" ? "pill-danger" : ""}`}>
                    {opportunityStatusLabel(o.status, o.lostReason)}
                  </span>
                </td>
                <td>{o.reason ?? "–"}</td>
                <td>
                  {o.recommendedNextAction ?? "–"}
                  {o.nextActionDueAt ? ` (due ${formatWhen(o.nextActionDueAt)})` : ""}
                </td>
                <td>
                  {/* onViewContact is null here on purpose — see
                      GrowOpportunityRowActions: this table is already inside
                      the contact these opportunities belong to. */}
                  <GrowOpportunityRowActions
                    opportunityId={o.id}
                    partyId={partyId}
                    propertyId={o.propertyId}
                    stage={o.stage}
                    status={o.status}
                    appraisal={appraisalForProperty(appraisalRows, o.propertyId, partyId)}
                    canManageOpportunities={canManageOpportunities}
                    canAddNote={canAddNote}
                    canViewContacts={false}
                    onViewContact={null}
                    onAskAE={null}
                    onSaved={onSaved}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </GrowTableScroll>
      )}
    </section>
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
