/**
 * A tool call an agent may not make without a person's yes.
 *
 * What already bounded an agent answered "is this allowed at all" — its tool
 * list, the caller's permission rules, the caller's MCP allowlist. This is the
 * one that says "allowed, but not unattended", and the failure it prevents is
 * an agent quietly doing the destructive thing because nothing in the chain
 * could express hesitation.
 *
 * The gate is **approve-then-retry**, not park-and-resume: the turn ends when
 * it hits the gate rather than suspending. That is a deliberate trade — see the
 * header of `services/agents/approval-gate.ts` — and the property it buys is
 * asserted here: hitting the gate twice does not open two requests, and no path
 * runs the tool without a decision.
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import * as realAiClient from "../src/server/mcp/ai-client";
import {
  callFingerprint,
  requiresApproval,
  APPROVAL_SUBJECT,
} from "../src/server/services/agents/approval-gate";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const realCallClaude = realAiClient.callClaude;
const realCallClaudeTools = realAiClient.callClaudeTools;
const realExtractJson = realAiClient.extractJson;

type ScriptTurn = { text?: string; toolCalls?: Array<{ name: string; args?: Record<string, unknown> }> };
let script: ScriptTurn[] = [];
let callIdx = 0;
const resetScript = (s: ScriptTurn[]) => {
  script = s;
  callIdx = 0;
};

mock.module("../src/server/mcp/ai-client", () => ({
  callClaude: realCallClaude,
  extractJson: realExtractJson,
  callClaudeTools: async () => {
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

describe("approval gate — pure", () => {
  test("it matches the same glob grammar as an MCP allowlist", () => {
    // One grammar in both places, because an operator who learns
    // `collections.*` for a key should not have to learn a second dialect here.
    expect(requiresApproval("collections.delete", ["collections.delete"])).toBe(true);
    expect(requiresApproval("collections.delete", ["collections.*"])).toBe(true);
    expect(requiresApproval("collections.delete", ["*"])).toBe(true);
    expect(requiresApproval("collections.delete", ["schema.*"])).toBe(false);
    // A glob stays inside its namespace — the property that keeps a sibling
    // namespace sharing a prefix from being swept in.
    expect(requiresApproval("collections_admin.delete", ["collections.*"])).toBe(false);
  });

  test("no patterns means no gate, which is the default", () => {
    // An approval flow nobody configured must never start refusing work.
    expect(requiresApproval("collections.delete", [])).toBe(false);
    expect(requiresApproval("collections.delete", null)).toBe(false);
    expect(requiresApproval("collections.delete", undefined)).toBe(false);
  });

  test("the fingerprint ignores argument ORDER but not argument VALUES", () => {
    // Otherwise the same approved call would look new every time a model
    // happened to serialise its arguments differently.
    const a = callFingerprint("t1", "collections.delete", { id: "1", collection: "posts" });
    const b = callFingerprint("t1", "collections.delete", { collection: "posts", id: "1" });
    expect(a).toBe(b);
    // A different row is a different decision.
    expect(callFingerprint("t1", "collections.delete", { id: "2", collection: "posts" })).not.toBe(a);
    // And so is the same call in another conversation.
    expect(callFingerprint("t2", "collections.delete", { id: "1", collection: "posts" })).not.toBe(a);
  });
});

describe("approval gate — through a real turn", () => {
  let h: TestHarness;
  let gatedAgent = "";
  let openAgent = "";
  let noApproverAgent = "";

  const makeAgent = async (body: Record<string, unknown>): Promise<string> => {
    const res = await h.fetch("/api/agents", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ tools: ["schema.list_collections"], maxSteps: 3, ...body }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  };

  const runTurn = async (agentId: string, message: string) => {
    const t = await h.fetch(`/api/agents/${agentId}/threads`, {
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
    const body = (await res.json()) as {
      data: { answer: string; steps: Array<{ tool: string; observation: string; isError: boolean }> };
    };
    return { threadId, ...body.data };
  };

  const pendingRequests = async () => {
    const res = await h.fetch("/api/admin/approvals?status=pending");
    return ((await res.json()) as { data: Array<{ id: string; title: string }> }).data ?? [];
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    gatedAgent = await makeAgent({
      name: `Gated-${Date.now()}`,
      approvalTools: ["schema.*"],
      approvers: [{ email: "ayse@example.test", name: "Ayşe" }],
    });
    openAgent = await makeAgent({ name: `Open-${Date.now()}` });
    noApproverAgent = await makeAgent({
      name: `NoApprover-${Date.now()}`,
      approvalTools: ["schema.*"],
    });
  });
  afterAll(() => h.cleanup());

  test("CONTROL: without a gate the same tool runs", async () => {
    // Without this passing, every assertion below could be a tool that simply
    // does not work.
    resetScript([{ toolCalls: [{ name: "schema_list_collections" }] }, { text: "done" }]);
    const turn = await runTurn(openAgent, "list the collections");
    expect(turn.steps[0]?.tool).toBe("schema.list_collections");
    expect(turn.steps[0]?.isError).toBe(false);
  });

  test("a gated tool does NOT run, and a request is opened naming it", async () => {
    const before = (await pendingRequests()).length;
    resetScript([{ toolCalls: [{ name: "schema_list_collections" }] }, { text: "done" }]);
    const turn = await runTurn(gatedAgent, "list the collections");

    expect(turn.steps[0]?.isError).toBe(true);
    expect(turn.steps[0]?.observation).toContain("needs approval");
    expect(turn.steps[0]?.observation).toContain("has NOT been run");

    const after = await pendingRequests();
    expect(after.length).toBe(before + 1);
    expect(after.some((r) => r.title.includes("schema.list_collections"))).toBe(true);
  });

  test("a second attempt does not open a second request", async () => {
    // One decision, one email. Asking again on every turn would mail the
    // approvers once per attempt.
    const before = (await pendingRequests()).length;
    resetScript([{ toolCalls: [{ name: "schema_list_collections" }] }, { text: "done" }]);
    const first = await runTurn(gatedAgent, "list them");
    const opened = (await pendingRequests()).length;
    expect(opened).toBe(before + 1);

    // Same thread, same tool, same (empty) arguments — the same operation.
    resetScript([{ toolCalls: [{ name: "schema_list_collections" }] }, { text: "done" }]);
    const res = await h.fetch(`/api/agents/threads/${first.threadId}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ message: "try again" }),
    });
    const body = (await res.json()) as {
      data: { steps: Array<{ observation: string; isError: boolean }> };
    };
    expect(body.data.steps[0]?.observation).toContain("waiting on approval request");
    expect((await pendingRequests()).length).toBe(opened);
  });

  test("a gate with no approvers refuses rather than passing", async () => {
    // "Configured for approval, ran unapproved" is the one outcome that must be
    // impossible; with nobody to ask, refusing is the only safe reading.
    const before = (await pendingRequests()).length;
    resetScript([{ toolCalls: [{ name: "schema_list_collections" }] }, { text: "done" }]);
    const turn = await runTurn(noApproverAgent, "list the collections");
    expect(turn.steps[0]?.isError).toBe(true);
    expect(turn.steps[0]?.observation).toContain("no approvers configured");
    // And it did not open a request nobody could answer.
    expect((await pendingRequests()).length).toBe(before);
  });

  test("an approved call goes through", async () => {
    // Approved through the real public decision route, keyed on the fingerprint
    // the gate computes — so this proves the correlation, not just the flag.
    const t = await h.fetch(`/api/agents/${gatedAgent}/threads`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    const threadId = ((await t.json()) as { data: { id: string } }).data.id;
    const fingerprint = callFingerprint(threadId, "schema.list_collections", {});

    const created = await h.fetch("/api/admin/approvals", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        title: "pre-approved for the test",
        approvers: [{ email: "ayse@example.test" }],
        subject: { collection: APPROVAL_SUBJECT, id: fingerprint },
      }),
    });
    expect(created.status).toBe(201);
    const links = ((await created.json()) as { data: { links: Array<{ url: string }> } }).data.links;
    const token = links[0]!.url.split("/approve/")[1]!;
    const decided = await h.fetch(`/api/public/approve/${token}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(decided.status).toBe(200);

    resetScript([{ toolCalls: [{ name: "schema_list_collections" }] }, { text: "done" }]);
    const res = await h.fetch(`/api/agents/threads/${threadId}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ message: "now list them" }),
    });
    const body = (await res.json()) as {
      data: { steps: Array<{ tool: string; isError: boolean }> };
    };
    expect(body.data.steps[0]?.tool).toBe("schema.list_collections");
    expect(body.data.steps[0]?.isError).toBe(false);
  });
});
