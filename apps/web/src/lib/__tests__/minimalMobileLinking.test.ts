import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GROW_PROPERTIES_LINK, GROW_RELATIONSHIPS_MANAGE, LINKING_TWINS, LINK_PICKER_ROWS, LINK_ROLE_LABELS, MOBILE_LINKING, MOBILE_LINK_CONTRACT, ROLES_ACCEPTED_NOW, ROLES_APPROVED_PENDING,
  type LinkContract, type LinkingFlags,
} from "../../minimal/mobile/mobileLinkingConfig";
import { mayCallFromProperty } from "../../minimal/mobile/mobileCalling";
import {
  CHOOSE_CONTACT, CHOOSE_PROPERTY, NOT_AVAILABLE_YET, NO_PERMISSION, SAME_ROLE,
  canonicalContactLinksPath, changeRoleRequest, linkRequest, linkRoleLabel, setPrimaryRequest, linkingCapabilities, linkingFailureText, parseContactLinks, roleChoices, unlinkConfirmText, unlinkRequest, type KnownLink,
} from "../../minimal/mobile/mobileLinking";
import { LINK_ALREADY_EXISTS, LINK_FORBIDDEN, LINK_INVALID, LINK_NOT_FOUND, LINK_ROLE_REQUIRED } from "../../minimal/properties/minimalPropertyContactsModel";

// AE Mobile (CC Task #64, M4 linking): ONE canonical contract, property_parties, used identically from a contact and from a property.
// Every control is OFF until the backend supports both directions securely.

const ALL_ON: LinkingFlags = { contactLinkProperty: true, contactEditRole: true, contactUnlink: true, contactEditPrimary: true, contactCanonicalRead: true, propertyLinkContact: true, propertyEditRole: true, propertyEditPrimary: true, propertyUnlink: true };
const EXPANDED: LinkContract = { expandedRolesAccepted: true };
// Tests that are about the contract pass it explicitly, so they hold whether or not the shipped constant (and the server) has the expanded roles yet.
const NOT_EXPANDED: LinkContract = { expandedRolesAccepted: false };
const MANAGER = [GROW_RELATIONSHIPS_MANAGE, GROW_PROPERTIES_LINK];
const ok = (r: { ok: boolean }) => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { ok: true; request: { path: string; method: string; body?: Record<string, unknown> } }).request; };
const bad = (r: { ok: boolean }) => { assert.equal(r.ok, false, JSON.stringify(r)); return (r as { ok: false; error: string }).error; };
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("every link control, and the canonical read, is OFF as shipped, with its reason, whatever the user's permissions", () => {
  assert.deepEqual(Object.values(MOBILE_LINKING), [false, false, false, false, false, false, false, false, false], "change this together with the test that guards it");
  for (const entitlements of [MANAGER, [], null, ["run.access"]]) {
    for (const [action, cap] of Object.entries(linkingCapabilities(entitlements))) assert.deepEqual(cap, { enabled: false, reason: NOT_AVAILABLE_YET }, action);
  }
});

test("both directions or neither: a contact-side control and its property-side twin are always switched together", () => {
  for (const [a, b] of LINKING_TWINS) assert.equal(MOBILE_LINKING[a], MOBILE_LINKING[b], `${a} and ${b}`);
  assert.equal(LINKING_TWINS.length, 4, "link, change role, unlink, make primary");
  // the contact screen reads canonical links only when the contact-side writes use the same table
  if (MOBILE_LINKING.contactCanonicalRead) assert.ok(MOBILE_LINKING.contactLinkProperty, "reading the canonical table without the canonical writes would mix the two models");
});

test("when the backend is ready, a control needs the keys the server checks; a read-only user sees it disabled", () => {
  const caps = linkingCapabilities(MANAGER, ALL_ON);
  assert.deepEqual(Object.values(caps).map((c) => c.enabled), [true, true, true, true, true, true, true, true, true]);
  const manageOnly = linkingCapabilities([GROW_RELATIONSHIPS_MANAGE], ALL_ON);
  assert.deepEqual({ ...manageOnly.contactLinkProperty }, { enabled: false, reason: NO_PERMISSION }, "naming a property also needs grow.properties.link");
  assert.equal(manageOnly.contactEditRole.enabled && manageOnly.contactUnlink.enabled && manageOnly.propertyLinkContact.enabled, true);
  const reader = linkingCapabilities(["grow.access", "grow.contacts.read"], ALL_ON);
  for (const [action, cap] of Object.entries(reader)) assert.deepEqual(cap, action === "contactCanonicalRead" ? { enabled: true, reason: null } : { enabled: false, reason: NO_PERMISSION }, action);
  for (const missing of [null, undefined] as const) {
    for (const [action, cap] of Object.entries(linkingCapabilities(missing, ALL_ON))) assert.equal(cap.enabled, false, `fails closed while permissions load: ${action}`);
  }
});

