// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7).
//
// Answers "what must Pit Crew do next, for whom, and by when?" for the two
// roles allowed to see it (Section 26): Pit Crew and Brokerage Administrator.
// App.tsx only shows the nav link to those roles, and the API independently
// enforces the same gate (requireRole(...PIT_CREW_ROLES, ...BROKERAGE_ADMIN_
// ROLES) in routes/pitCrew.ts) -- the nav hiding is a UX nicety, not the
// security boundary.
//
// Section 22: the Agent Daily Command Centre (Priority 6, PR #14) is still
// unmerged, so this reads straight from getPitCrewWorkspace (which itself
// sources from the Exception & Risk Engine's listBrokerageExceptions) rather
// than depending on or duplicating that feature.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { useSession } from "../lib/session";
import { ApiError } from "../lib/api";
import {
  addPcNote,
  assignPcItem,
  claimPcItem,
  completePcItem,
  fetchPitCrewWorkspace,
  handoffPcItem,
  pcStatusLabel,
  pcStatusPillClass,
  pcTeamMemberName,
  releasePcItem,
  returnPcItem,
  setPcWaitingOn,
  startPcItem,
  type PcMutationBase,
  type PcTeamMember,
  type PcWorkItem,
  type PcWorkspace,
} from "../lib/pitCrew";
import { categoryLabel, formatDueDate, isOverdue, severityLabel, severityPillClass } from "../lib/riskExceptions";

function pcKey(sourceType: string, sourceRecordId: string): string {
  return `${sourceType}:${sourceRecordId}`;
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

type SectionKey = (typeof SECTIONS)[number]["key"];

function sectionItems(data: PcWorkspace, key: SectionKey): PcWorkItem[] | null {
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

const EMPTY_LABELS: Record<Exclude<SectionKey, "overview">, string> = {
  myWork: "Nothing claimed yet. Pick something up from Unassigned Work.",
  unassignedWork: "Nothing waiting for a Pit Crew member right now.",
  teamWork: "No active Pit Crew work across the team.",
  launchCoordination: "No launch campaign items need Pit Crew right now.",
  transactionCoordination: "No offer, condition, or settlement items need Pit Crew right now.",
  waitingOn: "Nothing is currently blocked waiting on someone else.",
  completedToday: "Nothing completed yet today.",
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

  const claimMutation = useMutation({ mutationFn: claimPcItem, ...opts() });
  const assignMutation = useMutation({ mutationFn: assignPcItem, ...opts() });
  const startMutation = useMutation({ mutationFn: startPcItem, ...opts() });
  const waitingOnMutation = useMutation({ mutationFn: setPcWaitingOn, ...opts() });
  const returnMutation = useMutation({ mutationFn: returnPcItem, ...opts() });
  const completeMutation = useMutation({ mutationFn: completePcItem, ...opts() });
  const releaseMutation = useMutation({ mutationFn: releasePcItem, ...opts() });
  const handoffMutation = useMutation({ mutationFn: handoffPcItem, ...opts() });
  const noteMutation = useMutation({ mutationFn: addPcNote, ...opts() });

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

  const team = data.team;
  const currentUserId = user.id;

  function isBusy(item: PcWorkItem): boolean {
    const key = pcKey(item.sourceType, item.sourceRecordId);
    return allMutations.some((m) => {
      const vars = m.variables as { sourceType: string; sourceRecordId: string } | undefined;
      return m.isPending && vars && pcKey(vars.sourceType, vars.sourceRecordId) === key;
    });
  }

  function renderSection(key: Exclude<SectionKey, "overview">, title: string) {
    const items = sectionItems(data as PcWorkspace, key) ?? [];
    return (
      <section className="card">
        <h2>
          {title} ({items.length})
        </h2>
        {items.length === 0 ? (
          <p className="muted">{EMPTY_LABELS[key]}</p>
        ) : (
          <ul className="item-list pc-item-list">
            {items.map((item) => {
              const itemKey = pcKey(item.sourceType, item.sourceRecordId);
              return (
                <PcItemCard
                  key={itemKey}
                  item={item}
                  currentUserId={currentUserId}
                  team={team}
                  busy={isBusy(item)}
                  error={actionError?.key === itemKey ? actionError.message : null}
                  actions={actions}
                />
              );
            })}
          </ul>
        )}
      </section>
    );
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
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`pc-tab${tab === s.key ? " active" : ""}`}
            onClick={() => setTab(s.key)}
          >
            {s.label}
            {s.key !== "overview" && (
              <span className="pc-tab-count">{(sectionItems(data, s.key) ?? []).length}</span>
            )}
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
  item: PcWorkItem;
  currentUserId: number;
  team: PcTeamMember[];
  busy: boolean;
  error: string | null;
  actions: PcItemActions;
}

type PcOpenForm = "assign" | "waitingOn" | "handoff" | "note" | null;

function PcItemCard({ item, currentUserId, team, busy, error, actions }: PcItemCardProps) {
  const [openForm, setOpenForm] = useState<PcOpenForm>(null);
  const [assigneeUserId, setAssigneeUserId] = useState("");
  const [waitingOnParty, setWaitingOnParty] = useState("");
  const [waitingOnNote, setWaitingOnNote] = useState("");
  const [handoffToUserId, setHandoffToUserId] = useState("");
  const [handoffNote, setHandoffNote] = useState("");
  const [noteText, setNoteText] = useState("");

  const isMine = item.assignedToUserId === currentUserId;
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

        {isMine && item.pcStatus !== "UNCLAIMED" && item.pcStatus !== "DONE" && (
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
    </li>
  );
}
