// GR-E2E — authenticated browser smoke for Grow: nav, Contacts, Properties,
// Opportunities. Everything is local: scratch Postgres (DATABASE_URL), the
// API (tsx src/index.ts) and the Vite dev server on free loopback ports, and
// headless Chrome over CDP. Synthetic data only; dev-login (ALLOW_DEV_AUTH)
// is the seeded login. Not wired into `pnpm test` or GitHub Actions.
import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, type Page } from "./cdp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "..");
const webDir = path.resolve(here, "../../web");
const tag = `E2E${Date.now()}`;
const brokerageName = `GR-E2E Synthetic ${tag}`;
const email = `gr-e2e-admin-${tag.toLowerCase()}@example.com`;
const marker = {
  address: `${tag} 7 Synthetic Lane`,
  contactLast: `Smoke${tag}`,
  oppReason: `Synthetic appraisal lead ${tag}`,
};

const GROW_KEYS = [
  "grow.access", "grow.contacts.read", "grow.contacts.manage", "grow.relationships.manage",
  "grow.properties.link", "grow.activities.manage", "grow.opportunities.manage", "run.access",
];

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (!a || typeof a === "string") return rej(new Error("no port"));
      s.close(() => res(a.port));
    });
  });
}
async function waitHttp(url: string, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`not reachable: ${url}`);
}
const procs: ChildProcess[] = [];
function start(cmd: string, args: string[], cwd: string, env: Record<string, string>, label: string) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const log = (d: Buffer) => { if (process.env.E2E_VERBOSE) process.stderr.write(`[${label}] ${d}`); };
  p.stdout?.on("data", log); p.stderr?.on("data", log);
  procs.push(p);
  return p;
}

let browser: Browser;
let page: Page;
let webOrigin: string;
let apiOrigin: string;

async function api(method: string, p: string, cookie: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${apiOrigin}/api${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("GR-E2E Grow authenticated smoke (LOCAL)", { concurrency: 1 }, () => {
  before(async () => {
    assert.ok(process.env.DATABASE_URL, "DATABASE_URL (scratch PG16) is required");
    assert.equal(process.env.ALLOW_DEV_AUTH, "true", "ALLOW_DEV_AUTH=true is required (seeded dev-login)");
    const apiPort = await freePort();
    const webPort = await freePort();
    apiOrigin = `http://127.0.0.1:${apiPort}`;
    webOrigin = `http://127.0.0.1:${webPort}`;
    start("npx", ["tsx", "src/index.ts"], apiDir, { PORT: String(apiPort), NODE_ENV: "test" }, "api");
    await waitHttp(`${apiOrigin}/api/health/live`);
    start("npx", ["vite", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], webDir,
      { VITE_API_PROXY_TARGET: apiOrigin }, "web");
    await waitHttp(`${webOrigin}/`);

    // Seed: brokerage + admin via dev-login, Grow entitlements, synthetic rows.
    const login = await api("POST", "/auth/dev-login", null, { email, firstName: "Eve", lastName: "Smoke", brokerageName });
    assert.ok(login.status === 200 || login.status === 201, await login.clone().text());
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const { user } = (await login.json()) as { user: { brokerageId: number } };
    const { db, entitlementGrants } = await import("@aee/db");
    for (const key of GROW_KEYS) {
      await db.insert(entitlementGrants).values({
        brokerageId: user.brokerageId, entitlementKey: key, granteeType: "brokerage",
        granteeId: user.brokerageId, sourceType: "manual", status: "Active",
      });
    }
    const prop = await api("POST", "/properties", cookie, { formattedAddress: marker.address, state: "NSW", suburb: "Testville", postcode: "2000" });
    assert.equal(prop.status, 201, await prop.clone().text());
    const propertyId = ((await prop.json()) as { property: { id: number } }).property.id;
    const contact = await api("POST", "/grow/contacts", cookie, { firstName: "Eve", lastName: marker.contactLast, email: `c-${tag.toLowerCase()}@example.com` });
    assert.equal(contact.status, 201, await contact.clone().text());
    const partyId = ((await contact.json()) as { contact: { id: number } }).contact.id;
    const opp = await api("POST", "/grow/opportunities", cookie, { partyId, propertyId, opportunityType: "Appraisal", reason: marker.oppReason });
    assert.equal(opp.status, 201, await opp.clone().text());

    browser = await Browser.launch();
    page = await browser.newPage();
    await page.goto(`${webOrigin}/login`);
    // Seeded login through the real dev-login endpoint, via the web origin's /api proxy.
    const status = await page.evaluate<number>(`fetch('/api/auth/dev-login', {method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify(${JSON.stringify({ email, firstName: "Eve", lastName: "Smoke", brokerageName })})}).then(r => r.status)`);
    assert.ok(status === 200 || status === 201, `browser dev-login ${status}`);
  });

  after(async () => {
    try { page?.close(); await browser?.close(); } catch { /* ignore */ }
    for (const p of procs) { try { if (p.pid) process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }
    if (process.env.E2E_KEEP_DATA !== "1") {
      try {
        const { cleanupBrokerages } = await import("../src/routes/__tests__/testSupport.js");
        const { db, brokerages } = await import("@aee/db");
        const { eq } = await import("drizzle-orm");
        const rows = await db.select({ id: brokerages.id }).from(brokerages).where(eq(brokerages.name, brokerageName));
        await cleanupBrokerages(rows.map((r) => r.id));
      } catch (e) { process.stderr.write(`cleanup skipped: ${String(e)}\n`); }
    }
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  });

  test("lands authenticated and shows the main nav with Grow first", async () => {
    await page.goto(`${webOrigin}/grow`);
    await page.waitForText("Properties");
    const nav = await page.evaluate<string[]>(`[...document.querySelectorAll('nav a')].map(a => a.textContent.trim())`);
    assert.ok(nav.length > 0, "nav rendered");
    assert.equal(nav.find((l) => l === "Grow" || l === "Properties"), "Grow", `Grow before Properties: ${nav.join("|")}`);
    assert.ok(!(await page.text()).includes("Page not found"));
    assert.ok(!(await page.url()).startsWith("/login"), "still authenticated");
  });

  test("Contacts tab lists the seeded contact", async () => {
    await page.goto(`${webOrigin}/grow?tab=contacts`);
    await page.waitForText(marker.contactLast);
  });

  test("Opportunities tab lists the seeded opportunity", async () => {
    await page.goto(`${webOrigin}/grow?tab=opportunities`);
    await page.waitForText(marker.oppReason);
  });

  test("Properties nav link opens the list with the seeded property", async () => {
    await page.goto(`${webOrigin}/grow`);
    await page.waitForText("Properties");
    await page.clickText("Properties");
    await page.waitFor(async () => (await page.url()).startsWith("/properties"), "url /properties");
    await page.waitForText(marker.address);
  });

  test("no uncaught page exceptions and no error boundary", async () => {
    assert.ok(!(await page.text()).includes("Something went wrong"));
    assert.deepEqual(page.consoleErrors, []);
  });
});
