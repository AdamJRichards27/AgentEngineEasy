
// Agent Engine 2.0 -- Agent Daily Command Centre (Priority 6).
//
// A read-focused projection over existing AE systems (Properties, Property
// Timeline, Workflow Automation Engine, Exception & Risk Engine, Launch &
// Campaign Coordination, offers/transactions, existing tasks). This module
// owns no data of its own: every ActionItem is derived, on every read, from
// rows that already exist elsewhere. See lib/commandCentre/queries.ts.

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

// P0-P4, explicit factors only (Build Instructions Section 10) -- never an
// opaque AI/productivity score.
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

/** The unified Command Centre action item shape (Build Instructions Section 8). */
export interface ActionItem {
  id: string; // stable -- `${sourceType}:${sourceRecordId}`
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
  // Listing agent already stored on the property. Used only to label a row
  // the caller can already see. It does not change which properties load.
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
