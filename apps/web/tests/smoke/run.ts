/**
 * CLI runner for the smoke contract. Reads:
 *   SMOKE_URL    base URL to test against (required)
 *   SMOKE_CRON   "1" / "true" to also test the cron auth gate
 *                (set this for vercel-bundle / netlify-bundle; leave
 *                unset for the Bun entry which has no cron route)
 *
 * Exits 0 on full pass, 1 on any failure.
 */
import { runSmokeContract } from "./contract";

const url = process.env.SMOKE_URL;
if (!url) {
  console.error("SMOKE_URL is required");
  process.exit(2);
}

const checkCron =
  process.env.SMOKE_CRON === "1" || process.env.SMOKE_CRON === "true";

console.log(`[smoke] target: ${url} (cron check: ${checkCron})`);

const { passes, failures } = await runSmokeContract({
  baseUrl: url,
  checkCron,
});

for (const p of passes) console.log(`  ✓ ${p}`);
for (const f of failures) console.error(`  ✗ ${f}`);

if (failures.length > 0) {
  console.error(
    `\n[smoke] ✗ ${failures.length} failure(s), ${passes.length} pass(es)`,
  );
  process.exit(1);
}
console.log(`\n[smoke] ✓ all ${passes.length} checks passed`);
