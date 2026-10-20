/**
 * PREVIEW-ONLY demo seed for the isolated Owner preview of AE Minimal A
 * (branch preview/minimal-a-20261021). Synthetic data only.
 *
 * Guards (all must hold or it refuses):
 *   - AE_PREVIEW_DEMO_SEED=true
 *   - NODE_ENV is not "production"
 *   - the target database is EMPTY of users (never seeds into a real DB)
 *   - the database name contains "preview" OR AE_PREVIEW_ALLOW_ANY_DB_NAME=true
 *     (Replit's own Postgres is usually named "neondb"/"heliumdb"; the
 *     runbook sets that override only inside the NEW preview Repl).
 *
 * Passwords are generated here and written ONLY to the file named by
 * AE_PREVIEW_CREDENTIALS_FILE (mode 0600). They are never printed.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "@aee/db";
import { hashPassword } from "../lib/auth/password.js";
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from "../lib/auth/legalVersions.js";

function refuse(msg: string): never {
  console.error(`previewDemoSeed refusing: ${msg}`);
  process.exit(1);
}

const DAY = 86_400_000;
const at = (days: number, hour = 9) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour - 10, 0, 0, 0); // ~AEST wall clock
  return d;
};

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.execute(sql.raw(text.replace(/\$(\d+)/g, (_, i) => lit(params[Number(i) - 1]))));
  return r.rows as T[];
}
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
const one = async (text: string, params: unknown[] = []) => Number((await q<{ id: number }>(text, params))[0]!.id);

async function main() {
  if (process.env.AE_PREVIEW_DEMO_SEED !== "true") refuse("AE_PREVIEW_DEMO_SEED=true is required.");
  if (process.env.NODE_ENV === "production") refuse("NODE_ENV=production.");
  const credFile = process.env.AE_PREVIEW_CREDENTIALS_FILE;
  if (!credFile) refuse("AE_PREVIEW_CREDENTIALS_FILE is required.");
  const [{ name }] = await q<{ name: string }>("select current_database() as name");
  if (!/preview/i.test(name) && process.env.AE_PREVIEW_ALLOW_ANY_DB_NAME !== "true")
    refuse(`database "${name}" is not named *preview* (set AE_PREVIEW_ALLOW_ANY_DB_NAME=true only in the NEW preview Repl).`);
  const [{ n }] = await q<{ n: string }>("select count(*)::text as n from users");
  if (n !== "0") refuse(`database already has ${n} users; the seed only runs on an empty preview DB.`);

  const brokerageId = await one("insert into brokerages(name) values ('Harbourline Realty (DEMO)') returning id");
  const pw = () => randomBytes(12).toString("base64url") + "-Aa1";
  const people = [
    { email: "owner.preview@demo.invalid", first: "Olivia", last: "Preview", role: "Brokerage Administrator" },
    { email: "agent.preview@demo.invalid", first: "Sam", last: "Agent", role: "Agent" },
  ];
  const creds: string[] = [];
  const userIds: number[] = [];
  for (const p of people) {
    const password = pw();
    const id = await one(
      "insert into users(auth_provider_id,email,first_name,last_name,role,brokerage_id,is_active,password_hash,email_verified_at) values ($1,$2,$3,$4,$5,$6,true,$7,now()) returning id",
      [`preview-seed:${p.email}`, p.email, p.first, p.last, p.role, brokerageId, await hashPassword(password)],
    );
    for (const [t, v] of [["terms_of_use", CURRENT_TERMS_VERSION], ["privacy_policy", CURRENT_PRIVACY_VERSION]])
      await q("insert into consent_records(user_id,consent_type,document_version,accepted_at) values ($1,$2,$3,now())", [id, t, v]);
    userIds.push(id);
    creds.push(`${p.role}\t${p.email}\t${password}\tuser_id=${id}`);
  }
  const [adminId, agentId] = userIds as [number, number];
  // Grow surfaces only. Deliberately NOT granted: grow.calling.* (calling off),
  // grow.automation.use, grow.campaigns.use, grow.admin.configure.
  for (const key of ["run.access", "grow.access", "grow.contacts.read", "grow.contacts.manage", "grow.properties.link",
    "grow.relationships.manage", "grow.activities.manage", "grow.opportunities.manage", "grow.import.review",
    "grow.import.execute", "grow.ai.use", "grow.propertyIntelligence.read"])
    await q("insert into entitlement_grants(brokerage_id,entitlement_key,grantee_type,source_type,created_by) values ($1,$2,'brokerage','manual',$3)", [brokerageId, key, adminId]);

  // Synthetic Brisbane-area properties (addresses are fictional street numbers; manual, no Places id).
  const props = [
    ["14 Jacaranda Crescent, Paddington QLD 4064", "Paddington", "4064"],
    ["7 Banksia Lane, Bulimba QLD 4171", "Bulimba", "4171"],
    ["22/88 Riverview Terrace, Hamilton QLD 4007", "Hamilton", "4007"],
    ["3 Wattle Court, Ashgrove QLD 4060", "Ashgrove", "4060"],
    ["51 Fig Tree Road, Indooroopilly QLD 4068", "Indooroopilly", "4068"],
    ["9 Poinciana Street, New Farm QLD 4005", "New Farm", "4005"],
  ];
  const propIds: number[] = [];
  for (const [addr, suburb, pc] of props)
    propIds.push(await one("insert into properties(brokerage_id,agent_id,formatted_address,suburb,state,postcode,is_manual_address) values ($1,$2,$3,$4,'QLD',$5,true) returning id", [brokerageId, agentId, addr, suburb, pc]));

  const contacts = [
    ["Emma", "Whitfield", "0400 000 101"], ["Liam", "Okafor", "0400 000 102"], ["Charlotte", "Nguyen", "0400 000 103"],
    ["Noah", "Brennan", "0400 000 104"], ["Ava", "Castellano", "0400 000 105"], ["Oliver", "Haddad", "0400 000 106"],
    ["Mia", "Fitzgerald", "0400 000 107"], ["Jack", "Moreau", "0400 000 108"], ["Isla", "Sorensen", "0400 000 109"],
    ["Henry", "Takahashi", "0400 000 110"], ["Grace", "Delacroix", "0400 000 111"], ["Leo", "Abernathy", "0400 000 112"],
  ];
  const partyIds: number[] = [];
  for (const [f, l, m] of contacts)
    partyIds.push(await one("insert into parties(brokerage_id,party_type,first_name,last_name,mobile,email) values ($1,'Person',$2,$3,$4,$5) returning id",
      [brokerageId, f, l, m, `${f!.toLowerCase()}.${l!.toLowerCase()}@demo.invalid`]));

  // Relationships: owners (some long tenure), a landlord, a prospective buyer.
  const rel = (pi: number, pr: number, type: string, years: number | null) =>
    q("insert into grow_relationships(brokerage_id,party_id,property_id,relationship_type,is_primary,source_type,created_by,ownership_start_date,ownership_start_source,ownership_start_precision) values ($1,$2,$3,$4,true,'manual',$5,$6,$7,$8)",
      [brokerageId, partyIds[pi], propIds[pr], type, agentId, years ? at(-365 * years) : null, years ? "manual" : null, years ? "year" : null]);
  await rel(0, 0, "owner", 12); await rel(1, 1, "owner", 4); await rel(2, 2, "landlord", 7);
  await rel(3, 3, "owner", 15); await rel(4, 4, "co_owner", 9); await rel(5, 5, "owner", 2);

  // Opportunities: covers the Owner t388u rule — Lost/Converted never count as open.
  const opp = (pi: number, pr: number | null, type: string, status: string, stage: string, next: Date | null, reason: string, extra: Partial<{ lost: string }> = {}) =>
    one("insert into grow_opportunities(brokerage_id,party_id,property_id,opportunity_type,status,stage,owner_user_id,source,reason,recommended_next_action,next_action_due_at,last_meaningful_contact_at,expected_timeframe,lost_reason,closed_at) values ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,$10,$11,'3-6 months',$12,$13) returning id",
      [brokerageId, partyIds[pi], pr === null ? null : propIds[pr], type, status, stage, agentId, reason, next ? "Call to confirm appraisal time" : null, next, at(-10), extra.lost ?? null, status === "Open" ? null : at(-3)]);
  await opp(0, 0, "Appraisal", "Open", "Qualified", at(0, 10), "Considering selling after 12 years");
  await opp(1, 1, "Listing", "Open", "Contacted", at(-2, 11), "Upsizing; asked for a market update");
  await opp(2, 2, "PropertyManagement", "Open", "New", at(1, 14), "Unhappy with current manager");
  await opp(3, 3, "Appraisal", "Open", "AppraisalBooked", at(2, 9), "Downsizing next year");
  await opp(4, 4, "Listing", "Lost", "Lost", null, "Chose another agency", { lost: "Listed with competitor" });
  await opp(5, 5, "Appraisal", "Converted", "Converted", null, "Appraisal completed");
  await opp(0, null, "Other", "Open", "New", at(5, 9), "Referral: daughter looking to buy in Bulimba");

  // Commitments (Today): one overdue, two due today, upcoming, one completed.
  const commit = (pi: number, pr: number | null, desc: string, due: Date, status = "Open") =>
    q("insert into grow_commitments(brokerage_id,party_id,property_id,description,due_at,status,completed_at,completed_by_user_id,created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [brokerageId, partyIds[pi], pr === null ? null : propIds[pr], desc, due, status, status === "Completed" ? at(-1) : null, status === "Completed" ? agentId : null, agentId]);
  await commit(1, 1, "Send Bulimba comparable sales", at(-1, 15));
  await commit(0, 0, "Confirm appraisal time with Emma", at(0, 11));
  await commit(6, null, "Follow up open-home enquiry", at(0, 16));
  await commit(3, 3, "Prepare downsizing options pack", at(3, 10));
  await commit(7, null, "Thank-you call after referral", at(-2, 10), "Completed");

  // Activity history for Contact 360 timelines.
  const act = (pi: number, pr: number | null, type: string, days: number, summary: string) =>
    q("insert into grow_activities(brokerage_id,party_id,property_id,activity_type,occurred_at,summary,responsible_user_id,source) values ($1,$2,$3,$4,$5,$6,$7,'manual')",
      [brokerageId, partyIds[pi], pr === null ? null : propIds[pr], type, at(days), summary, agentId]);
  for (const [pi, pr, t, d, s] of [
    [0, 0, "call", -10, "Discussed timing; wants appraisal before Christmas"], [0, 0, "note", -30, "Met at Paddington open home"],
    [1, 1, "email", -6, "Sent recent sales in Bulimba"], [2, 2, "call", -4, "Landlord frustrated with vacancy period"],
    [3, 3, "meeting", -12, "Coffee catch-up; kids have moved out"], [4, 4, "call", -20, "Advised they listed elsewhere"],
    [5, 5, "meeting", -3, "Appraisal presented"], [8, null, "note", -15, "Investor, owns two units in Hamilton"],
  ] as const) await act(pi, pr, t, d, s);

  writeFileSync(credFile!, `# AE preview demo credentials — synthetic, preview DB only. Do not share in chat.\n${creds.join("\n")}\n`, { mode: 0o600 });
  console.log(`previewDemoSeed ok: brokerage ${brokerageId}, ${userIds.length} users, ${partyIds.length} contacts, ${propIds.length} properties. Credentials written to the credentials file (not printed).`);
  process.exit(0);
}
main().catch((e) => { console.error("previewDemoSeed failed:", e instanceof Error ? e.message : e); process.exit(1); });
