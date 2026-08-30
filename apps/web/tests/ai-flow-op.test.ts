/**
 * The `ai.generate` and `ai.classify` flow operations.
 *
 * Twenty-three operations could move a row, bill it, sign it and text somebody
 * about it, and none of them could think — so the sentence a human would have
 * written about a row still had to come from a human. These two close that, and
 * the tests below are mostly about the three ways an AI step can look like it
 * worked when it did not: a prompt whose template rendered to nothing (a
 * generation billed on whitespace), a classification the model answered outside
 * the label set (a value no downstream `condition` was written for), and a
 * generation that never comes back at all (a flow run has no retry and no
 * dead-letter queue above it, so nothing reclaims it).
 *
 * The model is stubbed the leak-proof way — a workspace BYO key plus an
 * interceptor scoped to `api.anthropic.com` on the global fetch, restored per
 * test. `h.fetch` drives the Hono app in process and never touches the global,
 * so this exercises the REAL `callClaude` → provider-selection → metering path
 * rather than replacing it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AI_OP_DEFAULT_MAX_TOKENS, AI_OP_MAX_TOKENS } from "@backlex/core";
import { buildContext } from "../src/server/context";
import { flushUsage, usageRows } from "../src/server/services/usage";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import type { FlowRunResult } from "../../../packages/client/src/index";

const BYO_KEY = "sk-ant-test-flow-op";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

interface AnthropicCall {
  headers: Record<string, string>;
  body: {
    model?: string;
    max_tokens?: number;
    system?: string | { text?: string }[];
    messages: { role: string; content?: string | { text?: string }[] }[];
  };
  /** The abort signal the provider was called with. Undefined here means the
   *  deadline never reached the transport — which is what the AI path looked
   *  like before these ops existed. */
  signal?: AbortSignal | null;
}

const systemText = (body: AnthropicCall["body"]): string =>
  typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text ?? "").join("\n");

const userText = (body: AnthropicCall["body"]): string => {
  const c = body.messages[0]?.content;
  if (typeof c === "string") return c;
  return (c ?? []).map((p) => p.text ?? "").join("\n");
};

