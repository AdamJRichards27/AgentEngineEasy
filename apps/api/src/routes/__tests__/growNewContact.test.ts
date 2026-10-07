// G-UAT-2 — POST /grow/contacts creates a property-less party in the caller's
// brokerage. Real HTTP, same session and entitlement conventions as contacts.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, isNull } from "drizzle-orm";
import { db, entitlementGrants, growActivities, growRelationships, parties, propertyParties } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
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

  A = await createBrokerageWithUsers(baseUrl, `New Contact A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `New Contact B ${suffix}`);
  C = await createBrokerageWithUsers(baseUrl, `New Contact C ${suffix}`);
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

async function postContact(cookie: string | undefined, body: unknown) {
  return fetch(contactsUrl("/"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

interface CreatedContact {
  id: number;
  displayName: string;
  partyType: string;
  email: string | null;
  mobile: string | null;
  roles: string[];
  relatedPropertyCount: number;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  organisationName: string | null;
  residentialAddress: string | null;
  createdAt: string;
  updatedAt: string;
}

test("POST /grow/contacts requires authentication", async () => {
  const res = await postContact(undefined, { name: "No Session" });
  assert.equal(res.status, 401);
});

test("POST /grow/contacts is 403 without grow.contacts.manage, including when only grow.contacts.read is granted", async () => {
  const denied = await postContact(C.agent.cookie, { name: "No Entitlement", email: `none-${suffix}@example.com` });
  assert.equal(denied.status, 403);
  const deniedBody = (await denied.json()) as { reason: string; entitlementKey: string };
  assert.equal(deniedBody.reason, "ENTITLEMENT_MISSING");
  assert.equal(deniedBody.entitlementKey, "grow.contacts.manage");

  await grant(C.brokerageId, "grow.contacts.read");
  const readOnly = await postContact(C.agent.cookie, { name: "Read Only", email: `readonly-${suffix}@example.com` });
  assert.equal(readOnly.status, 403);
  const readOnlyBody = (await readOnly.json()) as { reason: string; entitlementKey: string };
  assert.equal(readOnlyBody.reason, "ENTITLEMENT_MISSING");
  assert.equal(readOnlyBody.entitlementKey, "grow.contacts.manage");

  const rows = await db.select({ id: parties.id }).from(parties).where(eq(parties.brokerageId, C.brokerageId));
  assert.equal(rows.length, 0, "a refused create must not insert a party");
});

test("POST /grow/contacts returns 400 when no identifying field is given", async () => {
  const ghosts = () =>
    db
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(
          eq(parties.brokerageId, A.brokerageId),
          isNull(parties.firstName),
          isNull(parties.lastName),
          isNull(parties.organisationName),
          isNull(parties.email),
          isNull(parties.mobile),
        ),
      );
  const beforeCount = await ghosts();
  for (const body of [{}, { name: "   ", email: "  ", phone: "" }, { middleName: "Only" }, { brokerageId: B.brokerageId }]) {
    const res = await postContact(A.agent.cookie, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const payload = (await res.json()) as { code?: string; error: string };
    assert.equal(payload.code, "CONTACT_UNIDENTIFIABLE");
    assert.match(payload.error, /name, email, or phone/);
  }
  const afterCount = await ghosts();
  assert.equal(afterCount.length, beforeCount.length);
});

test("POST /grow/contacts creates a property-less party in the caller's brokerage and search returns it", async () => {
  const email = `Ada.Lovelace.${suffix}@Example.com`;
  const res = await postContact(A.agent.cookie, {
    name: "Ada Lovelace",
    email: `  ${email}  `,
    phone: "0400111222",
    brokerageId: B.brokerageId,
    propertyId: 999,
  });
  const body = (await res.json()) as { contact: CreatedContact };
  assert.equal(res.status, 201, JSON.stringify(body));
  const contact = body.contact;
  assert.equal(contact.displayName, "Ada Lovelace");
  assert.equal(contact.partyType, "Person");
  assert.equal(contact.firstName, "Ada");
  assert.equal(contact.lastName, "Lovelace");
  assert.equal(contact.organisationName, null);
  assert.equal(contact.email, email);
  assert.equal(contact.mobile, "0400111222");
  assert.deepEqual(contact.roles, []);
  assert.equal(contact.relatedPropertyCount, 0);
  assert.equal(typeof contact.createdAt, "string");
  assert.equal(typeof contact.updatedAt, "string");

  const [row] = await db.select().from(parties).where(eq(parties.id, contact.id));
  assert.ok(row);
  assert.equal(row.brokerageId, A.brokerageId, "the session brokerage is used, never the body's brokerageId");
  assert.equal(row.email, email);

  const links = await db.select({ id: propertyParties.id }).from(propertyParties).where(eq(propertyParties.partyId, contact.id));
  assert.equal(links.length, 0, "a new contact is not linked to a property");
  const relationships = await db.select({ id: growRelationships.id }).from(growRelationships).where(eq(growRelationships.partyId, contact.id));
  assert.equal(relationships.length, 0);
  const activities = await db.select({ id: growActivities.id }).from(growActivities).where(eq(growActivities.partyId, contact.id));
  assert.equal(activities.length, 0, "contact creation does not write a grow_activities row");

  const detail = await fetch(contactsUrl(`/${contact.id}`), { headers: { cookie: A.agent.cookie } });
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as { contact: { id: number; email: string; displayName: string }; roles: string[]; properties: unknown[] };
  assert.equal(detailBody.contact.id, contact.id);
  assert.equal(detailBody.contact.displayName, "Ada Lovelace");
  assert.equal(detailBody.contact.email, email);
  assert.deepEqual(detailBody.roles, []);
  assert.deepEqual(detailBody.properties, []);

  const list = await fetch(contactsUrl("/"), { headers: { cookie: A.agent.cookie } });
  const listBody = (await list.json()) as { contacts: Array<{ id: number; displayName: string; email: string | null; roles: string[]; relatedPropertyCount: number }> };
  const listed = listBody.contacts.find((item) => item.id === contact.id);
  assert.ok(listed, "the new contact is in contact search");
  assert.equal(listed.displayName, contact.displayName);
  assert.equal(listed.email, contact.email);
  assert.deepEqual(listed.roles, []);
  assert.equal(listed.relatedPropertyCount, 0);

  const search = await fetch(contactsUrl("/?search=Lovelace"), { headers: { cookie: A.agent.cookie } });
  const searchBody = (await search.json()) as { contacts: Array<{ id: number }> };
  assert.ok(searchBody.contacts.some((item) => item.id === contact.id));
});

test("POST /grow/contacts returns 409 when the email already exists, ignoring case and surrounding whitespace", async () => {
  const email = `Dup.${suffix}@Example.com`;
  const created = await postContact(A.agent.cookie, { name: "Existing Person", email, phone: "0499888777" });
  assert.equal(created.status, 201, await created.clone().text());
  const createdBody = (await created.json()) as { contact: { id: number } };

  const again = await postContact(A.agent.cookie, { name: "Someone Else", email: `  ${email.toUpperCase()}  `, phone: "0499888777" });
  assert.equal(again.status, 409);
  const againBody = (await again.json()) as { error: string; contactId: number };
  assert.match(againBody.error, /already exists/);
  assert.equal(againBody.contactId, createdBody.contact.id);

  const [padded] = await db
    .insert(parties)
    .values({
      brokerageId: A.brokerageId,
      partyType: "Person",
      firstName: "Padded",
      email: `  padded.${suffix}@Example.com  `,
    })
    .returning({ id: parties.id });
  const paddedDup = await postContact(A.agent.cookie, { email: `PADDED.${suffix}@example.com` });
  assert.equal(paddedDup.status, 409);
  const paddedBody = (await paddedDup.json()) as { contactId: number };
  assert.equal(paddedBody.contactId, padded.id);

  const phoneOnly = await postContact(A.agent.cookie, { name: "Same Phone", phone: "0499888777", email: `other-phone-${suffix}@example.com` });
  assert.equal(phoneOnly.status, 409, "the same phone is a duplicate even when the email is different");
  const phoneBody = (await phoneOnly.json()) as { error: string; contactId: number };
  assert.match(phoneBody.error, /phone number already exists/);
  assert.equal(phoneBody.contactId, createdBody.contact.id);

  const otherBrokerage = await postContact(B.agent.cookie, { name: "Other Brokerage", email });
  assert.equal(otherBrokerage.status, 201, "the same email in another brokerage is not a duplicate");
  const otherBody = (await otherBrokerage.json()) as { contact: { id: number } };
  const [otherRow] = await db.select().from(parties).where(eq(parties.id, otherBody.contact.id));
  assert.equal(otherRow.brokerageId, B.brokerageId);
});

test("POST /grow/contacts returns 409 when the phone matches, including Australian formats import already stores", async () => {
  const digits = suffix.replace(/\D/g, "").slice(-6).padStart(6, "0");
  const local = `0400${digits}`;
  const spaced = `0400 ${digits.slice(0, 3)} ${digits.slice(3)}`;
  const international = `+61400${digits}`;

  const [stored] = await db
    .insert(parties)
    .values({
      brokerageId: A.brokerageId,
      partyType: "Person",
      firstName: "Ivy",
      lastName: "Imported",
      mobile: international,
      email: `ivy-imported-${suffix}@example.test`,
    })
    .returning({ id: parties.id });

  for (const phone of [spaced, local, `  ${international}  `, `(0400) ${digits.slice(0, 3)} ${digits.slice(3)}`]) {
    const again = await postContact(A.agent.cookie, {
      name: "Dee Again",
      phone,
      email: `dee-${phone.replace(/\D/g, "")}-${suffix}@example.test`,
    });
    assert.equal(again.status, 409, phone);
    const body = (await again.json()) as { error: string; contactId: number };
    assert.match(body.error, /phone number already exists/);
    assert.equal(body.contactId, stored.id, "the oldest contact with that number is the one named");
  }

  const different = await postContact(A.agent.cookie, {
    name: "Different Number",
    phone: `0401${digits}`,
    email: `different-${suffix}@example.test`,
  });
  assert.equal(different.status, 201, "a different number is not a duplicate");

  const nameless = await postContact(A.agent.cookie, { name: "No Phone One" });
  const namelessAgain = await postContact(A.agent.cookie, { name: "No Phone Two" });
  assert.equal(nameless.status, 201);
  assert.equal(namelessAgain.status, 201, "two contacts with no phone are not duplicates of each other");

  const otherBrokerage = await postContact(B.agent.cookie, { name: "Other Office Dee", phone: spaced });
  assert.equal(otherBrokerage.status, 201, "the same phone in another brokerage is not a duplicate");
});

test("GET /grow/contacts finds a contact by full name without losing partial or single-name search", async () => {
  const created = await postContact(A.agent.cookie, {
    firstName: "UAT1-Sam",
    lastName: "Seller",
    email: `UAT1-Sam.${suffix}@Example.test`,
    phone: `0412${suffix.replace(/\D/g, "").slice(-6).padStart(6, "0")}`,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const body = (await created.json()) as { contact: { id: number } };

  const organisation = await postContact(A.agent.cookie, {
    partyType: "Organisation",
    organisationName: "UAT1 Harbour Realty",
    email: `harbour-${suffix}@example.test`,
  });
  assert.equal(organisation.status, 201, await organisation.clone().text());
  const organisationBody = (await organisation.json()) as { contact: { id: number } };

  async function idsFor(search: string) {
    const res = await fetch(contactsUrl(`/?search=${encodeURIComponent(search)}`), { headers: { cookie: A.agent.cookie } });
    assert.equal(res.status, 200, search);
    const payload = (await res.json()) as { contacts: Array<{ id: number }> };
    return payload.contacts.map((contact) => contact.id);
  }

  for (const search of ["UAT1-Sam Seller", "uat1-sam seller", "UAT1-Sam  Seller", "Sam Seller"]) {
    const ids = await idsFor(search);
    assert.ok(ids.includes(body.contact.id), `full-name search ${JSON.stringify(search)} should find the contact`);
  }

  assert.ok((await idsFor("UAT1-Sam")).includes(body.contact.id), "the first name on its own still matches");
  assert.ok((await idsFor("Seller")).includes(body.contact.id), "the last name on its own still matches");
  assert.ok((await idsFor("seller")).includes(body.contact.id), "a single name is case-insensitive");
  assert.ok((await idsFor(`uat1-sam.${suffix}`)).includes(body.contact.id), "part of the email still matches");
  assert.ok(!(await idsFor("UAT1-Nobody")).includes(body.contact.id));

  assert.ok((await idsFor("UAT1 Harbour Realty")).includes(organisationBody.contact.id), "an organisation name still matches");
  assert.ok((await idsFor("Harbour")).includes(organisationBody.contact.id));

  const foreign = await fetch(contactsUrl(`/?search=${encodeURIComponent("UAT1-Sam Seller")}`), { headers: { cookie: B.agent.cookie } });
  const foreignBody = (await foreign.json()) as { contacts: Array<{ id: number }> };
  assert.equal(foreign.status, 200);
  assert.ok(!foreignBody.contacts.some((contact) => contact.id === body.contact.id));
});

test("a caller cannot create a contact into another brokerage or read that contact back", async () => {
  const email = `isolated-${suffix}@example.com`;
  const created = await postContact(A.agent.cookie, {
    name: "Isolated Contact",
    email,
    brokerageId: B.brokerageId,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const body = (await created.json()) as { contact: { id: number } };
  const [row] = await db.select().from(parties).where(eq(parties.id, body.contact.id));
  assert.equal(row.brokerageId, A.brokerageId);

  const foreignRead = await fetch(contactsUrl(`/${body.contact.id}`), { headers: { cookie: B.agent.cookie } });
  assert.equal(foreignRead.status, 404);

  const foreignList = await fetch(contactsUrl("/?search=Isolated"), { headers: { cookie: B.agent.cookie } });
  const foreignListBody = (await foreignList.json()) as { contacts: Array<{ id: number }> };
  assert.equal(foreignList.status, 200);
  assert.ok(!foreignListBody.contacts.some((item) => item.id === body.contact.id));

  const ownList = await fetch(contactsUrl("/?search=Isolated"), { headers: { cookie: A.agent.cookie } });
  const ownListBody = (await ownList.json()) as { contacts: Array<{ id: number }> };
  assert.ok(ownListBody.contacts.some((item) => item.id === body.contact.id));

  const ownRead = await fetch(contactsUrl(`/${body.contact.id}`), { headers: { cookie: A.agent.cookie } });
  assert.equal(ownRead.status, 200);
});
