/**
 * The managed-cloud AI path, and the two places the OSS side disagreed with
 * itself about whether a workspace "has AI".
 *
 * On a provisioned cloud project the customer brings no AI key: generation runs
 * on the platform's Workers AI through the control-plane gateway. `callClaude`
 * models that correctly — no direct credential plus a configured cloud means
 * the gateway. Everything ELSE that asked "is AI available here?" asked only
 * about a direct credential, so the answer was no on exactly the deployment
 * where AI is a platform feature.
 *
 * These are unit tests against the resolver rather than route tests, because
 * what is wrong is a predicate, and a route test would need a live gateway to
 * show it.
 */
import { describe, expect, test } from "bun:test";
import {
  aiAvailable,
  callClaude,
  hasDirectAiCredential,
  resolveModelId,
} from "../src/server/mcp/ai-client";
import type { Env } from "../src/server/env";

const env = (over: Partial<Env>): Env => ({ ...over }) as Env;

/** A provisioned managed-cloud project: no AI key of its own, but a control
 *  plane to route generation through. */
const cloudProject = env({
  CLOUD_REPORT_SECRET: "shh",
  CLOUD_PROJECT_ID: "proj_1",
  CLOUD_REPORT_URL: "https://app.backlex.com",
});

describe("is AI available on this deployment", () => {
  test("a cloud project has no direct credential — that part was right", () => {
    expect(hasDirectAiCredential(cloudProject)).toBe(false);
  });

  test("…but AI IS available there, through the gateway", () => {
    // The bug this pins: `ai.*` MCP tools guarded on `hasDirectAiCredential`
    // and refused with "No AI provider configured for this workspace" on every
    // managed-cloud project — while `callClaude`, reached by the very same
    // request a moment later, would have routed it to the gateway. An agent
    // could not use the tools on the one deployment where AI needs no setup.
    expect(aiAvailable(cloudProject)).toBe(true);
  });

  test("self-host with no key at all still has no AI", () => {
    expect(aiAvailable(env({}))).toBe(false);
  });

  test("a direct key is enough on its own", () => {
    expect(aiAvailable(env({ ANTHROPIC_API_KEY: "sk-ant-x" }))).toBe(true);
    expect(aiAvailable(env({ AI_GATEWAY_API_KEY: "gw-x" }))).toBe(true);
  });

  test("a workspace that brought its own key on cloud is available both ways", () => {
    expect(aiAvailable({ ...cloudProject, ANTHROPIC_API_KEY: "sk-ant-x" } as Env)).toBe(true);
  });
});

describe("what the cloud gateway reports comes back", () => {
  // The control plane meters this call authoritatively and answers
  // `{ model, response, neurons }`. The OSS side read `response` and dropped
  // the rest, so a managed-cloud generation was the one path in the product
  // that reported no cost at all — `structuredContent.usage` simply absent,
  // which reads as "free" rather than "measured elsewhere".
  //
  // Neurons rather than tokens on purpose: the gateway computes tokens for its
  // own metering but does not return them, and inventing a token count from a
  // neuron count would be a number nobody could reconcile with a bill.
  /** A control plane reachable over a service binding, so the call is
   *  intercepted without touching global `fetch`. */
  const gatewayAnswering = (body: unknown, status = 200) => {
    const seen: Array<Record<string, unknown>> = [];
    const env = {
      CLOUD_REPORT_SECRET: "shh",
      CLOUD_PROJECT_ID: "proj_1",
      CLOUD_REPORT_SERVICE: {
        fetch: async (req: Request) => {
          seen.push((await req.json()) as Record<string, unknown>);
          return new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });
        },
      },
    } as unknown as Env;
    return { env, seen };
  };

  test("a neuron count is surfaced as usage", async () => {
    const { env: cloudEnv } = gatewayAnswering({
      model: "@cf/meta/llama",
      response: "hi",
      neurons: 42,
    });

    const res = await callClaude(cloudEnv, { system: "s", user: "u", maxTokens: 64 });

    expect(res.text).toBe("hi");
    expect(res.usage?.neurons).toBe(42);
  });

  test("a gateway that reports no cost yields no usage — not a zero", async () => {
    // "Absent" and "zero" are different claims, and only one of them is true
    // when the gateway did not say.
    const { env: cloudEnv } = gatewayAnswering({ response: "hi" });
    const res = await callClaude(cloudEnv, { system: "s", user: "u" });
    expect(res.text).toBe("hi");
    expect(res.usage).toBeUndefined();
  });
});

describe("a hardcoded Anthropic model id on a direct non-Anthropic key", () => {
  // `resolveModelId` passes a bare model id through to a direct provider
  // untouched — correct for `gpt-5` on an OpenAI key, and the reason a
  // hardcoded `claude-sonnet-4-6` in provider-agnostic code became a 404: the
  // id names a model that provider does not have. There is no registry that
  // could tell those two apart, so the fix is not to name a model at all.
  test("the bare id is forwarded verbatim — nothing rescues it", () => {
    expect(resolveModelId("openai", "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  test("omitting the model asks the configured provider for its own default", () => {
    const openai = resolveModelId("openai", undefined);
    expect(openai).not.toBe("claude-sonnet-4-6");
    expect(openai.startsWith("gpt")).toBe(true);

    const google = resolveModelId("google", undefined);
    expect(google).not.toBe("claude-sonnet-4-6");
  });

  test("the gateway namespaces a bare id, so it was only ever safe there", () => {
    expect(resolveModelId("gateway", "claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6");
  });
});
