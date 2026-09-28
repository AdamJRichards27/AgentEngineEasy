// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7).
//
// Answers "what must Pit Crew do next, for whom, and by when?" for the two
// roles allowed to see it (Section 26): Pit Crew and Brokerage Administrator.
// App.tsx only shows the nav link to those roles, and the API independently
// enforces the same gate (requireRole(...PIT_CREW_ROLES, ...BROKERAGE_ADMIN_
// ROLES) in routes/pitCrew.ts) -- the nav hiding is a UX nicety, not the
// security boundary.
//
// Section 22: the Agent Daily Command Centre (Priority 6) is on staging
// (apps/api/src/lib/commandCentre/ and apps/web/src/pages/CommandCentre.tsx,
// route /today). This page does not import it, so this reads straight from
// getPitCrewWorkspace (which itself
// sources from the Exception & Risk Engine's listBrokerageExceptions) rather
// than depending on or duplicating that feature.
//
// R-F23: the Launch section renders launchCoordination as the workspace
// sends it. That list can hold LAUNCH_CAMPAIGN exceptions and LAUNCH_ITEM
// campaign items together. Campaign-item actions stay on the Pit Crew item
// routes (sourceType LAUNCH_ITEM). This page does not call /launch. Hand-back
// and escalate stay off LAUNCH_ITEM cards. With no campaign items in the
// list, the section text is the same as before those labels existed.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { useSession } from "../lib/session";
import { ApiError } from "../lib/api";
import {
  acknowledgePcEscalation,
  addPcNote,
  assignPcItem,
  canAcknowledgeEscalation,
  canResolveOrReturnEscalation,
  claimPcItem,
  completePcItem,
  escalatePcItem,
  fetchPitCrewWorkspace,
  fetchResponsibilityRecipients,
  handBackPcItem,
  handoffPcItem,
  isPitCrewActiveActionStatus,
  PIT_CREW_ESCALATION_REASON_CATEGORIES,
  PIT_CREW_ESCALATION_SEVERITIES,
  PIT_CREW_HAND_BACK_REASON_CATEGORIES,
  PIT_CREW_RECIPIENTS_UNAVAILABLE_MESSAGE,
  pitCrewReasonLabel,
  pitCrewResponsibilityActionError,
  pitCrewResponsibilityActionsVisible,
  pcStatusLabel,
  pcStatusPillClass,
  pcTeamMemberName,
  reclaimPcHandBack,
  releasePcItem,
  resolvePcEscalation,
  returnPcEscalation,
  returnPcItem,
  setPcWaitingOn,
  startPcItem,
  type PcMutationBase,
  type PcOpenResponsibility,
  type PcResponsibilityRecipient,
  type PcResponsibilityRecipientKind,
  type PcResponsibilityWorkItem,
  type PcTeamMember,
  type PcWorkItem,
  type PcWorkspace,
  type PitCrewEscalationReasonCategory,
  type PitCrewEscalationSeverity,
  type PitCrewHandBackReasonCategory,
} from "../lib/pitCrew";
import { categoryLabel, formatDueDate, isOverdue, severityLabel, severityPillClass } from "../lib/riskExceptions";

function pcKey(sourceType: string, sourceRecordId: string): string {
  return `${sourceType}:${sourceRecordId}`;
}

// Shown on Launch cards only when that section includes a campaign item, so
// an exception-only list (the flag-off payload) keeps today's wording.
function pitCrewLaunchSourceLabel(sourceType: string): string | null {
  if (sourceType === "LAUNCH_ITEM") return "Campaign item";
  if (sourceType === "EXCEPTION") return "Exception";
  return null;
}

const SECTIONS = [
  { key: "overview", label: "Overview" },
  { key: "myWork", label: "My Work" },
  { key: "unassignedWork", label: "Unassigned" },
  { key: "teamWork", label: "Team Work" },
  { key: "launchCoordination", label: "Launch" },
  { key: "transactionCoordination", label: "Transactions" },
  { key: "waitingOn", label: "Waiting On" },
  { key: "completedToday", label: "Completed Today" },
] as const;

const RESPONSIBILITY_SECTIONS = [
  { key: "handedBack", label: "Handed back" },
  { key: "escalated", label: "Escalated" },
] as const;

type BaseSectionKey = (typeof SECTIONS)[number]["key"];
type ResponsibilitySectionKey = (typeof RESPONSIBILITY_SECTIONS)[number]["key"];
type SectionKey = BaseSectionKey | ResponsibilitySectionKey;

