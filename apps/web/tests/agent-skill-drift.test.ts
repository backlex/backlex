/**
 * The published agent skill makes checkable claims about this server. A skill
 * full of stale facts is worse than no skill: an agent that trusts it writes
 * confidently wrong code, and nothing fails until a human reads the output.
 *
 * So every load-bearing claim in `packages/client/skills/backlex/SKILL.md` is
 * asserted here against the source it describes. This is a source-and-string
 * test rather than a behavioural one on purpose — the failure being prevented
 * is "someone changed the server and did not change the skill", which no
 * runtime assertion would ever see. Same shape as `examples-shape.test.ts` and
 * `agent-guard-contract.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSION_LIST } from "../src/server/mcp/protocol";
import { RPC_ERR } from "../src/server/mcp/types";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SKILL = readFileSync(
  join(ROOT, "packages", "client", "skills", "backlex", "SKILL.md"),
  "utf8",
);

describe("agent skill — frontmatter stays portable", () => {
  test("it declares only fields the open standard defines", () => {
    // The whole point is that 30+ agent tools read this file. Claude Code's own
    // extensions (`when_to_use`, `argument-hint`, `disable-model-invocation`,
    // `model`, …) are not part of the portable set, and a tool that validates
    // strictly rejects the file rather than ignoring the key.
    const fm = SKILL.split("---")[1] ?? "";
    const keys = [...fm.matchAll(/^([a-z-]+):/gm)].map((m) => m[1]);
    const PORTABLE = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
    for (const k of keys) expect(PORTABLE).toContain(k);
    expect(keys).toContain("name");
    expect(keys).toContain("description");
  });

  test("it grants no tools — it is instructions, not capability", () => {
    // This file installs into third parties' `node_modules` and agent tools may
    // load it on their own. `allowed-tools` would pre-approve calls in someone
    // else's session on our say-so; the skill deliberately carries none, so what
    // it ships is knowledge and every action still goes through the host's own
    // permission flow.
    const fm = SKILL.split("---")[1] ?? "";
    expect(fm).not.toContain("allowed-tools");
    expect(fm).not.toContain("disallowed-tools");
  });

  test("the description fits the listing budget", () => {
    // `description` + `when_to_use` are truncated at 1,536 characters in the
    // skill listing. A description that gets cut loses the sentence that says
    // when to load it, which is the only sentence that matters there.
    const d = /^description: (.*)$/m.exec(SKILL.split("---")[1] ?? "")?.[1] ?? "";
    expect(d.length).toBeGreaterThan(80);
    expect(d.length).toBeLessThan(1536);
  });
});

describe("agent skill — MCP claims match the server", () => {
  test("the revision it names as CURRENT is the one the dispatcher prefers", () => {
    // Anchored on the sentence, not on the substring. A bare `toContain` passes
    // on a half-updated document, because the older revisions are legitimately
    // listed a few lines below — found by breaking it.
    expect(SKILL).toContain(`Current revision **\`${PROTOCOL_VERSION}\`**`);
  });

  test("every revision it promises is actually accepted", () => {
    for (const v of SUPPORTED_PROTOCOL_VERSION_LIST) {
      expect(`${v}: ${SKILL.includes(v)}`).toBe(`${v}: true`);
    }
  });

  test("the header-mismatch code it quotes is the real one", () => {
    expect(SKILL).toContain(`${RPC_ERR.HEADER_MISMATCH}`);
  });

  test("the mounts it names exist", () => {
    const routes = readFileSync(join(ROOT, "apps/web/src/server/app.ts"), "utf8");
    expect(routes).toContain("/mcp");
    expect(SKILL).toContain("/api/admin/mcp");
  });
});

describe("agent skill — HTTP claims match the server", () => {
  test("`/health` is a real route and the skill warns about `/api/health`", () => {
    const app = readFileSync(join(ROOT, "apps/web/src/server/app.ts"), "utf8");
    expect(app).toContain('"/health"');
    expect(SKILL).toContain("/api/health");
  });

  test("the error-code → status mapping it publishes is the one the handler applies", () => {
    const handler = readFileSync(join(ROOT, "apps/web/src/server/middleware/error.ts"), "utf8");
    // Each pair the skill teaches an agent to branch on.
    for (const [code, status] of [
      ["UNAUTHORIZED", "401"],
      ["FORBIDDEN", "403"],
      ["NOT_FOUND", "404"],
      ["VALIDATION", "422"],
      ["CONFLICT", "409"],
      ["RATE_LIMITED", "429"],
    ] as const) {
      expect(`${code} in skill: ${SKILL.includes(code)}`).toBe(`${code} in skill: true`);
      expect(`${code} in handler: ${handler.includes(code)}`).toBe(`${code} in handler: true`);
      expect(`${code} status: ${SKILL.includes(status)}`).toBe(`${code} status: true`);
    }
  });
});

describe("agent skill — the traps it documents are still traps", () => {
  test("a fresh API key really is MCP default-deny", async () => {
    // If this ever became permissive, trap #1 would be actively misleading.
    const svc = readFileSync(join(ROOT, "apps/web/src/server/services/api-keys.ts"), "utf8");
    expect(svc).toMatch(/mcpTools/);
    expect(SKILL).toContain("mcpTools: []");
    expect(SKILL).toContain("mcpTools: null");
  });

  test("tool names really are hyphenated on the tenant mount only", () => {
    const wire = readFileSync(join(ROOT, "apps/web/src/server/mcp/wire-names.ts"), "utf8");
    expect(wire).toContain("toWireToolName");
    expect(SKILL).toContain("schema-list_collections");
    expect(SKILL).toContain("schema.list_collections");
  });

  test("the filter operators it teaches are the documented ones", () => {
    const querying = readFileSync(join(ROOT, "docs/querying.md"), "utf8");
    for (const op of ["_eq", "_neq", "_in", "_nin", "_contains", "_icontains", "_between", "_null", "_and", "_or", "_not"]) {
      expect(`${op} in skill: ${SKILL.includes(op)}`).toBe(`${op} in skill: true`);
      expect(`${op} in docs: ${querying.includes(op)}`).toBe(`${op} in docs: true`);
    }
  });
});

describe("agent skill — it actually ships", () => {
  test("the npm package includes the skills directory", () => {
    // Browsable on GitHub is not the same as installed next to the SDK. If
    // `files` stops listing it, `npm i backlex` silently stops shipping it.
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "packages", "client", "package.json"), "utf8"),
    ) as { files?: string[] };
    expect(pkg.files ?? []).toContain("skills");
  });
});
