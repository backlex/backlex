/**
 * The AI SDK, and everything that touches it, behind one module.
 *
 * `ai` plus the four provider packages are ~860 KiB — the largest single thing
 * left in the worker's eager graph after the catalog/OpenAPI/better-auth split,
 * and Cloudflare charges for it at every cold start (error 10021, `Script
 * startup exceeded CPU time limit`, is a hard deploy failure). Nothing on the
 * request path needs it: a deployment with no AI configured never reaches this
 * module at all, and one that does pays for it on its first generation instead
 * of on every isolate boot.
 *
 * So `ai-client.ts` keeps the whole public surface and imports NOTHING from the
 * SDK; the two functions that actually generate (`callClaude`, `callClaudeTools`
 * — both already async) `await import()` this file. `modelFor` lives here too
 * because constructing a provider is the SDK, not a decision about which one to
 * construct: that part stays synchronous in `ai-client.ts` where the routes
 * read it.
 *
 * The `import()` is only half the change. `vite.config.ts::workerManualChunks`
 * ends in `return "vendor"`, which pins every un-listed `node_modules` module
 * into the eager chunk regardless of how it was imported — without the matching
 * branch there, this file buys nothing.
 */
import { createGateway } from "@ai-sdk/gateway";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { AiCredential } from "./ai-client";

export { generateText, jsonSchema, tool } from "ai";

/** What `jsonSchema()` accepts, so `ai-client.ts` can name the type without a
 *  runtime import of the SDK. */
export type JsonSchemaInput = Parameters<typeof import("ai").jsonSchema>[0];

/** Build the AI-SDK model for a resolved credential. An OAuth token uses the
 *  provider's `authToken` option, which sends `Authorization: Bearer` and
 *  omits `x-api-key` — sending both is rejected by the API. */
export const modelFor = (cred: AiCredential, modelId: string) => {
  switch (cred.kind) {
    case "gateway":
      return createGateway({ apiKey: cred.key })(modelId);
    case "openai":
      return createOpenAI({ apiKey: cred.key })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey: cred.key })(modelId);
    default:
      return cred.oauth
        ? createAnthropic({ authToken: cred.key })(modelId)
        : createAnthropic({ apiKey: cred.key })(modelId);
  }
};
