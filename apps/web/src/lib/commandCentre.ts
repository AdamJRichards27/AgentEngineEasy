// RUN Command Centre (Priority 6), frontend types. Route /today.
//
// This is property delivery (GET /command-centre). It is not Grow Today.
// The user-facing name, purpose line, and cross-link live in
// lib/todaySurfaces.ts. Mirrors apps/api/src/lib/commandCentre/types.ts by
// hand (the web app doesn't share a package with the API) so both read the
// same field names and enum values -- same convention lib/riskExceptions.ts
// already uses for the Exception & Risk Engine's types. The Command Centre
// re-presents ActionItems already sourced from the Exception & Risk Engine,
// Property Timeline, Launch stage, and Workflow Automation Engine -- it owns
// no data of its own.

export const COMMAND_CENTRE_SOURCE_TYPES = [
  "EXCEPTION",
  "WORKFLOW_ACTION",
  "AUTOMATION_TASK",
  "LAUNCH_ITEM",
  "VENDOR_APPROVAL",
  "PORTAL_DESTINATION",
  "PROPERTY_MILESTONE",
  "OFFER",
  "CONTRACT_MILESTONE",
  "SETTLEMENT_MILESTONE",
] as const;
export type CommandCentreSourceType = (typeof COMMAND_CENTRE_SOURCE_TYPES)[number];

export const PRIORITY_TIERS = ["P0", "P1", "P2", "P3", "P4"] as const;
export type PriorityTier = (typeof PRIORITY_TIERS)[number];

export const COMMAND_CENTRE_SECTIONS = [
  "now",
  "today",
  "overdue",
  "waitingOn",
  "comingUp",
  "completedToday",
] as const;
export type CommandCentreSection = (typeof COMMAND_CENTRE_SECTIONS)[number];

export interface ActionItem {
  id: string;
  sourceType: CommandCentreSourceType;
  sourceRecordId: string;
  propertyId: number;
  propertyAddress: string;
  brokerageId: number;
  agentId: number | null;
  title: string;
  description: string;
  category: string;
  severity: "INFORMATION" | "ATTENTION" | "AT_RISK" | "CRITICAL" | null;
  status: string;
  accountableOwnerType: string;
  accountableOwnerUserId: number | null;
  performingParty: string;
  waitingOnParty: string | null;
  dueAt: string | null;
  timeZone: string;
  overdue: boolean;
  recommendedAction: string;
  deepLink: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  priority: PriorityTier;
  sections: CommandCentreSection[];
}

export interface ActivePropertySummary {
  propertyId: number;
  address: string;
  stageGroup: string;
  workflowStage: string;
  nextMilestone: string | null;
  nextAction: string | null;
  riskIndicator: "CRITICAL" | "AT_RISK" | "ATTENTION" | null;
  responsibility: "AGENT" | "PIT_CREW" | "SHARED";
  // Listing agent already stored on the property. Display only.
  responsibleAgentId: number;
  responsibleAgentName: string;
}

export interface CommandCentreSummary {
  critical: number;
  attention: number;
  dueToday: number;
  overdue: number;
  waitingOn: number;
  comingUp: number;
  pcActive: number;
}

export interface CommandCentreResponse {
  generatedAt: string;
  timeZone: string;
  timeZoneSource: "user" | "brokerage" | "fallback";
  agent: { id: number; firstName: string; role: string };
  summary: CommandCentreSummary;
  now: ActionItem[];
  today: ActionItem[];
  overdue: ActionItem[];
  waitingOn: ActionItem[];
  comingUp: ActionItem[];
  activeProperties: ActivePropertySummary[];
  pitCrew: ActionItem[];
  completedToday: ActionItem[];
}

// Display helpers -- mirror lib/riskExceptions.ts's conventions so the two
// exception/action surfaces (Exceptions.tsx's cross-property view, and this
// Command Centre) read consistently to an agent.

export function priorityLabel(priority: PriorityTier): string {
  switch (priority) {
    case "P0":
      return "Critical";
    case "P1":
      return "Urgent";
    case "P2":
      return "Today";
    case "P3":
      return "Upcoming";
    case "P4":
      return "Low";
    default:
      return priority;
  }
}

// Only three status tones exist in this app's design system (pill /
// pill-warning / pill-danger -- see styles.css), same convention as
// lib/riskExceptions.ts's severityPillClass: P0/P1 need action now, P2 reads
// as a caution, P3/P4 are informational.
export function priorityPillClass(priority: PriorityTier): string {
  if (priority === "P0" || priority === "P1") return "pill pill-danger";
  if (priority === "P2") return "pill pill-warning";
  return "pill";
}

export function sourceTypeLabel(sourceType: CommandCentreSourceType): string {
  switch (sourceType) {
    case "EXCEPTION":
      return "Exception";
    case "WORKFLOW_ACTION":
      return "Workflow Action";
    case "AUTOMATION_TASK":
      return "Automation Task";
    case "LAUNCH_ITEM":
      return "Launch Item";
    case "VENDOR_APPROVAL":
      return "Vendor Approval";
    case "PORTAL_DESTINATION":
      return "Portal Destination";
    case "PROPERTY_MILESTONE":
      return "Property Milestone";
    case "OFFER":
      return "Offer";
    case "CONTRACT_MILESTONE":
      return "Contract Milestone";
    case "SETTLEMENT_MILESTONE":
      return "Settlement Milestone";
    default:
      return sourceType;
  }
}

// Mirrors apps/api/src/lib/commandCentre/queries.ts's OWNER_LABELS exactly --
// note this collapses LISTING_AGENT/TRANSACTION_OWNER to "Agent" (unlike
// lib/riskExceptions.ts's ownerTypeLabel), because the Command Centre's
// question is simply "is this on me or not", not who legally owns the record.
const OWNER_LABELS: Record<string, string> = {
  LISTING_AGENT: "Agent",
  TRANSACTION_OWNER: "Agent",
  BROKERAGE_ADMINISTRATOR: "Brokerage Administrator",
  PIT_CREW: "Pit Crew",
  UNASSIGNED_QUEUE: "Unassigned",
};

export function ownerTypeLabel(ownerType: string): string {
  return OWNER_LABELS[ownerType] ?? ownerType;
}

export function riskIndicatorPillClass(risk: "CRITICAL" | "AT_RISK" | "ATTENTION" | null): string {
  if (risk === "CRITICAL" || risk === "AT_RISK") return "pill pill-danger";
  if (risk === "ATTENTION") return "pill pill-warning";
  return "pill pill-success";
}

export function responsibilityLabel(
  responsibility: ActivePropertySummary["responsibility"],
  viewerId: number,
  property: Pick<ActivePropertySummary, "responsibleAgentId" | "responsibleAgentName">,
): string {
  switch (responsibility) {
    case "AGENT":
      // "You" is the viewer. A brokerage-wide reader (administrator or Pit
      // Crew) otherwise sees the listing agent's name. An agent's own list
      // only contains properties they are responsible for, so those stay "You".
      if (property.responsibleAgentId === viewerId) return "You";
      return property.responsibleAgentName.trim() || "Agent";
    case "PIT_CREW":
      return "Pit Crew";
    case "SHARED":
      return "Shared";
    default:
      return responsibility;
  }
}

export function formatDueDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function formatGeneratedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
