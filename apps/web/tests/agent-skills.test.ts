/**
 * Agent skills — reusable procedural knowledge, in the open format.
 *
 * Two claims are worth holding to their consequences.
 *
 * **The format is not ours.** The columns are the Agent Skills shape so a tenant
 * can paste a `SKILL.md` written for any other agent tool. If the parser stops
 * accepting one, the feature has quietly become a second prompt field.
 *
 * **The body is not in the prompt.** Only name and description are; the model
 * asks for the body. That is the entire economic argument for skills over a
 * longer system prompt, so it is asserted directly against what the model was
 * actually sent.
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import * as realAiClient from "../src/server/mcp/ai-client";
import { parseSkillMarkdown } from "../src/server/services/agents/skills";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const realCallClaude = realAiClient.callClaude;
const realCallClaudeTools = realAiClient.callClaudeTools;
const realExtractJson = realAiClient.extractJson;

type ScriptTurn = { text?: string; toolCalls?: Array<{ name: string; args?: Record<string, unknown> }> };
let script: ScriptTurn[] = [];
let callIdx = 0;
let lastSystem = "";
let lastToolNames: string[] = [];
const resetScript = (s: ScriptTurn[]) => {
  script = s;
  callIdx = 0;
};

mock.module("../src/server/mcp/ai-client", () => ({
  callClaude: realCallClaude,
  extractJson: realExtractJson,
  callClaudeTools: async (_env: unknown, opts: { system?: string; tools?: Array<{ name: string }> }) => {
    lastSystem = opts?.system ?? "";
    lastToolNames = (opts?.tools ?? []).map((t) => t.name);
    const turn = script[callIdx++] ?? { text: "ok" };
    return {
      text: turn.text ?? "",
      toolCalls: (turn.toolCalls ?? []).map((c, i) => ({
        id: `call-${callIdx}-${i}`,
        name: c.name,
        args: c.args ?? {},
      })),
      usage: { input_tokens: 1, output_tokens: 2 },
    };
  },
}));

afterAll(() => {
  mock.module("../src/server/mcp/ai-client", () => ({
    callClaude: realCallClaude,
    callClaudeTools: realCallClaudeTools,
    extractJson: realExtractJson,
  }));
});

const JSON_HEADERS = { "content-type": "application/json" };

describe("SKILL.md parsing — the interoperability claim", () => {
  test("a real SKILL.md yields all three fields", () => {
    const md = [
      "---",
      "name: refunds",
      'description: How this shop issues a refund, and when not to.',
      "license: Apache-2.0",
      "---",
      "",
      "# Refunds",
      "",
      "Always check the order status first.",
    ].join("\n");
    const p = parseSkillMarkdown(md);
    expect(p.name).toBe("refunds");
    expect(p.description).toBe("How this shop issues a refund, and when not to.");
    expect(p.body.startsWith("# Refunds")).toBe(true);
    // Frontmatter must not survive into the body the model reads.
    expect(p.body).not.toContain("license:");
  });

  test("a quoted description survives, because a colon forces the quotes", () => {
    const p = parseSkillMarkdown('---\nname: x\ndescription: "Use when: a refund is asked for"\n---\nbody');
    expect(p.description).toBe("Use when: a refund is asked for");
  });

  test("markdown with no frontmatter is all body", () => {
    const p = parseSkillMarkdown("# Just a document\n\nno frontmatter here");
    expect(p.name).toBeUndefined();
    expect(p.body.startsWith("# Just a document")).toBe(true);
  });

  test("`allowed-tools` in pasted frontmatter is read past, never obeyed", () => {
    // A capability grant that arrived in pasted text must not widen what an
    // agent may do. The parser returns three fields and nothing else can leak.
    const p = parseSkillMarkdown(
      "---\nname: x\ndescription: d\nallowed-tools: Bash Read\n---\nbody",
    );
    expect(Object.keys(p).sort()).toEqual(["body", "description", "name"]);
    expect(JSON.stringify(p)).not.toContain("Bash");
  });
});

describe("skills through a real turn", () => {
  let h: TestHarness;
  let agentId = "";
  let plainAgentId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    const md = [
      "---",
      "name: refunds",
      "description: How this shop issues a refund. Read before refunding anything.",
      "---",
      "",
      "Step one: check the order is delivered.",
      "Step two: refund to the original method.",
    ].join("\n");
    const made = await h.fetch("/api/agents/skills", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ markdown: md }),
    });
    expect(made.status).toBe(201);

    const mk = async (skills: string[]) => {
      const res = await h.fetch("/api/agents", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: `A-${Math.random().toString(36).slice(2, 9)}`,
          tools: ["schema.list_collections"],
          skills,
          maxSteps: 3,
        }),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { data: { id: string } }).data.id;
    };
    agentId = await mk(["refunds"]);
    plainAgentId = await mk([]);
  });
  afterAll(() => h.cleanup());

  const runTurn = async (id: string, message: string) => {
    const t = await h.fetch(`/api/agents/${id}/threads`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    const threadId = ((await t.json()) as { data: { id: string } }).data.id;
    const res = await h.fetch(`/api/agents/threads/${threadId}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ message }),
    });
    return ((await res.json()) as {
      data: { answer: string; steps: Array<{ tool: string; observation: string; isError: boolean }> };
    }).data;
  };

  test("the prompt carries the description but NOT the body", async () => {
    // The whole economic argument. If the body were inlined, a long runbook
    // would be paid for on every turn and this would just be a second prompt.
    resetScript([{ text: "ok" }]);
    await runTurn(agentId, "hello");
    expect(lastSystem).toContain("refunds");
    expect(lastSystem).toContain("How this shop issues a refund");
    expect(lastSystem).not.toContain("check the order is delivered");
  });

  test("the load tool is offered only to an agent that has skills", async () => {
    resetScript([{ text: "ok" }]);
    await runTurn(agentId, "hello");
    expect(lastToolNames).toContain("skills_load");

    resetScript([{ text: "ok" }]);
    await runTurn(plainAgentId, "hello");
    expect(lastToolNames).not.toContain("skills_load");
  });

  test("the model can read the body on demand", async () => {
    resetScript([
      { toolCalls: [{ name: "skills_load", args: { name: "refunds" } }] },
      { text: "done" },
    ]);
    const turn = await runTurn(agentId, "refund order 7");
    expect(turn.steps[0]?.isError).toBe(false);
    expect(turn.steps[0]?.observation).toContain("check the order is delivered");
  });

  test("asking for a skill it does not have names what it does have", async () => {
    resetScript([
      { toolCalls: [{ name: "skills_load", args: { name: "not-a-skill" } }] },
      { text: "done" },
    ]);
    const turn = await runTurn(agentId, "do something");
    expect(turn.steps[0]?.isError).toBe(true);
    expect(turn.steps[0]?.observation).toContain("refunds");
  });

  test("a deactivated skill stops being offered, without breaking the turn", async () => {
    // Same contract a removed tool has: it quietly stops appearing.
    const list = (await (await h.fetch("/api/agents/skills")).json()) as {
      data: Array<{ id: string; name: string }>;
    };
    const id = list.data.find((s) => s.name === "refunds")!.id;
    await h.fetch(`/api/agents/skills/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ active: false }),
    });
    resetScript([{ text: "ok" }]);
    await runTurn(agentId, "hello");
    expect(lastToolNames).not.toContain("skills_load");
    expect(lastSystem).not.toContain("How this shop issues a refund");
  });
});

describe("skills CRUD", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  const post = (body: unknown) =>
    h.fetch("/api/agents/skills", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

  test("a name the model could not address is refused", async () => {
    for (const name of ["Has Spaces", "UPPER", "-leading", "x".repeat(65)]) {
      const res = await post({ name, description: "d", body: "b" });
      expect(`${name}: ${res.status}`).toBe(`${name}: 422`);
    }
  });

  test("a skill with no description is refused", async () => {
    // The description is the only part the model sees, so a skill without one
    // is invisible rather than merely sparse.
    const res = await post({ name: "nodesc", body: "b" });
    expect(res.status).toBe(422);
  });

  test("names are unique per workspace", async () => {
    expect((await post({ name: "dup", description: "d", body: "b" })).status).toBe(201);
    expect((await post({ name: "dup", description: "d", body: "b" })).status).toBe(409);
  });
});
