#!/usr/bin/env node
/**
 * Read-only audit of Grow entitlement grants.
 *
 * Grow capabilities are gated per key, not by `grow.access` alone. A brokerage
 * that bought Grow (or the bundle) receives every `grow.*` key through the
 * billing catalogue, but a brokerage granted `grow.access` BY HAND — the usual
 * pilot shortcut — may hold only that one key. Those brokerages lose the
 * surfaces whose keys they are missing: Ask AE / Business Coach / voice
 * (`grow.ai.use`), appraisal edits (`grow.opportunities.manage`), Grow thread
 * messaging (`grow.contacts.manage`), and so on.
 *
 * This script only reads. Run it before deploying, and grant the missing keys
 * through the product's own path (a Grow or bundle subscription) or by an
 * explicit, recorded manual grant.
 *
 * Usage: DATABASE_URL=... node scripts/audit-grow-entitlements.mjs
 */
import pg from "pg";

// Keys whose absence removes a capability from a brokerage that is meant to
// have Grow. Kept in step with apps/api/src/lib/billing/catalogue.ts.
const GROW_KEYS = [
  "grow.access",
  "grow.contacts.read",
  "grow.contacts.manage",
  "grow.properties.link",
  "grow.relationships.manage",
  "grow.activities.manage",
  "grow.opportunities.manage",
  "grow.import.execute",
  "grow.import.review",
  "grow.ai.use",
  "grow.automation.use",
  "grow.campaigns.use",
  "grow.admin.configure",
  "grow.propertyIntelligence.read",
  "grow.propertyIntelligence.manage",
];

// Calling keys are deliberately excluded from the "missing" report: a pilot may
// intentionally withhold them (there is no product path to record call consent
// or Do Not Call status yet). They are reported separately when present.
const CALLING_KEYS = ["grow.calling.access", "grow.calling.recording", "grow.calling.transcription"];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set. Point it at the database you are about to deploy against.");
    process.exit(2);
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(
      `select b.id, b.name, g.entitlement_key, g.source_type
         from brokerages b
         join entitlement_grants g on g.brokerage_id = b.id and g.status = 'Active'
        where g.entitlement_key like 'grow.%'
        order by b.id`,
    );
    if (rows.length === 0) {
      console.log("No active Grow entitlement grants found. Nothing to audit.");
      return;
    }
    const byBrokerage = new Map();
    for (const row of rows) {
      const entry = byBrokerage.get(row.id) ?? { name: row.name, keys: new Set(), manual: false };
      entry.keys.add(row.entitlement_key);
      if (row.source_type === "manual") entry.manual = true;
      byBrokerage.set(row.id, entry);
    }

    let incomplete = 0;
    for (const [id, entry] of byBrokerage) {
      if (!entry.keys.has("grow.access")) continue;
      const missing = GROW_KEYS.filter((key) => !entry.keys.has(key));
      const calling = CALLING_KEYS.filter((key) => entry.keys.has(key));
      const label = `#${id} ${entry.name}${entry.manual ? " (has manual grants)" : ""}`;
      if (missing.length === 0) {
        console.log(`OK        ${label}${calling.length ? ` — calling keys granted: ${calling.join(", ")}` : ""}`);
        continue;
      }
      incomplete += 1;
      console.warn(`INCOMPLETE ${label}`);
      console.warn(`           missing: ${missing.join(", ")}`);
      if (calling.length) console.warn(`           calling keys granted: ${calling.join(", ")}`);
    }

    if (incomplete > 0) {
      console.warn(
        `\n${incomplete} brokerage(s) hold grow.access without every Grow key. They will be refused the ` +
          "surfaces listed above (Ask AE / Coach / voice, appraisal edits, Grow thread messaging, and so on). " +
          "Grant the missing keys through a Grow or bundle subscription, or by an explicit recorded manual grant, " +
          "before relying on those surfaces.",
      );
    } else {
      console.log("\nEvery brokerage holding grow.access holds the full Grow key set.");
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Grow entitlement audit could not complete:", error instanceof Error ? error.message : error);
  process.exit(2);
});
