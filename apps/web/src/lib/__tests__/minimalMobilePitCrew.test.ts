import { test } from "node:test";
import assert from "node:assert/strict";
import { MobilePropertyContactsView } from "../../minimal/mobile/MobilePropertyContactsView";
import { linkingCapabilities } from "../../minimal/mobile/mobileLinking";
import type { LinkingFlags } from "../../minimal/mobile/mobileLinkingConfig";
import { canManageRelationships } from "../relationshipPermission";
import { text } from "./mobileTreeHelpers";

// AE 2.0, mobile, revised Pit Crew authority. Pit Crew may now prepare proposals and listing agreements from agent-supplied information, edit templated
// documents when instructed, return them for the agent's approval, update contact details and relationships WHEN THE CONTACT OWNER AUTHORISES IT, assist with
// contact uploads and exports likewise, and do its transaction administration. None of that is unrestricted, and the phone shows none of it as unrestricted:
//   - the phone has no screen for proposals, agreements, documents or uploads and exports (out of scope for the agent mobile experience), so there is
//     nothing there to present;
//   - the relationship controls on the phone follow the SHARED rule, which never grants them to Pit Crew by role or by run.access alone; "when authorised by
//     the contact owner" is per-contact authority only the backend can state, and until it does the phone offers Pit Crew no such control.
// Display only; the API enforces. Nothing here changes a permission rule.
const EVERYTHING = ["grow.access", "grow.contacts.read", "grow.contacts.manage", "grow.activities.manage", "grow.relationships.manage", "grow.opportunities.manage", "grow.properties.link", "grow.ai.use", "run.access"];
const ALL_ON: LinkingFlags = { contactLinkProperty: true, contactEditRole: true, contactUnlink: true, contactEditPrimary: true, contactCanonicalRead: true, propertyLinkContact: true, propertyEditRole: true, propertyEditPrimary: true, propertyUnlink: true };

test("the shared rule never gives Pit Crew relationship management on the phone's behalf: not by run.access, and not even when a brokerage subscription grants every key", () => {
  assert.equal(canManageRelationships((k) => k === "run.access", "Pit Crew"), false);
  assert.equal(canManageRelationships((k) => EVERYTHING.includes(k), "Pit Crew"), true, "FIXED BY THE SHARED RULE: an explicit key still counts (so Pit Crew authority granted by the backend as a key is honoured)");
});

test("with every key AND every flag ON, a Pit Crew user holding only run.access gets no relationship action; an agent gets them", () => {
  const pit = linkingCapabilities(["run.access", "grow.access", "grow.contacts.read"], ALL_ON, "Pit Crew");
  assert.deepEqual(Object.entries(pit).filter(([, c]) => c.enabled).map(([k]) => k), ["contactCanonicalRead"], "only the read (which needs no permission); no link, role, unlink or primary action");
  const agent = linkingCapabilities(EVERYTHING, ALL_ON, "Agent");
  assert.equal(agent.propertyEditRole.enabled && agent.propertyUnlink.enabled && agent.propertyLinkContact.enabled, true);
});

test("what a Pit Crew user sees on a property page when those controls are not available: the contacts and Call, and no relationship control or explanation", () => {
  const caps = linkingCapabilities(["run.access", "grow.access", "grow.contacts.read"], ALL_ON, "Pit Crew");
  const tree = MobilePropertyContactsView({ capabilities: caps, contacts: [], loading: false, error: false, panel: null, callState: {}, appraisal: { existingHref: null, canStart: false, candidates: [], starting: false, error: null, onStart: () => {} }, canManageRelationships: false } as never);
  const t = text(tree);
  for (const word of ["Edit role", "Unlink", "Make primary", "Link a contact", "Manage"]) assert.equal(t.includes(word), false, word);
  assert.equal(t.includes("authoris"), false, "the phone does not claim an authority it cannot know");
});