test("a flag that is off wins over any permission, and each flag is separate", () => {
  const onlyUnlink = linkingCapabilities(MANAGER, { ...MOBILE_LINKING, contactUnlink: true, propertyUnlink: true });
  assert.equal(onlyUnlink.contactUnlink.enabled && onlyUnlink.propertyUnlink.enabled, true);
  assert.equal(onlyUnlink.contactLinkProperty.enabled || onlyUnlink.propertyEditRole.enabled, false);
});

test("the role vocabulary: what the server accepts today, plus Owner, Landlord and Tenant only once the server validates them", () => {
  assert.deepEqual([...ROLES_ACCEPTED_NOW], ["Seller", "Buyer", "Solicitor", "PowerOfAttorney", "Other"]);
  assert.deepEqual([...ROLES_APPROVED_PENDING], ["Owner", "Landlord", "Tenant"]);
  assert.deepEqual(roleChoices({ expandedRolesAccepted: false }).map((r) => r.value), [...ROLES_ACCEPTED_NOW]);
  assert.deepEqual(roleChoices(EXPANDED).map((r) => r.value), [...ROLES_ACCEPTED_NOW, ...ROLES_APPROVED_PENDING]);
  assert.equal(roleChoices({ expandedRolesAccepted: false }).some((r) => ROLES_APPROVED_PENDING.includes(r.value as never)), false, "never offered unless the contract says the server accepts them");
  assert.deepEqual(roleChoices().map((r) => r.value), MOBILE_LINK_CONTRACT.expandedRolesAccepted ? [...ROLES_ACCEPTED_NOW, ...ROLES_APPROVED_PENDING] : [...ROLES_ACCEPTED_NOW], "the default follows the contract constant, whichever way it is set");
  assert.equal(LINK_ROLE_LABELS.Seller, "Seller", "the approved label");
  assert.deepEqual(roleChoices(EXPANDED).slice(-3).map((r) => r.label), ["Owner", "Landlord", "Tenant"]);
  assert.equal(linkRoleLabel("Tenant"), "Tenant");
  assert.equal(linkRoleLabel("SomethingNew"), "SomethingNew", "an unknown stored role is shown as stored, never hidden");
  assert.equal(LINK_PICKER_ROWS, 5);
});

test("link an existing contact, from a contact or a property: the same single request, nothing defaulted", () => {
  const req = ok(linkRequest(77, 12, "Buyer", []));
  assert.deepEqual(req, { path: "/parties", method: "POST", body: { propertyId: 77, partyId: 12, role: "Buyer" } });
  assert.deepEqual(Object.keys(req.body ?? {}).sort(), ["partyId", "propertyId", "role"], "no contact fields, so no new contact can be made");
  assert.equal(bad(linkRequest(77, 12, "", [])), LINK_ROLE_REQUIRED, "nothing defaults to Seller");
  assert.equal(bad(linkRequest(77, 12, "Boss", [])), LINK_ROLE_REQUIRED);
  assert.equal(bad(linkRequest(0, 12, "Buyer", [])), CHOOSE_PROPERTY);
  assert.equal(bad(linkRequest(77, null, "Buyer", [])), CHOOSE_CONTACT);
  assert.equal(bad(linkRequest(77, 1.5, "Buyer", [])), CHOOSE_CONTACT);
});

test("the approved roles are refused until the server validates them, then accepted", () => {
  for (const role of ROLES_APPROVED_PENDING) {
    assert.equal(bad(linkRequest(77, 12, role, [], NOT_EXPANDED)), LINK_ROLE_REQUIRED, role);
    assert.deepEqual(ok(linkRequest(77, 12, role, [], EXPANDED)).body, { propertyId: 77, partyId: 12, role });
  }
});

