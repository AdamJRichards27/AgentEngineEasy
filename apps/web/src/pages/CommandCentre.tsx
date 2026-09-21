import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch } from "../lib/api";
// AE GROW Completion W2-B (G-4) — the shared loading/failed/empty region
// presentation (components/GrowDataRegion.tsx). Named for Grow because that is
// where it was first needed; the failure it prevents is not Grow-specific.
import { GrowDataRegionStatus } from "../components/GrowDataRegion";
import {
  type ActionItem,
  type ActivePropertySummary,
  type CommandCentreResponse,
  formatDueDate,
  formatGeneratedAt,
  ownerTypeLabel,
  priorityLabel,
  priorityPillClass,
  responsibilityLabel,
  riskIndicatorPillClass,
  sourceTypeLabel,
} from "../lib/commandCentre";

// Agent Engine 2.0 -- Agent Daily Command Centre (Priority 6).
//
// "What needs my attention today?" A single read surface that re-presents
// ActionItems already sourced from the Exception & Risk Engine (authoritative
// for risk), Property Timeline, Launch stage, and Workflow Automation Engine --
// deduplicated and prioritised P0-P4 by lib/commandCentre/queries.ts on the
// API. This page owns no data or mutation logic of its own: every row links
// (via deepLink, a uniform /properties/:id link) into the Property Workspace,
// where the existing audited actions for that source already live -- the same
// "progressive disclosure, no duplicated action surface" pattern
// PropertyWorkspace.tsx itself uses for its own detail sections.
//
// Section order follows mobile-responsive priority: what's urgent (Now,
// Overdue, Today, Waiting On) leads as plain cards; what can wait (Coming Up,
// Active Properties, Pit Crew Activity, Completed Today) collapses into
// <details className="section"> below the fold, same convention as
// PropertyWorkspace.tsx's own secondary sections.
export default function CommandCentre() {
  const commandCentre = useQuery({
    queryKey: ["command-centre"],
    queryFn: () => apiFetch<CommandCentreResponse>("/command-centre"),
  });
  const { data, isLoading, isError } = commandCentre;

  return (
    <div>
      <div className="primary-action">
        <div className="eyebrow">Agent Engine 2.0</div>
        <h1>Today</h1>
        <p className="muted">
          {data ? (
            <>
              Hi {data.agent.firstName} -- here's what needs your attention, as of{" "}
              {formatGeneratedAt(data.generatedAt)} ({data.timeZone}).
            </>
          ) : (
            "What needs your attention today, across every property you can see."
          )}
        </p>
      </div>

      {/* AE GROW Completion W2-B (G-4/G-5): the error branch used to be
          `(error as ApiError).friendly`, which renders the literal "undefined"
          for any failure that is not an ApiError, and it offered no way to
          retry — on this screen, of all of them, the agent was told nothing
          needed their attention and given no way to find out otherwise. */}
      {(isLoading || isError) && (
        <GrowDataRegionStatus
          query={commandCentre}
          itemCount={undefined}
          loadingMessage="Loading..."
          errorFallback="Couldn't load Today."
          emptyMessage="Nothing to show yet."
          onRetry={() => void commandCentre.refetch()}
        />
      )}

      {!isLoading && !isError && data && (
        <>
          <div className="stat-tiles">
            <StatTile label="Critical" value={data.summary.critical} icon="🔴" />
            <StatTile label="Attention" value={data.summary.attention} icon="⚠️" />
            <StatTile label="Due Today" value={data.summary.dueToday} icon="📅" />
            <StatTile label="Overdue" value={data.summary.overdue} icon="⏰" />
            <StatTile label="Waiting On" value={data.summary.waitingOn} icon="⏳" />
            <StatTile label="Coming Up" value={data.summary.comingUp} icon="🔜" />
            <StatTile label="Pit Crew Active" value={data.summary.pcActive} icon="🔧" />
          </div>

          <ActionSection title="Now" items={data.now} emptyText="Nothing urgent right now." />
          <ActionSection title="Overdue" items={data.overdue} emptyText="Nothing overdue." />
          <ActionSection title="Today" items={data.today} emptyText="Nothing due today." />
          <ActionSection
            title="Waiting On"
            items={data.waitingOn}
            emptyText="Nothing waiting on someone else."
            mode="waitingOn"
          />

          <CollapsibleActionSection
            title="Coming Up"
            items={data.comingUp}
            emptyText="Nothing on the horizon yet."
          />

          <ActivePropertiesSection properties={data.activeProperties} />

          <CollapsibleActionSection
            title="Pit Crew Activity"
            items={data.pitCrew}
            // AE GROW Completion W2-B (G-8): this used to say Pit Crew service
            // assignment "isn't tracked in the schema yet, so this section will
            // stay empty until that exists". It is tracked
            // (packages/db/src/schema/pitCrew.ts's pitCrewAssignments) and this
            // section is populated from it (lib/commandCentre/queries.ts's
            // pitCrew filter), so the copy was telling the agent that a working
            // feature did not exist — and that an empty list meant nothing.
            emptyText="No Pit Crew activity right now."
          />

          <CollapsibleActionSection
            title="Completed Today"
            items={data.completedToday}
            emptyText="Nothing completed yet today."
            mode="completed"
          />
        </>
      )}
    </div>
  );
}

