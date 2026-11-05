import { getActingAuthority, type ActingAuthority } from "./actingAuthority";
// t246u (#285 release blocker): UI mirror of the API's requireRelationshipManage
// (apps/api/src/middlewares/entitlement.ts). The API stays the security boundary.
// Relationship changes (link, unlink, change role/primary) are allowed with the
// explicit grow.relationships.manage key, or with run.access for the roles that
// carry Run contact-management rights. run.access alone (e.g. Pit Crew) is not enough.
export const RUN_CONTACT_MANAGE_ROLES = ["Agent", "Brokerage Administrator"] as const;

// Owner t275u (replaces the t274u bar): Pit Crew changes relationships ONLY while it holds
// a contact owner's recorded authority (lib/actingAuthority.ts). The server re-checks the
// owner, the owner's entitlement and the contact/listing scope, and audits the change.
export const AUTHORITY_REQUIRED_ROLES = ["Pit Crew"] as const;

export function canManageRelationships(hasEntitlement: (key: string) => boolean, role: string | null | undefined, actingAuthority: ActingAuthority | null = getActingAuthority()): boolean {
  if (role && (AUTHORITY_REQUIRED_ROLES as readonly string[]).includes(role)) return actingAuthority !== null;
  if (hasEntitlement("grow.relationships.manage")) return true;
  return !!role && (RUN_CONTACT_MANAGE_ROLES as readonly string[]).includes(role) && hasEntitlement("run.access");
}