test("a repeat is stopped before the server has to: same contact, same property, same role", () => {
  const known: KnownLink[] = [{ linkId: 1, propertyId: 77, partyId: 9, role: "Seller" }];
  assert.equal(bad(linkRequest(77, 9, "Seller", known)), LINK_ALREADY_EXISTS);
  assert.equal(ok(linkRequest(77, 9, "Buyer", known)).body?.role, "Buyer", "a different role is a different link");
  assert.equal(ok(linkRequest(78, 9, "Seller", known)).body?.propertyId, 78, "another property is another link");
  assert.equal(ok(linkRequest(77, 10, "Seller", known)).body?.partyId, 10, "another contact is another link");
});

test("change a role: only the role is sent, from the offered list, and not to the role it already has", () => {
  assert.deepEqual(ok(changeRoleRequest(31, "Buyer", "Seller", NOT_EXPANDED)), { path: "/parties/link/31", method: "PATCH", body: { role: "Buyer" } });
  assert.equal(bad(changeRoleRequest(31, "Seller", "Seller")), SAME_ROLE);
  assert.equal(bad(changeRoleRequest(31, "", "Seller")), LINK_ROLE_REQUIRED);
  assert.equal(bad(changeRoleRequest(31, "Tenant", "Seller", NOT_EXPANDED)), LINK_ROLE_REQUIRED, "approved but not yet validated by the server");
  assert.equal(ok(changeRoleRequest(31, "Tenant", "Seller", EXPANDED)).body?.role, "Tenant");
  assert.match(bad(changeRoleRequest(0, "Buyer", null)), /couldn’t be found/);
});

test("make primary: one PATCH, only the flag, from either side; the server keeps one primary per property and role", () => {
  assert.deepEqual(ok(setPrimaryRequest(31)), { path: "/parties/link/31", method: "PATCH", body: { isPrimary: true } });
  assert.match(bad(setPrimaryRequest(0)), /couldn’t be found/);
  assert.equal(Object.keys(ok(setPrimaryRequest(31)).body ?? {}).join(), "isPrimary", "never sends a role, so it cannot change one");
});

test("unlink removes the link only, from either side", () => {
  assert.deepEqual(ok(unlinkRequest(31)), { path: "/parties/link/31", method: "DELETE" });
  assert.equal("body" in ok(unlinkRequest(31)), false);
  assert.match(bad(unlinkRequest(-1)), /couldn’t be found/);
});

test("no request names a brokerage, a user or a tenant, and there is no request that touches the Grow relationship table", () => {
  const all = [ok(linkRequest(77, 12, "Buyer", [])), ok(changeRoleRequest(31, "Buyer", null)), ok(setPrimaryRequest(31)), ok(unlinkRequest(31))];
  for (const r of all) {
    assert.doesNotMatch(JSON.stringify(r), /brokerage|tenant|userId|createdBy/i);
    assert.doesNotMatch(r.path, /relationships/, "no dual write, no second table");
  }
});

test("who sees Call beside a property's contacts: anyone who may read contacts (including a read-only agent) or has Run; nobody else; consent is not part of it", () => {
  assert.equal(mayCallFromProperty(["grow.access", "grow.contacts.read"]), true, "read-only agent with contact read");
  assert.equal(mayCallFromProperty(["grow.access", "grow.contacts.read", "grow.contacts.manage", "grow.activities.manage"]), true);
  assert.equal(mayCallFromProperty(["run.access"]), true, "Run access");
  assert.equal(mayCallFromProperty(["grow.access"]), false, "Grow without contact read");
  assert.equal(mayCallFromProperty([]), false, "unsubscribed");
  for (const missing of [null, undefined]) assert.equal(mayCallFromProperty(missing), false, "fails closed while permissions load");
  assert.equal(mayCallFromProperty.length, 1, "takes entitlements only: no consent input");
});