function StatTile({ label, value, icon }: { label: string; value: number; icon: string }) {
  return (
    <div className="stat-tile">
      <div>
        <div className="stat-tile-label">{label}</div>
        <div className="stat-tile-value">{value}</div>
      </div>
      <span className="stat-tile-icon" aria-hidden="true">
        {icon}
      </span>
    </div>
  );
}

type ActionRowMode = "waitingOn" | "completed";

function ActionSection({
  title,
  items,
  emptyText,
  mode,
}: {
  title: string;
  items: ActionItem[];
  emptyText: string;
  mode?: ActionRowMode;
}) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p className="empty-state">{emptyText}</p>
      ) : (
        <ul className="item-list">
          {items.map((item) => (
            <ActionRow key={item.id} item={item} mode={mode} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CollapsibleActionSection({
  title,
  items,
  emptyText,
  mode,
}: {
  title: string;
  items: ActionItem[];
  emptyText: string;
  mode?: ActionRowMode;
}) {
  return (
    <details className="section" open={items.length > 0}>
      <summary>
        {title}
        {items.length > 0 ? ` (${items.length})` : ""}
      </summary>
      {items.length === 0 ? (
        <p className="empty-state">{emptyText}</p>
      ) : (
        <ul className="item-list">
          {items.map((item) => (
            <ActionRow key={item.id} item={item} mode={mode} />
          ))}
        </ul>
      )}
    </details>
  );
}

function ActionRow({ item, mode }: { item: ActionItem; mode?: ActionRowMode }) {
  const due = formatDueDate(item.dueAt);
  const completedAt = mode === "completed" && item.completedAt ? formatGeneratedAt(item.completedAt) : null;
  return (
    <li>
      <Link href={item.deepLink}>
        <span className={priorityPillClass(item.priority)}>{priorityLabel(item.priority)}</span>{" "}
        <strong>{item.title}</strong> — {item.propertyAddress}
      </Link>
      <div className="muted">
        {sourceTypeLabel(item.sourceType)}
        {" · "}
        {ownerTypeLabel(item.accountableOwnerType)}
        {mode === "waitingOn" && item.waitingOnParty ? ` · waiting on ${item.waitingOnParty}` : null}
        {completedAt ? ` · completed ${completedAt}` : null}
        {!completedAt && mode !== "waitingOn" && due ? ` · ${item.overdue ? "overdue" : "due"} ${due}` : null}
      </div>
    </li>
  );
}

function ActivePropertiesSection({ properties }: { properties: ActivePropertySummary[] }) {
  return (
    <details className="section" open={properties.length > 0}>
      <summary>
        Active Properties
        {properties.length > 0 ? ` (${properties.length})` : ""}
      </summary>
      {properties.length === 0 ? (
        <p className="empty-state">No active properties yet.</p>
      ) : (
        <ul className="item-list">
          {properties.map((p) => (
            <li key={p.propertyId}>
              <Link href={`/properties/${p.propertyId}`}>
                <strong>{p.address}</strong> — {p.workflowStage}
              </Link>
              <div className="muted">
                {p.stageGroup}
                {p.riskIndicator ? (
                  <>
                    {" "}
                    <span className={riskIndicatorPillClass(p.riskIndicator)}>{p.riskIndicator}</span>
                  </>
                ) : null}
                {" · "}
                {responsibilityLabel(p.responsibility)}
                {p.nextAction ? ` · next: ${p.nextAction}` : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
