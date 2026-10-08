// GP-2 — PATCH /grow/contacts/:partyId corrects name, organisation, email,
// mobile, and address on columns that already exist. Same entitlement as
// creation (grow.contacts.manage). Duplicate checks reuse the FU-2 rules.
// Legacy consent stays keyed by destination, so a new email or phone is not
// consented, and F2 consent/DNC rows are not rewritten.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  communicationConsent,
  db,
  entitlementGrants,
  growActivities,
  growContactChannelConsents,
  growContactDncrStatuses,
  parties,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { checkConsent } from "../../lib/communications/consent.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const digits = suffix.replace(/\D/g, "").slice(-6).padStart(6, "0");
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let C: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `Edit Contact A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Edit Contact B ${suffix}`);
  C = await createBrokerageWithUsers(baseUrl, `Edit Contact C ${suffix}`);
  await grant(A.brokerageId, "grow.contacts.read");
  await grant(A.brokerageId, "grow.contacts.manage");
  await grant(B.brokerageId, "grow.contacts.read");
  await grant(B.brokerageId, "grow.contacts.manage");
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId, C?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function grant(brokerageId: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
}

function contactsUrl(path: string) {
  return `${baseUrl}/api/grow/contacts${path}`;
}

async function postContact(cookie: string, body: unknown) {
  return fetch(contactsUrl("/"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function patchContact(cookie: string | undefined, partyId: string | number, body: unknown) {
  return fetch(contactsUrl(`/${partyId}`), {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function phone(tag: string) {
  return `04${tag}${digits}`;
}

async function createParty(cookie: string, body: Record<string, unknown>) {
  const res = await postContact(cookie, body);
  const payload = (await res.json()) as { contact: { id: number; updatedAt: string; email: string | null; mobile: string | null } };
  assert.equal(res.status, 201, JSON.stringify(payload));
  return payload.contact;
}

function freeze(rows: unknown[]): string {
  return JSON.stringify(rows, (_key, value) => (value instanceof Date ? value.toISOString() : value));
}

test("PATCH /grow/contacts/:partyId requires authentication", async () => {
  const res = await patchContact(undefined, 1, { firstName: "No" });
  assert.equal(res.status, 401);
});

test("PATCH /grow/contacts/:partyId is 403 without grow.contacts.manage, including when only grow.contacts.read is granted", async () => {
  const [contact] = await db
    .insert(parties)
    .values({
      brokerageId: C.brokerageId,
      partyType: "Person",
      firstName: "Unread",
      email: `unread-${suffix}@example.com`,
    })
    .returning({ id: parties.id });

  const noGrant = await patchContact(C.agent.cookie, contact.id, { firstName: "Changed" });
  assert.equal(noGrant.status, 403);
  const noGrantBody = (await noGrant.json()) as { reason: string; entitlementKey: string };
  assert.equal(noGrantBody.reason, "ENTITLEMENT_MISSING");
  assert.equal(noGrantBody.entitlementKey, "grow.contacts.manage");

  await grant(C.brokerageId, "grow.contacts.read");
  const readOnly = await patchContact(C.agent.cookie, contact.id, { firstName: "Changed" });
  assert.equal(readOnly.status, 403);
  const readOnlyBody = (await readOnly.json()) as { reason: string; entitlementKey: string };
  assert.equal(readOnlyBody.reason, "ENTITLEMENT_MISSING");
  assert.equal(readOnlyBody.entitlementKey, "grow.contacts.manage");

  const [still] = await db.select({ firstName: parties.firstName }).from(parties).where(eq(parties.id, contact.id));
  assert.equal(still.firstName, "Unread");
});

test("PATCH /grow/contacts/:partyId returns 400 for an invalid id or a contact that fails creation's checks, and does not write", async () => {
  for (const id of ["nope", "0", "2147483648", "-3"]) {
    const res = await patchContact(A.agent.cookie, id, { firstName: "Bad" });
    assert.equal(res.status, 400, id);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Invalid contact id/);
  }

  const created = await createParty(A.agent.cookie, {
    firstName: "Valid",
    lastName: "Person",
    email: `valid-${suffix}@example.com`,
    phone: phone("12"),
  });
  const [before] = await db.select().from(parties).where(eq(parties.id, created.id));

  const unidentifiable = await patchContact(A.agent.cookie, created.id, {
    firstName: null,
    lastName: "  ",
    organisationName: "",
    email: null,
    mobile: "",
    residentialAddress: "12 Kept Street",
    middleName: "Only",
  });
  assert.equal(unidentifiable.status, 400);
  const unidentifiableBody = (await unidentifiable.json()) as { error: string; code?: string };
  assert.equal(unidentifiableBody.code, "CONTACT_UNIDENTIFIABLE");
  assert.match(unidentifiableBody.error, /name, email, or phone/);

  const notText = await patchContact(A.agent.cookie, created.id, { email: 12 });
  assert.equal(notText.status, 400);
  const notTextBody = (await notText.json()) as { error: string };
  assert.match(notTextBody.error, /must be text/);

  const tooLong = await patchContact(A.agent.cookie, created.id, { residentialAddress: "x".repeat(2001) });
  assert.equal(tooLong.status, 400);
  const tooLongBody = (await tooLong.json()) as { error: string };
  assert.match(tooLongBody.error, /2000 characters or fewer/);

  const notObject = await patchContact(A.agent.cookie, created.id, ["firstName"]);
  assert.equal(notObject.status, 400);

  const [after] = await db.select().from(parties).where(eq(parties.id, created.id));
  assert.equal(after.firstName, before.firstName);
  assert.equal(after.lastName, before.lastName);
  assert.equal(after.email, before.email);
  assert.equal(after.mobile, before.mobile);
  assert.equal(after.residentialAddress, before.residentialAddress);
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
});

test("PATCH /grow/contacts/:partyId updates each stored field group and leaves other columns alone", async () => {
  const created = await createParty(A.agent.cookie, {
    firstName: "Ada",
    lastName: "Lovelace",
    email: `Ada.Fields.${suffix}@Example.com`,
    phone: phone("13"),
  });

  const names = await patchContact(A.agent.cookie, created.id, {
    firstName: "  Augusta  ",
    middleName: "Ada",
    lastName: "King",
    brokerageId: B.brokerageId,
    partyType: "Trust",
  });
  assert.equal(names.status, 200, await names.clone().text());
  const namesBody = (await names.json()) as {
    contact: {
      firstName: string;
      middleName: string;
      lastName: string;
      displayName: string;
      partyType: string;
      email: string;
      mobile: string;
    };
  };
  assert.equal(namesBody.contact.firstName, "Augusta");
  assert.equal(namesBody.contact.middleName, "Ada");
  assert.equal(namesBody.contact.lastName, "King");
  assert.equal(namesBody.contact.displayName, "Augusta King");
  assert.equal(namesBody.contact.partyType, "Person", "partyType is not an editable column on this route");
  assert.equal(namesBody.contact.email, `Ada.Fields.${suffix}@Example.com`);
  assert.equal(namesBody.contact.mobile, phone("13"));

  const byName = await patchContact(A.agent.cookie, created.id, { name: "Grace Hopper" });
  assert.equal(byName.status, 200);
  const byNameBody = (await byName.json()) as { contact: { firstName: string; lastName: string; middleName: string | null } };
  assert.equal(byNameBody.contact.firstName, "Grace");
  assert.equal(byNameBody.contact.lastName, "Hopper");
  assert.equal(byNameBody.contact.middleName, "Ada", "a combined name does not clear an unmentioned middle name");

  const organisation = await patchContact(A.agent.cookie, created.id, { organisationName: "  Analytical Engines  " });
  assert.equal(organisation.status, 200);
  const organisationBody = (await organisation.json()) as { contact: { organisationName: string; displayName: string; firstName: string } };
  assert.equal(organisationBody.contact.organisationName, "Analytical Engines");
  assert.equal(organisationBody.contact.displayName, "Analytical Engines");
  assert.equal(organisationBody.contact.firstName, "Grace");

  const email = await patchContact(A.agent.cookie, created.id, { email: `  Grace.Hopper.${suffix}@Example.com  ` });
  assert.equal(email.status, 200);
  const emailBody = (await email.json()) as { contact: { email: string } };
  assert.equal(emailBody.contact.email, `Grace.Hopper.${suffix}@Example.com`, "email is stored trimmed, with the caller's casing, as creation does");

  const spacedPhone = `0498 ${digits.slice(0, 3)} ${digits.slice(3)}`;
  const viaPhone = await patchContact(A.agent.cookie, created.id, { phone: `  ${spacedPhone}  ` });
  assert.equal(viaPhone.status, 200);
  const viaPhoneBody = (await viaPhone.json()) as { contact: { mobile: string } };
  assert.equal(viaPhoneBody.contact.mobile, spacedPhone, "phone is the creation alias for mobile and is stored as typed");

  const mobileWins = await patchContact(A.agent.cookie, created.id, { mobile: phone("14"), phone: phone("15") });
  assert.equal(mobileWins.status, 200);
  const mobileWinsBody = (await mobileWins.json()) as { contact: { mobile: string } };
  assert.equal(mobileWinsBody.contact.mobile, phone("14"), "when both are sent, mobile wins, matching creation");

  const address = await patchContact(A.agent.cookie, created.id, { residentialAddress: "  12 Analytical Street  " });
  assert.equal(address.status, 200);
  const addressBody = (await address.json()) as { contact: { residentialAddress: string } };
  assert.equal(addressBody.contact.residentialAddress, "12 Analytical Street");

  const [row] = await db.select().from(parties).where(eq(parties.id, created.id));
  assert.equal(row.brokerageId, A.brokerageId);
  assert.equal(row.partyType, "Person");
  assert.equal(row.firstName, "Grace");
  assert.equal(row.residentialAddress, "12 Analytical Street");

  const detail = await fetch(contactsUrl(`/${created.id}`), { headers: { cookie: A.agent.cookie } });
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as { contact: { displayName: string; email: string; residentialAddress: string } };
  assert.equal(detailBody.contact.displayName, "Analytical Engines");
  assert.equal(detailBody.contact.email, `Grace.Hopper.${suffix}@Example.com`);
  assert.equal(detailBody.contact.residentialAddress, "12 Analytical Street");

  const search = await fetch(contactsUrl(`/?search=${encodeURIComponent("Grace Hopper")}`), { headers: { cookie: A.agent.cookie } });
  const searchBody = (await search.json()) as { contacts: Array<{ id: number }> };
  assert.ok(searchBody.contacts.some((item) => item.id === created.id));

  const activities = await db.select({ id: growActivities.id }).from(growActivities).where(eq(growActivities.partyId, created.id));
  assert.equal(activities.length, 0, "editing a contact does not write a grow_activities row");
});

test("PATCH /grow/contacts/:partyId returns 409 when a changed email matches another visible contact, and not when it matches itself or another brokerage", async () => {
  const email = `Dup.Edit.${suffix}@Example.com`;
  const [older] = await db
    .insert(parties)
    .values({
      brokerageId: A.brokerageId,
      partyType: "Person",
      firstName: "OlderHidden",
      lastName: `Token${suffix}`,
      email: `  ${email.toUpperCase()}  `,
      mobile: phone("17"),
    })
    .returning({ id: parties.id });
  const [newer] = await db
    .insert(parties)
    .values({
      brokerageId: A.brokerageId,
      partyType: "Person",
      firstName: "NewerHidden",
      email,
      mobile: phone("27"),
    })
    .returning({ id: parties.id });
  assert.ok(older.id < newer.id);

  const editor = await createParty(A.agent.cookie, {
    name: "Editor Person",
    email: `editor-${suffix}@example.com`,
    phone: phone("18"),
  });
  const conflict = await patchContact(A.agent.cookie, editor.id, { email: `  ${email.toUpperCase()}  ` });
  assert.equal(conflict.status, 409);
  const conflictBody = (await conflict.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(conflictBody).sort(), ["contactId", "error"]);
  assert.match(String(conflictBody.error), /email already exists/);
  assert.equal(conflictBody.contactId, older.id, "the oldest contact with that email is the one named");
  const serialised = JSON.stringify(conflictBody);
  assert.equal(serialised.includes("OlderHidden"), false);
  assert.equal(serialised.includes("NewerHidden"), false);
  assert.equal(serialised.includes(`Token${suffix}`), false);
  assert.equal(serialised.includes(email), false);
  assert.equal(serialised.includes(phone("17")), false);

  const [unchanged] = await db.select({ email: parties.email }).from(parties).where(eq(parties.id, editor.id));
  assert.equal(unchanged.email, `editor-${suffix}@example.com`, "a conflict does not write");

  const self = await createParty(A.agent.cookie, {
    name: "Self Case",
    email: `Self.Case.${suffix}@Example.com`,
    phone: phone("28"),
  });
  const sameContact = await patchContact(A.agent.cookie, self.id, { email: `self.case.${suffix}@example.com` });
  assert.equal(sameContact.status, 200, "a case-only change of this contact's own email is not a duplicate of itself");

  const otherBrokerage = await createParty(B.agent.cookie, { name: "Other Office", email: `other-edit-${suffix}@example.com` });
  const cross = await patchContact(B.agent.cookie, otherBrokerage.id, { email });
  assert.equal(cross.status, 200, "the same email in another brokerage is not a duplicate");
  const crossBody = (await cross.json()) as { contact: { id: number }; contactId?: number };
  assert.equal(crossBody.contact.id, otherBrokerage.id);
  assert.equal(crossBody.contactId, undefined);
  assert.notEqual(crossBody.contact.id, older.id);
  assert.notEqual(crossBody.contact.id, newer.id);
});

test("PATCH /grow/contacts/:partyId returns 409 when a changed phone matches another contact, including Australian formats", async () => {
  const storedPhone = `+61421${digits}`;
  const local = `0421${digits}`;
  const spaced = `0421 ${digits.slice(0, 3)} ${digits.slice(3)}`;
  const existing = await createParty(A.agent.cookie, {
    name: "Phone Owner",
    email: `phone-owner-${suffix}@example.com`,
    phone: storedPhone,
  });
  const editor = await createParty(A.agent.cookie, {
    name: "Phone Editor",
    email: `phone-editor-${suffix}@example.com`,
    phone: phone("19"),
  });

  const conflict = await patchContact(A.agent.cookie, editor.id, { phone: spaced });
  assert.equal(conflict.status, 409);
  const conflictBody = (await conflict.json()) as { error: string; contactId: number };
  assert.match(conflictBody.error, /phone number already exists/);
  assert.equal(conflictBody.contactId, existing.id);
  assert.equal(JSON.stringify(conflictBody).includes(storedPhone), false);

  const reformatted = await patchContact(A.agent.cookie, existing.id, { mobile: local });
  assert.equal(reformatted.status, 200, "reformatting this contact's own number is not a duplicate of itself");
  const reformattedBody = (await reformatted.json()) as { contact: { mobile: string } };
  assert.equal(reformattedBody.contact.mobile, local, "the phone is stored as typed, not rewritten to E.164");

  const different = await patchContact(A.agent.cookie, editor.id, { phone: phone("20"), email: `phone-editor-new-${suffix}@example.com` });
  assert.equal(different.status, 200, "a different number is not a duplicate");

  const otherBrokerage = await createParty(B.agent.cookie, { name: "Other Phone", email: `other-phone-${suffix}@example.com` });
  const cross = await patchContact(B.agent.cookie, otherBrokerage.id, { phone: spaced });
  assert.equal(cross.status, 200, "the same phone in another brokerage is not a duplicate");
});

test("PATCH /grow/contacts/:partyId no-op does not bump updatedAt or write an audit row", async () => {
  const created = await createParty(A.agent.cookie, {
    firstName: "Still",
    lastName: "Same",
    email: `still-${suffix}@example.com`,
    phone: phone("31"),
  });
  const [before] = await db.select().from(parties).where(eq(parties.id, created.id));
  const auditsBefore = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.brokerageId, A.brokerageId), eq(auditLogs.recordId, String(created.id)), eq(auditLogs.action, "grow_contact_updated")));

  const empty = await patchContact(A.agent.cookie, created.id, {});
  assert.equal(empty.status, 200);
  const emptyBody = (await empty.json()) as { contact: { updatedAt: string; firstName: string } };
  assert.equal(emptyBody.contact.firstName, "Still");
  assert.equal(emptyBody.contact.updatedAt, before.updatedAt.toISOString());

  const same = await patchContact(A.agent.cookie, created.id, {
    firstName: "  Still  ",
    lastName: "Same",
    email: `still-${suffix}@example.com`,
    mobile: phone("31"),
    residentialAddress: null,
  });
  assert.equal(same.status, 200);

  const [after] = await db.select().from(parties).where(eq(parties.id, created.id));
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
  assert.equal(after.firstName, "Still");
  const auditsAfter = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.brokerageId, A.brokerageId), eq(auditLogs.recordId, String(created.id)), eq(auditLogs.action, "grow_contact_updated")));
  assert.equal(auditsAfter.length, auditsBefore.length);
});