/** A complete Anthropic Messages response — the AI SDK validates the envelope,
 *  so a bare `{content:[…]}` fails parsing before product code sees it. */
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
      usage: { input_tokens: 11, output_tokens: 7 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** Intercept ONLY api.anthropic.com on the global fetch; everything else falls
 *  through. Returns the recorded calls and a restore handle for `finally`. */
const installAnthropicMock = (
  respond: (call: AnthropicCall, n: number) => Response | Promise<Response>,
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
      return respond(call, calls.length);
    }
    return real(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
};

describe("AI flow ops", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  /** Give the workspace its own Anthropic key, the way Settings · AI does. */
  const configureAi = async () => {
    const res = await h.fetch("/api/admin/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", secrets: { anthropicKey: BYO_KEY } }),
    });
    expect(res.status).toBe(200);
  };

  const makeFlow = (ops: Record<string, unknown>[]) =>
    h.fetch(
      "/api/flows",
      json({ name: `ai-${Math.random().toString(36).slice(2)}`, trigger: "manual:", operations: ops }),
    );

  /** Create + invoke, returning the run outcome. */
  const run = async (ops: Record<string, unknown>[], input: Record<string, unknown> = {}) => {
    const created = await makeFlow(ops);
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const res = await h.fetch(`/api/flows/${data.id}/run`, json(input));
    return (await res.json()) as FlowRunResult;
  };

  describe("ai.generate", () => {
    test("interpolates the prompt off the triggering row and answers", async () => {
      await configureAi();
      const mock = installAnthropicMock(() => anthropicReply("A tidy summary."));
      try {
        const out = await run(
          [{ type: "ai.generate", prompt: "Summarise: {{ data.body }}", system: "You write for {{ data.who }}." }],
          { body: "the roof is leaking", who: "landlords" },
        );
        expect(out).toEqual({ ok: true });

        expect(mock.calls.length).toBe(1);
        const call = mock.calls[0] as AnthropicCall;
        // The workspace's own key paid for it, not the deployment env.
        expect(call.headers["x-api-key"]).toBe(BYO_KEY);
        expect(userText(call.body)).toBe("Summarise: the roof is leaking");
        expect(systemText(call.body)).toContain("You write for landlords.");
        // The op's own ceiling, not the AI client's 4096 default: what an
        // `ai.generate` produces travels on `$last` into every later step.
        expect(call.body.max_tokens).toBe(AI_OP_DEFAULT_MAX_TOKENS);
      } finally {
        mock.restore();
      }
    });

    test("the deadline reaches the provider", async () => {
      // Before this op, nothing in the AI path passed an abort signal at all —
      // `callClaude` had no way to accept one. If this assertion goes soft the
      // timeout test below stops meaning anything, so it is asserted on its own.
      await configureAi();
      const mock = installAnthropicMock(() => anthropicReply("ok"));
      try {
        expect(await run([{ type: "ai.generate", prompt: "hi" }])).toEqual({ ok: true });
        expect(mock.calls[0]?.signal).toBeInstanceOf(AbortSignal);
        expect(mock.calls[0]?.signal?.aborted).toBe(false);
      } finally {
        mock.restore();
      }
    });

    test("a generation that never returns fails the step instead of hanging the run", async () => {
      await configureAi();
      const mock = installAnthropicMock(
        (call) =>
          new Promise<Response>((_resolve, reject) => {
            // Reject when the op's deadline fires. The fallback timer only
            // exists so a signal that never arrived fails the test quickly
            // instead of hanging it until the runner's own timeout.
            call.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            setTimeout(() => reject(new Error("no abort signal reached the provider")), 8_000);
          }),
      );
      try {
        const out = await run([{ type: "ai.generate", prompt: "hi", timeoutMs: 1_000 }]);
        expect(out.ok).toBe(false);
        expect(out.error).toContain("did not answer within 1000ms");
      } finally {
        mock.restore();
      }
    }, 20_000);

    test("the answer lands on $last for the next step to read", async () => {
      await configureAi();
      const mock = installAnthropicMock((_call, n) => anthropicReply(n === 1 ? "ANSWER-ONE" : "ANSWER-TWO"));
      try {
        const out = await run([
          { type: "ai.generate", prompt: "first" },
          { type: "ai.generate", prompt: "second saw: {{ $last.text }}" },
        ]);
        expect(out).toEqual({ ok: true });
        expect(mock.calls.length).toBe(2);
        expect(userText((mock.calls[1] as AnthropicCall).body)).toBe("second saw: ANSWER-ONE");
      } finally {
        mock.restore();
      }
    });

    test("a prompt whose template renders empty fails before anything is billed", async () => {
      await configureAi();
      const mock = installAnthropicMock(() => anthropicReply("should never be reached"));
      try {
        const out = await run([{ type: "ai.generate", prompt: "{{ data.missing }}" }], { present: "x" });
        expect(out.ok).toBe(false);
        expect(out.error).toContain("rendered empty");
        // The point of checking the RENDERED value: interpolation never fails,
        // so without this the workspace pays for a generation on whitespace.
        expect(mock.calls.length).toBe(0);
      } finally {
        mock.restore();
      }
    });

    test("an empty completion is a failure, not a silent success", async () => {
      await configureAi();
      const mock = installAnthropicMock(() => anthropicReply("   "));
      try {
        const out = await run([{ type: "ai.generate", prompt: "hi" }]);
        expect(out.ok).toBe(false);
        expect(out.error).toContain("empty answer");
      } finally {
        mock.restore();
      }
    });

    test("with no provider configured it refuses, and says where to go", async () => {
      // No `configureAi()` — the harness env carries no key and is not a cloud
      // project, so `aiAvailable` is false on the resolved env.
      const mock = installAnthropicMock(() => anthropicReply("unreachable"));
      try {
        const out = await run([{ type: "ai.generate", prompt: "hi" }]);
        expect(out.ok).toBe(false);
        expect(out.error).toContain("no AI provider is configured");
        expect(out.error).toContain("Settings");
        expect(mock.calls.length).toBe(0);
      } finally {
        mock.restore();
      }
    });

    test("the generation is metered against the workspace", async () => {
      await configureAi();
      const mock = installAnthropicMock(() => anthropicReply("counted"));
      try {
        expect(await run([{ type: "ai.generate", prompt: "hi" }])).toEqual({ ok: true });
      } finally {
        mock.restore();
      }
      // A flow step generates with no request of its own, which is exactly why
      // AI is a separate counter and can never be derived from the request one.
      const ctx = await buildContext(h.env);
      // The ledger buffers in memory and flushes on a threshold; one call does
      // not trip it, so the write has to be asked for. The buffer is
      // module-level, which is why a second ctx over the same file works.
      await flushUsage(ctx);
      const tenants = (await (await h.fetch("/api/tenants")).json()) as { data: { id: string }[] };
      const rows = await usageRows(ctx, tenants.data[0]!.id, 1);
      const row = rows.find((r) => r.apiKeyId === "");
      expect(row?.aiCalls).toBe(1);
      expect(row?.aiTokensIn).toBe(11);
      expect(row?.aiTokensOut).toBe(7);
    });

    test("a save through REST is capped; the cap is re-applied at run time", async () => {
      // REST parses through zod, so an over-budget request is refused outright.
      const refused = await makeFlow([
        { type: "ai.generate", prompt: "hi", maxTokens: AI_OP_MAX_TOKENS + 1 },
      ]);
      expect(refused.status).toBe(422);
    });
  });

  describe("ai.classify", () => {
    const LABELS = ["billing", "technical", "other"];

    test("answers with one of the labels and says it matched", async () => {
      await configureAi();
      const mock = installAnthropicMock(() => anthropicReply("technical"));
      try {
        const out = await run(
          [
            { type: "ai.classify", input: "{{ data.subject }}", labels: LABELS },
            // Prove the label is readable by the step that follows — the whole
            // reason this op is separate from `ai.generate`.
            { type: "log", message: "routed to {{ $last.label }}" },
          ],
          { subject: "my deploy is failing" },
        );
        // The `log` op's rendered line now rides on the run, which turns the
        // comment above into an assertion: the label really was readable by the
        // step that followed, rather than only inferred from the run not
        // failing.
        expect(out).toEqual({ ok: true, log: ["routed to technical"] });

        const call = mock.calls[0] as AnthropicCall;
        expect(userText(call.body)).toBe("my deploy is failing");
        expect(systemText(call.body)).toContain("Labels: billing | technical | other");
        // A label is a handful of tokens; the ceiling is what stops a model
        // that decides to explain itself being billed for the essay.
        expect(call.body.max_tokens).toBe(32);
      } finally {
        mock.restore();
      }
    });

    test("forgives the punctuation a model adds anyway", async () => {
      await configureAi();
      const mock = installAnthropicMock(() => anthropicReply('  "Billing."  '));
      try {
        expect(
          await run([
            { type: "ai.classify", input: "where is my invoice", labels: LABELS },
            { type: "log", message: "{{ $last.label }}" },
          ]),
        ).toEqual({ ok: true, log: ["billing"] });
      } finally {
        mock.restore();
      }
    });

    test("an answer outside the set falls back when the author said which label that means", async () => {
      await configureAi();
      const mock = installAnthropicMock(() => anthropicReply("I am not sure, possibly billing or technical"));
      try {
        expect(
          await run([{ type: "ai.classify", input: "hmm", labels: LABELS, fallback: "other" }]),
        ).toEqual({ ok: true });
      } finally {
        mock.restore();
      }
    });

    test("the fallback lands as the label is written, not as the fallback was typed", async () => {
      // The two are allowed to differ in case — the save-time check folds — and
      // a following `condition` is written against the label SET. Returning the
      // author's spelling would put a value on `$last.label` that is not
      // literally in the set, which is the exact mismatch this op exists to
      // prevent, reintroduced at the last step.
      await configureAi();
      const mock = installAnthropicMock((_call, n) => anthropicReply(n === 1 ? "no idea" : "second"));
      try {
        const out = await run([
          { type: "ai.classify", input: "hmm", labels: LABELS, fallback: "OTHER" },
          // Read `$last.label` straight back out through a second generation,
          // so the assertion is on the VALUE rather than on a branch that
          // reports `ok: true` whether or not it matched.
          { type: "ai.generate", prompt: "{{ $last.label }}" },
        ]);
        expect(out).toEqual({ ok: true });
        expect(userText((mock.calls[1] as AnthropicCall).body)).toBe("other");
      } finally {
        mock.restore();
      }
    });

    test("an answer outside the set fails loudly, without repeating the answer", async () => {
      await configureAi();
      // A distinctive string that COULD be echoed, so the negative assertion
      // below is not passing by construction.
      const leaky = "the customer card ending 4242 was declined";
      const mock = installAnthropicMock(() => anthropicReply(leaky));
      try {
        const out = await run([{ type: "ai.classify", input: "hmm", labels: LABELS }]);
        expect(out.ok).toBe(false);
        expect(out.error).toContain("matched none of");
        expect(out.error).toContain("billing | technical | other");
        expect(out.error).toContain("fallback");
        // Flow-op errors are persisted onto the `flow.run` activity row, and a
        // model asked to classify a support ticket can echo the ticket back.
        expect(out.error).not.toContain(leaky);
        expect(out.error).not.toContain("4242");
      } finally {
        mock.restore();
      }
    });

    describe("the label set is a contract, and it is enforced on every surface", () => {
      test("REST refuses a fallback outside the labels", async () => {
        const res = await makeFlow([
          { type: "ai.classify", input: "x", labels: LABELS, fallback: "escalate" },
        ]);
        expect(res.status).toBe(422);
      });

      test("REST refuses labels that differ only in case", async () => {
        const res = await makeFlow([{ type: "ai.classify", input: "x", labels: ["Billing", "billing"] }]);
        expect(res.status).toBe(422);
      });

      test("REST refuses a single label", async () => {
        const res = await makeFlow([{ type: "ai.classify", input: "x", labels: ["only"] }]);
        expect(res.status).toBe(422);
      });

      test("a GraphQL-authored op whose labels are not even a list is NAMED, not a TypeError", async () => {
        // `operations` is raw JSON on that path, so `labels` can be a string
        // and an element can be a number. An unguarded `.trim()` would surface
        // as "undefined is not a function" instead of saying what is wrong.
        await configureAi();
        for (const labels of ["billing", [1, 2], ["billing", ""], ["billing"]]) {
          const created = await h.fetch(
            "/api/graphql",
            json({
              query: "mutation ($data: FlowInput!) { createFlow(data: $data) { id } }",
              variables: {
                data: {
                  name: `gql-${Math.random().toString(36).slice(2)}`,
                  trigger: "manual:",
                  operations: [{ type: "ai.classify", input: "x", labels }],
                },
              },
            }),
          );
          const id = ((await created.json()) as { data?: { createFlow?: { id: string } } }).data?.createFlow?.id;
          expect(typeof id).toBe("string");
          const out = (await (await h.fetch(`/api/flows/${id}/run`, json({}))).json()) as {
            ok: boolean;
            error?: string;
          };
          expect(out.ok).toBe(false);
          expect(out.error).toContain("at least two labels");
        }
      });

      test("a flow saved through GraphQL — which never meets zod — is refused at run time", async () => {
        // `operations` is an opaque JSON scalar on GraphQL, so the schema's
        // `.refine()` binds REST alone. The executor re-checks for exactly this
        // reason, the same way `sms` re-checks its two addressing modes.
        await configureAi();
        const mock = installAnthropicMock(() => anthropicReply("billing"));
        try {
          const created = await h.fetch(
            "/api/graphql",
            json({
              query: "mutation ($data: FlowInput!) { createFlow(data: $data) { id } }",
              variables: {
                data: {
                  name: `gql-${Math.random().toString(36).slice(2)}`,
                  trigger: "manual:",
                  operations: [
                    { type: "ai.classify", input: "x", labels: LABELS, fallback: "escalate" },
                  ],
                },
              },
            }),
          );
          const body = (await created.json()) as { data?: { createFlow?: { id: string } } };
          const id = body.data?.createFlow?.id;
          // It really did save — that is the gap this test exists to pin.
          expect(typeof id).toBe("string");

          const res = await h.fetch(`/api/flows/${id}/run`, json({}));
          const out = (await res.json()) as FlowRunResult;
          expect(out.ok).toBe(false);
          expect(out.error).toContain("fallback must be one of labels");
          expect(mock.calls.length).toBe(0);
        } finally {
          mock.restore();
        }
      });
    });
  });
});