test("the contact's property links are read from property_parties, defensively", () => {
  assert.equal(canonicalContactLinksPath(12), "/parties/by-contact/12");
  const good = { linkId: 31, role: "Seller", isPrimary: true, property: { id: 77, formattedAddress: " 7 Jacaranda Street, Paddington QLD 4064 " } };
  assert.deepEqual(parseContactLinks({ links: [good] }), [{ linkId: 31, role: "Seller", isPrimary: true, propertyId: 77, address: "7 Jacaranda Street, Paddington QLD 4064" }]);
  assert.deepEqual(parseContactLinks({ links: [{ ...good, property: { id: 78 } }] })[0]?.address, "Property 78");
  for (const junk of [null, undefined, {}, { links: "x" }, { links: [null, 3, {}, { linkId: 0, role: "Seller", property: { id: 1 } }, { linkId: 1, role: 5, property: { id: 1 } }, { linkId: 1, role: "Seller" }, { linkId: 1, role: "Seller", property: { id: -1 } }] }]) {
    assert.deepEqual(parseContactLinks(junk), [], JSON.stringify(junk));
  }
});

test("the unlink confirmation names both sides and says nothing is deleted; failures are plain sentences", () => {
  assert.equal(unlinkConfirmText("Maya Okafor", "7 Jacaranda Street"), "Unlink Maya Okafor from 7 Jacaranda Street? This ends the link. The contact and the property stay.");
  assert.equal(linkingFailureText({ status: 409 }, "x"), LINK_ALREADY_EXISTS);
  assert.equal(linkingFailureText({ status: 404 }, "x"), LINK_NOT_FOUND);
  assert.equal(linkingFailureText({ status: 403 }, "x"), LINK_FORBIDDEN);
  assert.equal(linkingFailureText({ status: 400 }, "x"), LINK_INVALID);
  assert.equal(linkingFailureText({ status: 500 }, "Try again."), "Try again.");
  assert.equal(linkingFailureText(null, "Try again."), "Try again.");
});

// ── drift: the contract is the real server's, and no control can be switched on ahead of it ───────

test("drift: the existing routes, entitlement keys and role list are the real server's", () => {
  const parties = read("../../../../api/src/routes/parties.ts");
  const schema = read("../../../../../packages/db/src/schema/property.ts");
  const billing = read("../../../../../packages/db/src/schema/billing.ts");
  assert.match(parties, /partiesRouter\.post\("\/", requireAuth/);
  assert.match(parties, /partiesRouter\.delete\("\/link\/:linkId", requireAuth/);
  assert.match(parties, /partiesRouter\.get\("\/by-property\/:propertyId", requireAuth/);
  assert.match(parties, /PROPERTY_PARTY_LINK_EXISTS/);
  const keys = [...(/export const ENTITLEMENT_KEYS = \[([\s\S]*?)\] as const/.exec(billing)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.includes(GROW_RELATIONSHIPS_MANAGE));
  assert.ok(keys.includes(GROW_PROPERTIES_LINK));
  const serverRoles = [...(/export const PROPERTY_PARTY_ROLES = \[([\s\S]*?)\] as const/.exec(schema)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const serverHasExpanded = ROLES_APPROVED_PENDING.every((r) => serverRoles.includes(r));
  // One direction only: the phone may be more cautious than the server, never less. A server that already accepts Owner, Landlord and Tenant
  // is fine with the phone not offering them yet; a phone that offers them while the server refuses them is a bug.
  if (MOBILE_LINK_CONTRACT.expandedRolesAccepted) assert.ok(serverHasExpanded, "the phone offers Owner, Landlord and Tenant, so the server's role list must contain them");
  assert.deepEqual(serverRoles.filter((r) => (ROLES_ACCEPTED_NOW as readonly string[]).includes(r)), [...ROLES_ACCEPTED_NOW]);
});

test("drift: no control can be switched on before the server routes, permissions and role validation exist", () => {
  const parties = read("../../../../api/src/routes/parties.ts");
  const anyOn = Object.values(MOBILE_LINKING).some(Boolean);
  const hasPatch = /partiesRouter\.patch\("\/link\/:linkId"/.test(parties);
  const hasByContact = /partiesRouter\.get\("\/by-contact\/:partyId"/.test(parties);
  const hasEntitlement = /requireEntitlement\(/.test(parties);
  if (anyOn) {
    assert.ok(hasPatch, "PATCH /parties/link/:linkId must exist");
    assert.ok(hasByContact, "GET /parties/by-contact/:partyId must exist");
    assert.ok(hasEntitlement, "the /parties routes must check an entitlement (today any signed-in brokerage user can use them)");
  }
  // With every flag off there is nothing to assert about the server: it may already support all of it. The flags move only in a reviewed change.
});