function sectionItems(data: PcWorkspace, key: BaseSectionKey): PcWorkItem[] | null {
  switch (key) {
    case "myWork":
      return data.myWork;
    case "unassignedWork":
      return data.unassignedWork;
    case "teamWork":
      return data.teamWork;
    case "launchCoordination":
      return data.launchCoordination;
    case "transactionCoordination":
      return data.transactionCoordination;
    case "waitingOn":
      return data.waitingOn;
    case "completedToday":
      return data.completedToday;
    default:
      return null;
  }
}

const EMPTY_LABELS: Record<Exclude<BaseSectionKey, "overview">, string> = {
  myWork: "Nothing claimed yet. Pick something up from Unassigned Work.",
  unassignedWork: "Nothing waiting for a Pit Crew member right now.",
  teamWork: "No active Pit Crew work across the team.",
  launchCoordination: "No launch campaign items need Pit Crew right now.",
  transactionCoordination: "No offer, condition, or settlement items need Pit Crew right now.",
  waitingOn: "Nothing is currently blocked waiting on someone else.",
  completedToday: "Nothing completed yet today.",
};

const RESPONSIBILITY_EMPTY_LABELS: Record<ResponsibilitySectionKey, string> = {
  handedBack: "Nothing has been handed back.",
  escalated: "Nothing is escalated.",
};

interface PcItemActions {
  claim: (args: PcMutationBase) => void;
  assign: (args: PcMutationBase & { assigneeUserId: number }) => void;
  start: (args: PcMutationBase) => void;
  waitingOn: (args: PcMutationBase & { waitingOnParty: string; waitingOnNote?: string; waitingOnExpectedAt?: string }) => void;
  doReturn: (args: PcMutationBase) => void;
  complete: (args: PcMutationBase) => void;
  release: (args: PcMutationBase) => void;
  handoff: (args: PcMutationBase & { toUserId: number; note?: string }) => void;
  note: (args: { sourceType: string; sourceRecordId: string; propertyId: number; note: string }) => void;
  handBack: (args: PcMutationBase & { reasonCategory: PitCrewHandBackReasonCategory; nextAction: string; note?: string; recipientUserId?: number }) => void;
  escalate: (
    args: PcMutationBase & {
      reasonCategory: PitCrewEscalationReasonCategory;
      severity: PitCrewEscalationSeverity;
      note: string;
      nextAction: string;
      recipientUserId?: number;
      expectedResponseAt?: string;
    },
  ) => void;
  acknowledge: (args: PcMutationBase & { note?: string }) => void;
  resolve: (args: PcMutationBase & { note: string }) => void;
  returnEscalation: (args: PcMutationBase & { note: string }) => void;
  reclaim: (args: PcMutationBase) => void;
}

type PcCardItem = PcWorkItem & { responsibility?: PcOpenResponsibility };

