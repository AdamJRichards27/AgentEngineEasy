// t246u (#285 release blocker): UI mirror of the API's requireRelationshipManage
// (apps/api/src/middlewares/entitlement.ts). The API stays the security boundary.
// Relationship changes (link, unlink, change role/primary) are allowed with the
// explicit grow.relationships.manage key, or with run.access for the roles that
// carry Run contact-management rights. run.access alone (e.g. Pit Crew) is not enough.
export const RUN_CONTACT_MANAGE_ROLES = ["Agent", "Brokerage Administrator"] as const;

export function canManageRelationships(hasEntitlement: (key: string) => boolean, role: string | null | undefined): boolean {
  if (hasEntitlement("grow.relationships.manage")) return true;
  return !!role && (RUN_CONTACT_MANAGE_ROLES as readonly string[]).includes(role) && hasEntitlement("run.access");
}
