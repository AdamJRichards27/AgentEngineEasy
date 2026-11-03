// t263u (3): the relationship-control activation group. The desktop link-controls flag (VITE_PROPERTY_LINK_CONTROLS)
// and the eight mobile relationship-control flags (MOBILE_LINKING, Claude's config; read here, never edited) must be
// switched on TOGETHER. Any mixed / partial state is refused: every control in the group resolves OFF and the
// state is reported, so a partial activation cannot happen by accident. contactCanonicalRead is a read flag and
// not part of this group (X13-ACCEPTANCE.md). All flags are OFF on this base.
import { MOBILE_LINKING, type LinkingFlags } from "../minimal/mobile/mobileLinkingConfig";

export const MOBILE_RELATIONSHIP_CONTROL_FLAGS = [
  "contactLinkProperty", "contactEditRole", "contactUnlink", "contactEditPrimary",
  "propertyLinkContact", "propertyEditRole", "propertyEditPrimary", "propertyUnlink",
] as const satisfies ReadonlyArray<keyof LinkingFlags>;

export type GroupState = "ALL_OFF" | "ALL_ON" | "MIXED_REFUSED";
export interface RelationshipControlGroup {
  state: GroupState;
  /** Effective desktop link-controls flag. */
  desktop: boolean;
  /** Effective mobile flags: the group members forced OFF unless the whole group is ON; other flags untouched. */
  mobile: LinkingFlags;
  /** Which members were ON when the state was refused (for a console warning / test message). */
  onWhenRefused: string[];
}

export function resolveRelationshipControlGroup(desktopRequested: boolean, mobileRequested: LinkingFlags): RelationshipControlGroup {
  const members: Array<[string, boolean]> = [["VITE_PROPERTY_LINK_CONTROLS", desktopRequested], ...MOBILE_RELATIONSHIP_CONTROL_FLAGS.map((k) => [k, mobileRequested[k]] as [string, boolean])];
  const on = members.filter(([, v]) => v).map(([k]) => k);
  const state: GroupState = on.length === 0 ? "ALL_OFF" : on.length === members.length ? "ALL_ON" : "MIXED_REFUSED";
  const enabled = state === "ALL_ON";
  const mobile = { ...mobileRequested };
  for (const k of MOBILE_RELATIONSHIP_CONTROL_FLAGS) mobile[k] = enabled;
  return { state, desktop: enabled, mobile, onWhenRefused: state === "MIXED_REFUSED" ? on : [] };
}

export function desktopLinkControlsRequested(env: Record<string, unknown> | undefined): boolean {
  return env?.VITE_PROPERTY_LINK_CONTROLS === "true";
}

/** The group as built: the env flag plus Claude's MOBILE_LINKING. */
export function builtRelationshipControlGroup(env: Record<string, unknown> | undefined = (import.meta as { env?: Record<string, unknown> }).env, mobile: LinkingFlags = MOBILE_LINKING): RelationshipControlGroup {
  return resolveRelationshipControlGroup(desktopLinkControlsRequested(env), mobile);
}
