/**
 * `ctx.ai.generate` — the sandbox's sixth host call, and the first that spends
 * money.
 *
 * Two halves, because the op is NOT uniformly available and pretending it is
 * would be the bug. On Bun (and on a remote executor) it reaches the same
 * `callClaude` chokepoint everything else does. On the in-isolate QuickJS
 * provider — which is what a stock Cloudflare / Vercel / Netlify deploy runs —
 * there is no host bridge at all and the package ships only SYNC wasm, so there
 * is no way to suspend the guest while a host promise settles. That half is
 * pinned as a REFUSAL with an actionable message, because the alternative
 * (leaving `ctx.ai` undefined) fails as "undefined is not an object" and sends
 * the author to look at their own code.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AI_OP_DEFAULT_MAX_TOKENS } from "@backlex/core";
import { buildContext } from "../src/server/context";
import { runFunction } from "../src/server/services/sandbox";
import { HOST_IO_UNAVAILABLE, quickjsProvider } from "../src/server/services/sandbox/providers/quickjs";
import { flushUsage, usageRows } from "../src/server/services/usage";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const BYO_KEY = "sk-ant-test-sandbox-op";

interface AnthropicCall {
  headers: Record<string, string>;
  body: {
    max_tokens?: number;
    system?: string | { text?: string }[];
    messages: { role: string; content?: string | { text?: string }[] }[];
  };
  signal?: AbortSignal | null;
}

const userText = (body: AnthropicCall["body"]): string => {
  const c = body.messages[0]?.content;
  if (typeof c === "string") return c;
  return (c ?? []).map((p) => p.text ?? "").join("");
};

const anthropicReply = (text: string): Response =>
  new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const installAnthropicMock = (
  respond: (call: AnthropicCall) => Response | Promise<Response>,
): { calls: AnthropicCall[]; restore: () => void } => {
  const real = globalThis.fetch;
  const calls: AnthropicCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.anthropic.com/")) {
      const call: AnthropicCall = {
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)) as AnthropicCall["body"],
        signal: init?.signal,
      };
      calls.push(call);
      return respond(call);
    }
    return real(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
};

describe("ctx.ai.generate", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  const configureAi = async () => {
    const res = await h.fetch("/api/admin/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", secrets: { anthropicKey: BYO_KEY } }),
    });
    expect(res.status).toBe(200);
  };

  /** The bindings a real invoke builds, minus the HTTP layer. */
  const bindings = async () => {
    const ctx = await buildContext(h.env);
    const tenants = (await (await h.fetch("/api/tenants")).json()) as { data: { id: string }[] };
    return {
      ctx,
      tenantId: tenants.data[0]!.id,
      auth: {
        userId: "u_test",
        email: "admin@example.com",
        roles: ["admin"],
        tenantId: tenants.data[0]!.id,
      },
    };
  };

  describe("on a provider that has a host bridge (bun-worker)", () => {
    test("reaches the model and hands the answer back to the function", async () => {
      await configureAi();
      const b = await bindings();
      const mock = installAnthropicMock(() => anthropicReply("a short summary"));
      try {
        const out = await runFunction(
          `const r = await ctx.ai.generate({ prompt: "summarise " + ctx.data.subject });
           return r.text;`,
          { ctx: b.ctx, auth: b.auth as never },
          { subject: "the roof" },
          10_000,
        );
        expect(out.ok).toBe(true);
        expect(out.value).toBe("a short summary");

        expect(mock.calls.length).toBe(1);
        const call = mock.calls[0] as AnthropicCall;
        // The workspace's own key, not the deployment env.
        expect(call.headers["x-api-key"]).toBe(BYO_KEY);
        expect(userText(call.body)).toBe("summarise the roof");
        expect(call.body.max_tokens).toBe(AI_OP_DEFAULT_MAX_TOKENS);
        // A function's own timeout terminates the GUEST and leaves this promise
        // running, so the generation carries its own deadline.
        expect(call.signal).toBeInstanceOf(AbortSignal);
      } finally {
        mock.restore();
      }
    });

    test("the generation is metered against the workspace", async () => {
      await configureAi();
      const b = await bindings();
      const mock = installAnthropicMock(() => anthropicReply("counted"));
      try {
        const out = await runFunction(
          `return (await ctx.ai.generate({ prompt: "hi" })).text;`,
          { ctx: b.ctx, auth: b.auth as never },
          {},
          10_000,
        );
        expect(out.ok).toBe(true);
      } finally {
        mock.restore();
      }
      await flushUsage(b.ctx);
      const row = (await usageRows(b.ctx, b.tenantId, 1)).find((r) => r.apiKeyId === "");
      expect(row?.aiCalls).toBe(1);
      expect(row?.aiTokensIn).toBe(5);
      expect(row?.aiTokensOut).toBe(3);
    });

    test("an empty prompt is refused before anything is billed", async () => {
      await configureAi();
      const b = await bindings();
      const mock = installAnthropicMock(() => anthropicReply("unreachable"));
      try {
        const out = await runFunction(
          `return (await ctx.ai.generate({ prompt: "   " })).text;`,
          { ctx: b.ctx, auth: b.auth as never },
          {},
          10_000,
        );
        expect(out.ok).toBe(false);
        expect(out.error).toContain("non-empty prompt");
        expect(mock.calls.length).toBe(0);
      } finally {
        mock.restore();
      }
    });

    test("a run with no workspace refuses rather than falling back to the deployment key", async () => {
      // A remote executor's `auth` body is trusted wholesale behind a shared
      // secret and its `tenantId` is optional for back-compat, so this is a
      // shape that really arrives.
      await configureAi();
      const b = await bindings();
      const mock = installAnthropicMock(() => anthropicReply("unreachable"));
      try {
        const out = await runFunction(
          `return (await ctx.ai.generate({ prompt: "hi" })).text;`,
          { ctx: b.ctx, auth: { ...b.auth, tenantId: null } as never },
          {},
          10_000,
        );
        expect(out.ok).toBe(false);
        expect(out.error).toContain("workspace-scoped");
        expect(mock.calls.length).toBe(0);
      } finally {
        mock.restore();
      }
    });

    test("with no provider configured it says where to go", async () => {
      const b = await bindings();
      const mock = installAnthropicMock(() => anthropicReply("unreachable"));
      try {
        const out = await runFunction(
          `return (await ctx.ai.generate({ prompt: "hi" })).text;`,
          { ctx: b.ctx, auth: b.auth as never },
          {},
          10_000,
        );
        expect(out.ok).toBe(false);
        expect(out.error).toContain("no AI provider is configured");
        expect(mock.calls.length).toBe(0);
      } finally {
        mock.restore();
      }
    });
  });

  describe("on the in-isolate QuickJS provider, which has no host bridge at all", () => {
    // This provider is what a stock Cloudflare / Vercel / Netlify deploy runs,
    // so it is the one most likely to meet a function copied out of the docs.
    const run = async (source: string) => {
      const b = await bindings();
      return quickjsProvider.run(source, { ctx: b.ctx, auth: b.auth as never }, {}, 5_000);
    };

    test("ctx.ai.generate refuses with a message that names the remedy", async () => {
      const out = await run(`return ctx.ai.generate({ prompt: "hi" });`);
      expect(out.ok).toBe(false);
      // Not "undefined is not an object" — that would send the author to look
      // at their own code for a call that is real everywhere else.
      expect(out.error).toContain("host I/O is not available");
      expect(out.error).toContain("FUNCTIONS_EXEC_URL");
    });

    test("every other host call refuses the same way", async () => {
      for (const call of [
        `ctx.fetch("https://example.com")`,
        `ctx.db.list("things")`,
        `ctx.db.one("things", "1")`,
        `ctx.email.send({ to: "a@b.c", subject: "s", text: "t" })`,
        `ctx.push.send({ userId: "u", title: "t", body: "b" })`,
      ]) {
        const out = await run(`return ${call};`);
        expect(out.ok).toBe(false);
        expect(out.error).toContain(HOST_IO_UNAVAILABLE.slice(0, 40));
      }
    });

    test("the data the provider CAN supply still works", async () => {
      // The refusals must not have displaced `ctx.data` / `ctx.user`.
      const b = await bindings();
      const out = await quickjsProvider.run(
        `return ctx.data.n + 1;`,
        { ctx: b.ctx, auth: b.auth as never },
        { n: 41 },
        5_000,
      );
      expect(out.ok).toBe(true);
      expect(out.value).toBe(42);
    });
  });
});