function selectedRecipientId(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function responsibilityRecipientLabel(responsibility: PcOpenResponsibility): string | null {
  if (responsibility.recipientRole) return responsibility.recipientRole;
  if (responsibility.recipientUserId == null) return null;
  const name = responsibility.recipientDisplayName?.trim();
  return name && name.length > 0 ? name : `User ${responsibility.recipientUserId}`;
}

function expectedResponseIso(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export default function PitCrewCommandCentre() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<SectionKey>("overview");
  const [actionError, setActionError] = useState<{ key: string; message: string } | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["pit-crew-workspace"],
    queryFn: fetchPitCrewWorkspace,
    refetchInterval: 30000,
  });

  // 404 from the inbox route means the responsibility routes are not
  // registered. While this is loading or anything other than a confirmed
  // 200, the new controls stay unmounted.
  const responsibilitySignal = useQuery({
    queryKey: ["pit-crew-responsibility-actions"],
    queryFn: pitCrewResponsibilityActionsVisible,
    retry: false,
  });
  const responsibilityActionsVisible = responsibilitySignal.data === true;

  function opts() {
    return {
      onSuccess: () => {
        setActionError(null);
        queryClient.invalidateQueries({ queryKey: ["pit-crew-workspace"] });
      },
      onError: (err: unknown, vars: { sourceType: string; sourceRecordId: string }) => {
        setActionError({
          key: pcKey(vars.sourceType, vars.sourceRecordId),
          message: err instanceof ApiError ? err.friendly : "Something went wrong. Try again.",
        });
      },
    };
  }

  function responsibilityOpts() {
    return {
      onSuccess: () => {
        setActionError(null);
        queryClient.invalidateQueries({ queryKey: ["pit-crew-workspace"] });
      },
      onError: (err: unknown, vars: { sourceType: string; sourceRecordId: string }) => {
        setActionError({
          key: pcKey(vars.sourceType, vars.sourceRecordId),
          message: pitCrewResponsibilityActionError(err),
        });
      },
    };
  }

  const claimMutation = useMutation({ mutationFn: claimPcItem, ...opts() });
  const assignMutation = useMutation({ mutationFn: assignPcItem, ...opts() });
  const startMutation = useMutation({ mutationFn: startPcItem, ...opts() });
  const waitingOnMutation = useMutation({ mutationFn: setPcWaitingOn, ...opts() });
  const returnMutation = useMutation({ mutationFn: returnPcItem, ...opts() });
  const completeMutation = useMutation({ mutationFn: completePcItem, ...opts() });
  const releaseMutation = useMutation({ mutationFn: releasePcItem, ...opts() });
  const handoffMutation = useMutation({ mutationFn: handoffPcItem, ...opts() });
  const noteMutation = useMutation({ mutationFn: addPcNote, ...opts() });
  const handBackMutation = useMutation({ mutationFn: handBackPcItem, ...responsibilityOpts() });
  const escalateMutation = useMutation({ mutationFn: escalatePcItem, ...responsibilityOpts() });
  const acknowledgeMutation = useMutation({ mutationFn: acknowledgePcEscalation, ...responsibilityOpts() });
  const resolveMutation = useMutation({ mutationFn: resolvePcEscalation, ...responsibilityOpts() });
  const returnEscalationMutation = useMutation({ mutationFn: returnPcEscalation, ...responsibilityOpts() });
  const reclaimMutation = useMutation({ mutationFn: reclaimPcHandBack, ...responsibilityOpts() });

  const allMutations = [
    claimMutation,
    assignMutation,
    startMutation,
    waitingOnMutation,
    returnMutation,
    completeMutation,
    releaseMutation,
    handoffMutation,
    noteMutation,
    handBackMutation,
    escalateMutation,
    acknowledgeMutation,
    resolveMutation,
    returnEscalationMutation,
    reclaimMutation,
  ];

  const actions: PcItemActions = {
    claim: (args) => claimMutation.mutate(args),
    assign: (args) => assignMutation.mutate(args),
    start: (args) => startMutation.mutate(args),
    waitingOn: (args) => waitingOnMutation.mutate(args),
    doReturn: (args) => returnMutation.mutate(args),
    complete: (args) => completeMutation.mutate(args),
    release: (args) => releaseMutation.mutate(args),
    handoff: (args) => handoffMutation.mutate(args),
    note: (args) => noteMutation.mutate(args),
    handBack: (args) => handBackMutation.mutate(args),
    escalate: (args) => escalateMutation.mutate(args),
    acknowledge: (args) => acknowledgeMutation.mutate(args),
    resolve: (args) => resolveMutation.mutate(args),
    returnEscalation: (args) => returnEscalationMutation.mutate(args),
    reclaim: (args) => reclaimMutation.mutate(args),
  };

  if (isLoading || !user) {
    return (
      <div className="card">
        <p className="muted">Loading Pit Crew workspace…</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="card">
        <p className="error-text">{error instanceof ApiError ? error.friendly : "Couldn't load the Pit Crew workspace."}</p>
      </div>
    );
  }

  const workspace = data;
  const team = workspace.team;
  const currentUserId = user.id;
  const currentUserRole = user.role;
  const sections = responsibilityActionsVisible ? [...SECTIONS, ...RESPONSIBILITY_SECTIONS] : [...SECTIONS];

  function isBusy(item: PcWorkItem): boolean {
    const key = pcKey(item.sourceType, item.sourceRecordId);
    return allMutations.some((m) => {
      const vars = m.variables as { sourceType: string; sourceRecordId: string } | undefined;
      return m.isPending && vars && pcKey(vars.sourceType, vars.sourceRecordId) === key;
    });
  }

  function renderItems(items: PcCardItem[], emptyLabel: string, title: string, distinguishLaunchSources = false) {
    const showSourceLabel = distinguishLaunchSources && items.some((item) => item.sourceType === "LAUNCH_ITEM");
    return (
      <section className="card">
        <h2>
          {title} ({items.length})
        </h2>
        {items.length === 0 ? (
          <p className="muted">{emptyLabel}</p>
        ) : (
          <ul className="item-list pc-item-list">
            {items.map((item) => {
              const itemKey = pcKey(item.sourceType, item.sourceRecordId);
              return (
                <PcItemCard
                  key={itemKey}
                  item={item}
                  currentUserId={currentUserId}
                  currentUserRole={currentUserRole}
                  team={team}
                  busy={isBusy(item)}
                  error={actionError?.key === itemKey ? actionError.message : null}
                  actions={actions}
                  responsibilityActionsVisible={responsibilityActionsVisible}
                  sourceLabel={showSourceLabel ? pitCrewLaunchSourceLabel(item.sourceType) : null}
                />
              );
            })}
          </ul>
        )}
      </section>
    );
  }

  function renderSection(key: Exclude<BaseSectionKey, "overview">, title: string) {
    const items = sectionItems(workspace, key) ?? [];
    return renderItems(items, EMPTY_LABELS[key], title, key === "launchCoordination");
  }

  function renderResponsibilitySection(key: ResponsibilitySectionKey, title: string) {
    const items = workspace[key] ?? [];
    return renderItems(items, RESPONSIBILITY_EMPTY_LABELS[key], title);
  }

  function sectionCount(key: SectionKey): number {
    if (key === "overview") return 0;
    if (key === "handedBack" || key === "escalated") return (workspace[key] ?? []).length;
    return (sectionItems(workspace, key) ?? []).length;
  }

  return (
    <div className="stack pc-page">
      <div className="primary-action">
        <div>
          <p className="eyebrow">Pit Crew</p>
          <h2>Command Centre</h2>
        </div>
      </div>

      <nav className="pc-tabs">
        {sections.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`pc-tab${tab === s.key ? " active" : ""}`}
            onClick={() => setTab(s.key)}
          >
            {s.label}
            {s.key !== "overview" && <span className="pc-tab-count">{sectionCount(s.key)}</span>}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <>
          <section className="card">
            <h2>Operations Overview</h2>
            <div className="stat-tiles">
              <StatTile label="Unassigned" value={data.summary.unassignedCount} />
              <StatTile label="My Work" value={data.summary.myWorkCount} />
              <StatTile label="Team Work" value={data.summary.teamWorkCount} />
              <StatTile label="Waiting On" value={data.summary.waitingOnCount} />
              <StatTile label="Overdue" value={data.summary.overdueCount} />
              <StatTile label="Completed Today" value={data.summary.completedTodayCount} />
            </div>
            <p className="muted">Updated {new Date(data.generatedAt).toLocaleTimeString()}</p>
          </section>
          <section className="card">
            <h2>Team Capacity ({team.length})</h2>
            {/* activeItemCount is the API team total. Claimed launch items are already in it. */}
            {team.length === 0 ? (
              <p className="muted">No Pit Crew members in this brokerage yet.</p>
            ) : (
              <ul className="item-list">
                {team.map((m) => (
                  <li key={m.userId}>
                    <strong>{pcTeamMemberName(m)}</strong>
                    <div className="muted">
                      {m.activeItemCount} active item{m.activeItemCount === 1 ? "" : "s"}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {tab === "myWork" && renderSection("myWork", "My Work")}
      {tab === "unassignedWork" && renderSection("unassignedWork", "Unassigned Work")}
      {tab === "teamWork" && renderSection("teamWork", "Team Work")}
      {tab === "launchCoordination" && renderSection("launchCoordination", "Launch Coordination")}
      {tab === "transactionCoordination" && renderSection("transactionCoordination", "Transaction Coordination")}
      {tab === "waitingOn" && renderSection("waitingOn", "Waiting On")}
      {tab === "completedToday" && renderSection("completedToday", "Completed Today")}
      {responsibilityActionsVisible && tab === "handedBack" && renderResponsibilitySection("handedBack", "Handed back")}
      {responsibilityActionsVisible && tab === "escalated" && renderResponsibilitySection("escalated", "Escalated")}
    </div>
  );
}

function ResponsibilityRecipientPicker({
  kind,
  emptyLabel,
  filter,
  onFilter,
  selectedUserId,
  onSelect,
  recipients,
  loadError,
}: {
  kind: PcResponsibilityRecipientKind;
  emptyLabel: string;
  filter: string;
  onFilter: (value: string) => void;
  selectedUserId: string;
  onSelect: (userId: string) => void;
  recipients: PcResponsibilityRecipient[];
  loadError: boolean;
}) {
  const needle = filter.trim().toLowerCase();
  const visible = recipients.filter((recipient) => recipient.displayName.toLowerCase().includes(needle));
  const selected = recipients.find((recipient) => String(recipient.userId) === selectedUserId);
  const searchName = kind === "HAND_BACK" ? "handBackRecipientSearch" : "escalateRecipientSearch";
  return (
    <div className="pc-recipient-picker">
      <input
        name={searchName}
        aria-label={kind === "HAND_BACK" ? "Search hand-back recipients" : "Search escalation recipients"}
        placeholder="Search by name"
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
        autoComplete="off"
      />
      {loadError && <p className="muted">{PIT_CREW_RECIPIENTS_UNAVAILABLE_MESSAGE}</p>}
      {selected && (
        <p className="muted">
          Selected: {selected.displayName} · {selected.role}
        </p>
      )}
      <div className="pc-recipient-options" role="listbox" aria-label={emptyLabel}>
        <button type="button" className="btn btn-secondary btn-small" aria-pressed={selectedUserId === ""} onClick={() => onSelect("")}>
          {emptyLabel}
        </button>
        {visible.map((recipient) => (
          <button
            key={recipient.userId}
            type="button"
            role="option"
            className="btn btn-secondary btn-small"
            aria-pressed={selectedUserId === String(recipient.userId)}
            onClick={() => onSelect(String(recipient.userId))}
          >
            {recipient.displayName} · {recipient.role}
          </button>
        ))}
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-tile">
      <span className="stat-tile-label">{label}</span>
      <span className="stat-tile-value">{value}</span>
    </div>
  );
}

// Section 12-14: one card renders every lifecycle state (safe concurrent
// claiming/assignment, handoff, active Waiting-On management) so the action
// set available is always exactly what the current pcStatus + ownership
// allow -- there is no separate "detail" screen that could drift out of
// sync with what the list view shows.
interface PcItemCardProps {
  item: PcCardItem;
  currentUserId: number;
  currentUserRole: string;
  team: PcTeamMember[];
  busy: boolean;
  error: string | null;
  actions: PcItemActions;
  responsibilityActionsVisible: boolean;
  sourceLabel: string | null;
}

type PcOpenForm =
  | "assign"
  | "waitingOn"
  | "handoff"
  | "note"
  | "handBack"
  | "escalate"
  | "acknowledge"
  | "resolve"
  | "returnEscalation"
  | null;

function PcItemCard({
  item,
  currentUserId,
  currentUserRole,
  team,
  busy,
  error,
  actions,
  responsibilityActionsVisible,
  sourceLabel,
}: PcItemCardProps) {
  const [openForm, setOpenForm] = useState<PcOpenForm>(null);
  const [assigneeUserId, setAssigneeUserId] = useState("");
  const [waitingOnParty, setWaitingOnParty] = useState("");
  const [waitingOnNote, setWaitingOnNote] = useState("");
  const [handoffToUserId, setHandoffToUserId] = useState("");
  const [handoffNote, setHandoffNote] = useState("");
  const [noteText, setNoteText] = useState("");
  const [handBackReason, setHandBackReason] = useState<PitCrewHandBackReasonCategory | "">("");
  const [handBackNextAction, setHandBackNextAction] = useState("");
  const [handBackNote, setHandBackNote] = useState("");
  const [handBackRecipient, setHandBackRecipient] = useState("");
  const [handBackRecipientFilter, setHandBackRecipientFilter] = useState("");
  const [escalateReason, setEscalateReason] = useState<PitCrewEscalationReasonCategory | "">("");
  const [escalateSeverity, setEscalateSeverity] = useState<PitCrewEscalationSeverity | "">("");
  const [escalateNote, setEscalateNote] = useState("");
  const [escalateNextAction, setEscalateNextAction] = useState("");
  const [escalateRecipient, setEscalateRecipient] = useState("");
  const [escalateRecipientFilter, setEscalateRecipientFilter] = useState("");
  const [escalateExpectedResponse, setEscalateExpectedResponse] = useState("");
  const [acknowledgeNote, setAcknowledgeNote] = useState("");
  const [resolveNote, setResolveNote] = useState("");
  const [returnEscalationNote, setReturnEscalationNote] = useState("");

  // Loaded when this card opens the form. The query key is the per-kind
  // cache for the page session, so another card or a reopened form reuses it.
  const handBackRecipients = useQuery({
    queryKey: ["pit-crew-responsibility-recipients", "HAND_BACK"],
    queryFn: () => fetchResponsibilityRecipients("HAND_BACK"),
    enabled: responsibilityActionsVisible && openForm === "handBack",
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const escalateRecipients = useQuery({
    queryKey: ["pit-crew-responsibility-recipients", "ESCALATE"],
    queryFn: () => fetchResponsibilityRecipients("ESCALATE"),
    enabled: responsibilityActionsVisible && openForm === "escalate",
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const isMine = item.assignedToUserId === currentUserId;
  const actor = { id: currentUserId, role: currentUserRole };
  const responsibilityItem = item.responsibility ? (item as PcResponsibilityWorkItem) : null;
  // Hand-back and escalate for LAUNCH_ITEM are deferred. EXCEPTION cards keep both.
  const showHandBackOrEscalate =
    responsibilityActionsVisible && isPitCrewActiveActionStatus(item.pcStatus) && item.sourceType !== "LAUNCH_ITEM";
  const showReclaim = responsibilityActionsVisible && item.pcStatus === "HANDED_BACK";
  const showAcknowledge = responsibilityItem != null && responsibilityActionsVisible && canAcknowledgeEscalation(responsibilityItem, actor);
  const showResolveOrReturn = responsibilityItem != null && responsibilityActionsVisible && canResolveOrReturnEscalation(responsibilityItem, actor);
  const expectedResponseRequired = escalateSeverity === "AT_RISK" || escalateSeverity === "CRITICAL";
  const base: PcMutationBase = {
    sourceType: item.sourceType,
    sourceRecordId: item.sourceRecordId,
    propertyId: item.propertyId,
    expectedVersion: item.version,
  };
  const toggle = (form: Exclude<PcOpenForm, null>) => setOpenForm((cur) => (cur === form ? null : form));

  return (
    <li className="pc-item">
      <div className="pc-item-header">
        <Link href={item.deepLink} className="pc-item-title">
          <span className={severityPillClass(item.severity)}>{severityLabel(item.severity)}</span>
          <strong>{item.title}</strong>
        </Link>
        <span className={pcStatusPillClass(item.pcStatus)}>{pcStatusLabel(item.pcStatus)}</span>
      </div>

      <p className="muted">
        {sourceLabel ? (
          <>
            <span className="pc-source-label">{sourceLabel}</span>
            {" · "}
          </>
        ) : null}
        {item.propertyAddress ?? `Property #${item.propertyId}`} · {categoryLabel(item.category)}
        {item.dueAt ? (
          <>
            {" · "}
            {isOverdue(item.dueAt) ? "overdue " : "due "}
            {formatDueDate(item.dueAt)}
          </>
        ) : null}
      </p>

      <p>{item.description}</p>
      <p className="muted">Recommended: {item.recommendedAction}</p>

      {item.assignedToName && (
        <p className="muted">
          Assigned to {item.assignedToName}
          {isMine ? " (you)" : ""}
        </p>
      )}

      {item.pcStatus === "WAITING_ON" && (
        <p className="muted">
          Waiting on {item.waitingOnParty}
          {item.waitingOnNote ? ` — ${item.waitingOnNote}` : ""}
          {item.waitingOnSince ? ` · since ${formatDueDate(item.waitingOnSince)}` : ""}
          {item.waitingOnExpectedAt ? ` · expected ${formatDueDate(item.waitingOnExpectedAt)}` : ""}
        </p>
      )}

      {item.pcStatus === "DONE" && item.completedAt && <p className="muted">Completed {formatDueDate(item.completedAt)}</p>}

      {item.responsibility && (
        <div className="muted">
          <p>Reason: {pitCrewReasonLabel(item.responsibility.reasonCategory)}</p>
          <p>Next action: {item.responsibility.nextAction}</p>
          {item.responsibility.severity && <p>Severity: {severityLabel(item.responsibility.severity)}</p>}
          {item.responsibility.expectedResponseAt && (
            <p>Expected response: {formatDueDate(item.responsibility.expectedResponseAt)}</p>
          )}
          {responsibilityRecipientLabel(item.responsibility) && <p>Recipient: {responsibilityRecipientLabel(item.responsibility)}</p>}
          {item.responsibility.note && <p>Note: {item.responsibility.note}</p>}
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      <div className="pc-item-actions">
        {item.pcStatus === "UNCLAIMED" && (
          <>
            <button className="btn btn-primary btn-small" disabled={busy} onClick={() => actions.claim(base)}>
              Claim
            </button>
            <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => toggle("assign")}>
              Assign to…
            </button>
          </>
        )}

        {isMine && item.pcStatus === "CLAIMED" && (
          <button className="btn btn-primary btn-small" disabled={busy} onClick={() => actions.start(base)}>
            Start
          </button>
        )}

        {isMine && (item.pcStatus === "CLAIMED" || item.pcStatus === "IN_PROGRESS") && (
          <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => toggle("waitingOn")}>
            Waiting on…
          </button>
        )}

        {isMine && item.pcStatus === "WAITING_ON" && (
          <button className="btn btn-primary btn-small" disabled={busy} onClick={() => actions.doReturn(base)}>
            Return
          </button>
        )}

        {isMine && isPitCrewActiveActionStatus(item.pcStatus) && (
          <>
            <button className="btn btn-primary btn-small" disabled={busy} onClick={() => actions.complete(base)}>
              Complete
            </button>
            <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => actions.release(base)}>
              Release
            </button>
            <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => toggle("handoff")}>
              Hand off…
            </button>
          </>
        )}

        {showHandBackOrEscalate && (
          <>
            <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => toggle("handBack")}>
              Hand back…
            </button>
            <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => toggle("escalate")}>
              Escalate…
            </button>
          </>
        )}

        {showReclaim && (
          <button className="btn btn-primary btn-small" disabled={busy} onClick={() => actions.reclaim(base)}>
            Reclaim
          </button>
        )}

        {showAcknowledge && (
          <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => toggle("acknowledge")}>
            Acknowledge…
          </button>
        )}

        {showResolveOrReturn && (
          <>
            <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => toggle("resolve")}>
              Resolve…
            </button>
            <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => toggle("returnEscalation")}>
              Return…
            </button>
          </>
        )}

        {item.pcStatus !== "DONE" && (
          <button className="btn btn-link btn-small" disabled={busy} onClick={() => toggle("note")}>
            Add note…
          </button>
        )}
      </div>

      {openForm === "assign" && (
        <form
          className="inline-form pc-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!assigneeUserId) return;
            actions.assign({ ...base, assigneeUserId: Number(assigneeUserId) });
            setAssigneeUserId("");
            setOpenForm(null);
          }}
        >
          <select value={assigneeUserId} onChange={(e) => setAssigneeUserId(e.target.value)} required>
            <option value="">Assign to…</option>
            {team.map((m) => (
              <option key={m.userId} value={m.userId}>
                {pcTeamMemberName(m)} ({m.activeItemCount} active)
              </option>
            ))}
          </select>
          <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
            Assign
          </button>
        </form>
      )}

      {openForm === "waitingOn" && (
        <form
          className="stack pc-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!waitingOnParty.trim()) return;
            actions.waitingOn({ ...base, waitingOnParty: waitingOnParty.trim(), waitingOnNote: waitingOnNote.trim() });
            setWaitingOnParty("");
            setWaitingOnNote("");
            setOpenForm(null);
          }}
        >
          <input
            placeholder="Waiting on whom? (e.g. Seller's solicitor)"
            value={waitingOnParty}
            onChange={(e) => setWaitingOnParty(e.target.value)}
            required
          />
          <input placeholder="Note (optional)" value={waitingOnNote} onChange={(e) => setWaitingOnNote(e.target.value)} />
          <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
            Save
          </button>
        </form>
      )}

      {openForm === "handoff" && (
        <form
          className="stack pc-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!handoffToUserId) return;
            actions.handoff({ ...base, toUserId: Number(handoffToUserId), note: handoffNote.trim() });
            setHandoffToUserId("");
            setHandoffNote("");
            setOpenForm(null);
          }}
        >
          <select value={handoffToUserId} onChange={(e) => setHandoffToUserId(e.target.value)} required>
            <option value="">Hand off to…</option>
            {team
              .filter((m) => m.userId !== currentUserId)
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {pcTeamMemberName(m)}
                </option>
              ))}
          </select>
          <input
            placeholder="Note for the next owner (optional)"
            value={handoffNote}
            onChange={(e) => setHandoffNote(e.target.value)}
          />
          <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
            Hand off
          </button>
        </form>
      )}

      {openForm === "note" && (
        <form
          className="stack pc-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!noteText.trim()) return;
            actions.note({
              sourceType: item.sourceType,
              sourceRecordId: item.sourceRecordId,
              propertyId: item.propertyId,
              note: noteText.trim(),
            });
            setNoteText("");
            setOpenForm(null);
          }}
        >
          <textarea
            placeholder="Add a note to this property"
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

      {showHandBackOrEscalate && openForm === "handBack" && (
        <form
          className="stack pc-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const nextAction = handBackNextAction.trim();
            if (!handBackReason || !nextAction) return;
            actions.handBack({
              ...base,
              reasonCategory: handBackReason,
              nextAction,
              note: handBackNote.trim() || undefined,
              recipientUserId: selectedRecipientId(handBackRecipient),
            });
            setOpenForm(null);
          }}
        >
          <select
            name="reasonCategory"
            value={handBackReason}
            onChange={(e) => setHandBackReason(e.target.value as PitCrewHandBackReasonCategory | "")}
            required
          >
            <option value="">Reason</option>
            {PIT_CREW_HAND_BACK_REASON_CATEGORIES.map((reason) => (
              <option key={reason} value={reason}>
                {pitCrewReasonLabel(reason)}
              </option>
            ))}
          </select>
          <input
            name="nextAction"
            placeholder="Next action"
            value={handBackNextAction}
            onChange={(e) => setHandBackNextAction(e.target.value)}
            required
          />
          <input
            name="note"
            placeholder="Note (optional)"
            value={handBackNote}
            onChange={(e) => setHandBackNote(e.target.value)}
          />
          <ResponsibilityRecipientPicker
            kind="HAND_BACK"
            emptyLabel="Property's agent (default)"
            filter={handBackRecipientFilter}
            onFilter={setHandBackRecipientFilter}
            selectedUserId={handBackRecipient}
            onSelect={setHandBackRecipient}
            recipients={handBackRecipients.data?.recipients ?? []}
            loadError={handBackRecipients.isError}
          />
          <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
            Hand back
          </button>
        </form>
      )}

      {showHandBackOrEscalate && openForm === "escalate" && (
        <form
          className="stack pc-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const note = escalateNote.trim();
            const nextAction = escalateNextAction.trim();
            const expectedResponseAt = expectedResponseIso(escalateExpectedResponse);
            if (!escalateReason || !escalateSeverity || !note || !nextAction) return;
            if (expectedResponseRequired && !expectedResponseAt) return;
            actions.escalate({
              ...base,
              reasonCategory: escalateReason,
              severity: escalateSeverity,
              note,
              nextAction,
              recipientUserId: selectedRecipientId(escalateRecipient),
              expectedResponseAt,
            });
            setOpenForm(null);
          }}
        >
          <select
            name="reasonCategory"
            value={escalateReason}
            onChange={(e) => setEscalateReason(e.target.value as PitCrewEscalationReasonCategory | "")}
            required
          >
            <option value="">Reason</option>
            {PIT_CREW_ESCALATION_REASON_CATEGORIES.map((reason) => (
              <option key={reason} value={reason}>
                {pitCrewReasonLabel(reason)}
              </option>
            ))}
          </select>
          <select
            name="severity"
            value={escalateSeverity}
            onChange={(e) => setEscalateSeverity(e.target.value as PitCrewEscalationSeverity | "")}
            required
          >
            <option value="">Severity</option>
            {PIT_CREW_ESCALATION_SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severityLabel(severity)}
              </option>
            ))}
          </select>
          <input name="note" placeholder="Note" value={escalateNote} onChange={(e) => setEscalateNote(e.target.value)} required />
          <input
            name="nextAction"
            placeholder="Next action"
            value={escalateNextAction}
            onChange={(e) => setEscalateNextAction(e.target.value)}
            required
          />
          <ResponsibilityRecipientPicker
            kind="ESCALATE"
            emptyLabel="Any Brokerage Administrator (default)"
            filter={escalateRecipientFilter}
            onFilter={setEscalateRecipientFilter}
            selectedUserId={escalateRecipient}
            onSelect={setEscalateRecipient}
            recipients={escalateRecipients.data?.recipients ?? []}
            loadError={escalateRecipients.isError}
          />
          <input
            name="expectedResponseAt"
            type="datetime-local"
            aria-label="Expected response"
            value={escalateExpectedResponse}
            onChange={(e) => setEscalateExpectedResponse(e.target.value)}
            required={expectedResponseRequired}
          />
          <p className="muted">Expected response is required for At Risk and Critical.</p>
          <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
            Escalate
          </button>
        </form>
      )}

      {openForm === "acknowledge" && (
        <form
          className="stack pc-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            actions.acknowledge({ ...base, note: acknowledgeNote.trim() || undefined });
            setAcknowledgeNote("");
            setOpenForm(null);
          }}
        >
          <input
            name="note"
            placeholder="Note (optional)"
            value={acknowledgeNote}
            onChange={(e) => setAcknowledgeNote(e.target.value)}
          />
          <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
            Acknowledge
          </button>
        </form>
      )}

      {openForm === "resolve" && (
        <form
          className="stack pc-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const note = resolveNote.trim();
            if (!note) return;
            actions.resolve({ ...base, note });
            setResolveNote("");
            setOpenForm(null);
          }}
        >
          <textarea
            name="note"
            placeholder="Note"
            value={resolveNote}
            onChange={(e) => setResolveNote(e.target.value)}
            required
            rows={2}
          />
          <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
            Resolve
          </button>
        </form>
      )}

      {openForm === "returnEscalation" && (
        <form
          className="stack pc-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const note = returnEscalationNote.trim();
            if (!note) return;
            actions.returnEscalation({ ...base, note });
            setReturnEscalationNote("");
            setOpenForm(null);
          }}
        >
          <textarea
            name="note"
            placeholder="Note"
            value={returnEscalationNote}
            onChange={(e) => setReturnEscalationNote(e.target.value)}
            required
            rows={2}
          />
          <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
            Return
          </button>
        </form>
      )}
    </li>
  );
}