test("PATCH /grow/contacts/:partyId is 404 for another brokerage and does not change that contact", async () => {
  const email = `isolated-edit-${suffix}@example.com`;
  const created = await createParty(A.agent.cookie, { name: "Isolated Edit", email, phone: phone("22") });
  const [before] = await db.select().from(parties).where(eq(parties.id, created.id));

  const missing = await patchContact(A.agent.cookie, 2_000_000_000, { firstName: "Nobody" });
  assert.equal(missing.status, 404);

  const foreign = await patchContact(B.agent.cookie, created.id, {
    firstName: "Stolen",
    email: `stolen-${suffix}@example.com`,
    brokerageId: B.brokerageId,
  });
  assert.equal(foreign.status, 404);
  const foreignText = await foreign.text();
  assert.match(foreignText, /not found/i);
  assert.equal(foreignText.includes(email), false);
  assert.equal(foreignText.includes("Isolated"), false);
  assert.equal(foreignText.includes(phone("22")), false);

  const [after] = await db.select().from(parties).where(eq(parties.id, created.id));
  assert.equal(after.brokerageId, A.brokerageId);
  assert.equal(after.firstName, before.firstName);
  assert.equal(after.email, before.email);
  assert.equal(after.mobile, before.mobile);
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
});

test("PATCH /grow/contacts/:partyId audits changed field names and not the values", async () => {
  const oldEmail = `audit-old-${suffix}@example.com`;
  const newEmail = `audit-new-${suffix}@example.com`;
  const oldPhone = phone("23");
  const newPhone = phone("24");
  const created = await createParty(A.agent.cookie, {
    firstName: "AuditFirst",
    lastName: `AuditLast${suffix}`,
    email: oldEmail,
    phone: oldPhone,
  });
  const res = await patchContact(A.agent.cookie, created.id, {
    firstName: `SecretFirst${suffix}`,
    email: newEmail,
    mobile: newPhone,
    residentialAddress: `Secret Address ${suffix}`,
  });
  assert.equal(res.status, 200, await res.clone().text());

  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.brokerageId, A.brokerageId), eq(auditLogs.recordId, String(created.id)), eq(auditLogs.action, "grow_contact_updated")));
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.recordType, "party");
  assert.equal(row.previousValue, null);
  assert.deepEqual(JSON.parse(row.updatedValue ?? "null"), {
    fields: ["firstName", "email", "mobile", "residentialAddress"],
  });
  const serialised = JSON.stringify(row);
  for (const secret of [`SecretFirst${suffix}`, `AuditLast${suffix}`, oldEmail, newEmail, oldPhone, newPhone, `Secret Address ${suffix}`, "AuditFirst"]) {
    assert.equal(serialised.includes(secret), false, `audit row leaked ${secret}`);
  }
});

