/**
 * `backlex advisor` — run the security / performance rule checks over
 * `/api/admin/advisor`. The `--fail-on` flag makes it a CI gate: exit non-zero
 * when any check at or above the given level is present (e.g. block a deploy on
 * an `error`). See `docs/advisor.md`.
 */
import { BacklexError } from "backlex";
import { has, flag, makeClient, printJson, printTable, resolveContext } from "./client";

interface AdvisorCheck {
  id: string;
  kind: "security" | "performance";
  level: "error" | "warn" | "info";
  rule: string;
  title: string;
  resource: string;
}

const ADVISOR_HELP = `backlex advisor [--kind security|performance] [--fail-on error|warn] [--json]

  Runs the advisor checks. With --fail-on, exits non-zero when any check at or
  above that level is present — use it as a CI gate.
`;

// Higher = more severe. A --fail-on threshold trips on anything >= its rank.
const RANK: Record<AdvisorCheck["level"], number> = { info: 0, warn: 1, error: 2 };

export const runAdvisor = async (args: string[]): Promise<void> => {
  if (has(args, "help") || has(args, "--help")) {
    process.stdout.write(ADVISOR_HELP);
    return;
  }
  const json = has(args, "--json");
  const kind = flag(args, "--kind");
  const failOn = flag(args, "--fail-on") as AdvisorCheck["level"] | undefined;

  const client = makeClient(resolveContext(args));
  try {
    const { data } = await client.request<{ data: AdvisorCheck[] }>("GET", "/api/admin/advisor");
    const checks = kind ? data.filter((c) => c.kind === kind) : data;

    if (json) printJson(checks);
    else if (checks.length === 0) process.stdout.write("✓ no advisor findings\n");
    else
      printTable(
        checks.map((c) => ({
          level: c.level,
          kind: c.kind,
          rule: c.rule,
          resource: c.resource,
          title: c.title,
        })),
      );

    if (failOn) {
      const threshold = RANK[failOn] ?? 0;
      const tripped = checks.filter((c) => (RANK[c.level] ?? 0) >= threshold);
      if (tripped.length > 0) {
        process.stderr.write(
          `\n✗ ${tripped.length} finding(s) at or above "${failOn}" — failing.\n`,
        );
        process.exit(1);
      }
    }
  } catch (e) {
    const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
    process.stderr.write(`advisor: ${msg}\n`);
    process.exit(1);
  }
};
