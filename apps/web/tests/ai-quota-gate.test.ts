/**
 * Every path that can generate asks the workspace's budget first.
 *
 * AI was metered from the day the counters landed and gated by nothing:
 * `usageOverview` weighed requests, storage and rows while a workspace could
 * generate without limit. That was survivable while every generation had a
 * human behind it, and stopped being so when AI reached paths nobody watches —
 * a cron-triggered flow with an AI step inside a `foreach` generates once per
 * row, up to the loop's 500-row ceiling.
 *
 * The gate cannot live in `callClaude`, which is the one chokepoint every AI
 * path goes through, because that module receives `env` and a meter and by
 * design does not know which workspace is paying. So it lives at the callers —
 * and a rule that lives at twelve call sites is a rule somebody forgets. Hence
 * this scan: a file that generates either asks, or says in writing why it does
 * not, and an exemption that claims another file gates it must name a file that
 * really does.
 *
 * Style follows `sdk-surfaces.test.ts`: read the sources, assert in both
 * directions, and make an excuse cost a sentence.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "..", "src", "server");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

const rel = (p: string) => p.slice(p.indexOf("src/server/"));

/** Files that call the model. `ai-client.ts` is the implementation itself. */
const generators = walk(SERVER)
  .filter((p) => !p.endsWith("mcp/ai-client.ts"))
  .map((p) => ({ path: rel(p), src: readFileSync(p, "utf8") }))
  .filter((f) => /\bawait callClaude\(|\bcallClaudeTools\(/.test(f.src));

/**
 * A generator that does NOT call the gate itself, and why that is right.
 *
 * `gatedIn` is checked: it must be a file that really calls `assertAiQuota`,
 * so an exemption cannot quietly point at a file where nobody asks. An
 * exemption with no `gatedIn` is a deliberate permanent hole and has to say
 * what makes it safe.
 */
const EXEMPT: Record<string, { gatedIn?: string; why: string }> = {
  "src/server/routes/ai-config.ts": {
    why: "The Settings · AI 'test key' action generates sixteen tokens to prove a key an admin has just typed actually works. Gating it would mean a workspace that has run out of budget cannot verify the credential it needs to fix, which is the same lockout the request cap already refuses to create when it exempts platform-admin sessions from the workspace cap. It is rate-limited per IP instead.",
  },
  "src/server/services/agents/mentions.ts": {
    gatedIn: "src/server/services/agents/send.ts",
    why: "The mention router is deliberately context-free — it takes its meter as a parameter rather than building one — so it has no workspace to ask about. The budget is asked at the seam that does have one, immediately before it is called.",
  },
  "src/server/services/i18n-translate.ts": {
    gatedIn: "src/server/routes/i18n.ts",
    why: "Same shape as the mention router: the service takes `meter` as a required parameter and knows nothing of the request. The route owns the context and asks there, once, before the first of however many batches the run needs.",
  },
};

const gateCallers = new Set(
  walk(SERVER)
    .map((p) => ({ path: rel(p), src: readFileSync(p, "utf8") }))
    .filter((f) => /\bassertAiQuota\(/.test(f.src) && !f.path.endsWith("services/usage.ts"))
    .map((f) => f.path),
);

describe("AI spend is gated everywhere it happens", () => {
  test("the scan actually found the generating files", () => {
    // A regex that matches nothing would make every assertion below vacuous.
    expect(generators.length).toBeGreaterThanOrEqual(8);
  });

  test("every file that generates either asks the budget or says why not", () => {
    const ungated = generators
      .filter((f) => !/\bassertAiQuota\(|\bassertAiBudget\(/.test(f.src))
      .map((f) => f.path)
      .filter((p) => !EXEMPT[p]);
    expect(ungated).toEqual([]);
  });

  test("an exemption that says another file gates it names one that really does", () => {
    for (const [path, ex] of Object.entries(EXEMPT)) {
      if (!ex.gatedIn) continue;
      expect(`${path} -> ${ex.gatedIn} asks: ${gateCallers.has(ex.gatedIn)}`).toBe(
        `${path} -> ${ex.gatedIn} asks: true`,
      );
    }
  });

  test("an exemption costs a real sentence of reasoning", () => {
    for (const [path, ex] of Object.entries(EXEMPT)) {
      expect(`${path}: ${ex.why.length >= 120}`).toBe(`${path}: true`);
    }
  });

  test("no exemption outlives the file it excuses", () => {
    // An entry for a file that no longer generates is an excuse with nothing
    // to excuse — and the next reader would take it for coverage.
    const generating = new Set(generators.map((f) => f.path));
    expect(Object.keys(EXEMPT).filter((p) => !generating.has(p))).toEqual([]);
  });

  test("the MCP tool surface asks through its own context, not by reaching for a db", () => {
    // `ToolCtx` carries `env` and a meter and no database, so a tool cannot
    // build the check itself. `assertAiBudget` is built beside `meterAi` from
    // the request that knows the workspace — the two halves of one decision.
    const types = readFileSync(join(SERVER, "mcp", "types.ts"), "utf8");
    expect(types).toContain("assertAiBudget");
    const dispatch = readFileSync(join(SERVER, "mcp", "dispatch.ts"), "utf8");
    expect(dispatch).toContain("assertAiBudget:");
    expect(dispatch).toContain("assertAiQuota(");
  });
});