test("a changed email or phone is not consented, and F2 consent and DNC rows are untouched", async () => {
  const oldEmail = `Consent.Old.${suffix}@Example.com`;
  const newEmail = `consent-new-${suffix}@example.com`;
  const oldPhone = phone("25");
  const newPhone = phone("26");
  const created = await createParty(A.agent.cookie, {
    name: "Consented Person",
    email: oldEmail,
    phone: oldPhone,
  });

  await db.insert(communicationConsent).values([
    {
      brokerageId: A.brokerageId,
      partyId: created.id,
      destination: oldEmail.trim().toLowerCase(),
      channel: "EMAIL",
      marketingOptIn: true,
      source: "MANUAL",
      recordedByUserId: A.agent.user.id,
    },
    {
      brokerageId: A.brokerageId,
      partyId: created.id,
      destination: oldPhone,
      channel: "SMS",
      marketingOptIn: true,
      source: "MANUAL",
      recordedByUserId: A.agent.user.id,
    },
  ]);
  await db.insert(growContactChannelConsents).values({
    brokerageId: A.brokerageId,
    partyId: created.id,
    channel: "EMAIL",
    state: "EXPRESS",
    source: "MANUAL",
    captureMethod: "form",
    purpose: "EMAIL",
    scope: "OUTBOUND",
    recordedByUserId: A.agent.user.id,
  });
  await db.insert(growContactDncrStatuses).values({
    brokerageId: A.brokerageId,
    partyId: created.id,
    channel: "PHONE_CALL",
    status: "LISTED",
    source: "gp2-test",
    recordedByUserId: A.agent.user.id,
  });

  const consentBefore = await db.select().from(communicationConsent).where(eq(communicationConsent.partyId, created.id));
  const f2ConsentBefore = await db.select().from(growContactChannelConsents).where(eq(growContactChannelConsents.partyId, created.id));
  const dncBefore = await db.select().from(growContactDncrStatuses).where(eq(growContactDncrStatuses.partyId, created.id));
  assert.equal(consentBefore.length, 2);
  assert.equal(f2ConsentBefore.length, 1);
  assert.equal(dncBefore.length, 1);

  const emailBefore = await checkConsent(A.brokerageId, "EMAIL", oldEmail, "MARKETING");
  const smsBefore = await checkConsent(A.brokerageId, "SMS", oldPhone, "MARKETING");
  assert.equal(emailBefore.allowed, true);
  assert.equal(smsBefore.allowed, true);

  const res = await patchContact(A.agent.cookie, created.id, { email: newEmail, phone: newPhone });
  assert.equal(res.status, 200, await res.clone().text());

  const newEmailCheck = await checkConsent(A.brokerageId, "EMAIL", newEmail, "MARKETING");
  const newSmsCheck = await checkConsent(A.brokerageId, "SMS", newPhone, "MARKETING");
  assert.equal(newEmailCheck.allowed, false);
  assert.match(newEmailCheck.reason ?? "", /not opted in/);
  assert.equal(newEmailCheck.consent, null);
  assert.equal(newSmsCheck.allowed, false);
  assert.equal(newSmsCheck.consent, null);

  const oldEmailCheck = await checkConsent(A.brokerageId, "EMAIL", oldEmail, "MARKETING");
  const oldSmsCheck = await checkConsent(A.brokerageId, "SMS", oldPhone, "MARKETING");
  assert.equal(oldEmailCheck.allowed, true, "the previous destination keeps its own consent row");
  assert.equal(oldSmsCheck.allowed, true);

  const consentAfter = await db.select().from(communicationConsent).where(eq(communicationConsent.partyId, created.id));
  const f2ConsentAfter = await db.select().from(growContactChannelConsents).where(eq(growContactChannelConsents.partyId, created.id));
  const dncAfter = await db.select().from(growContactDncrStatuses).where(eq(growContactDncrStatuses.partyId, created.id));
  assert.equal(freeze(consentAfter), freeze(consentBefore));
  assert.equal(freeze(f2ConsentAfter), freeze(f2ConsentBefore));
  assert.equal(freeze(dncAfter), freeze(dncBefore));

  const copiedEmail = await db
    .select({ id: communicationConsent.id })
    .from(communicationConsent)
    .where(and(eq(communicationConsent.brokerageId, A.brokerageId), eq(communicationConsent.destination, newEmail)));
  const copiedPhone = await db
    .select({ id: communicationConsent.id })
    .from(communicationConsent)
    .where(and(eq(communicationConsent.brokerageId, A.brokerageId), eq(communicationConsent.destination, newPhone)));
  assert.equal(copiedEmail.length, 0);
  assert.equal(copiedPhone.length, 0);
});
