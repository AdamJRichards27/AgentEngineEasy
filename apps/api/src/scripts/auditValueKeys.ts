// t277u operator tool (see KEY-MANAGEMENT.md). Prints key IDS and COUNTS only — never key
// material or audit values. Usage:
//   tsx src/scripts/auditValueKeys.ts status | verify | rotate | retire <kid>
import { auditValueKeyStatus, retireAuditValueKey, rotateAuditValueKeys, verifyAuditValueKeys } from "../lib/auditValueVault.js";

const [cmd, arg] = process.argv.slice(2);
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
async function main() {
  if (cmd === "status") return out(auditValueKeyStatus());
  if (cmd === "verify") {
    const v = await verifyAuditValueKeys();
    return out({ examined: v.examined, byKid: v.byKid, unverified: v.unverified.length, unverifiedIds: v.unverified.slice(0, 50) });
  }
  if (cmd === "rotate") {
    const r = await rotateAuditValueKeys();
    return out({ activeKid: r.activeKid, examined: r.examined, reencrypted: r.reencrypted, failed: r.failed.length });
  }
  if (cmd === "retire" && arg) {
    const r = await retireAuditValueKey(arg);
    out(r);
    if (!r.ok) process.exitCode = 2;
    return;
  }
  process.stderr.write("usage: status | verify | rotate | retire <kid>\n");
  process.exitCode = 1;
}
main()
  .catch((e) => {
    process.stderr.write(`failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(), 100));
