/**
 * Test preload: register a happy-dom DOM environment so the React render tests
 * under `tests/client/` have `document` / `window` / etc.
 *
 * This preload runs once for the whole `bun test` process — which also contains
 * the ~600 backend specs. happy-dom's DOM globals (document/window/HTMLElement/
 * DOM Event) are additive and harmless to those. But happy-dom ALSO replaces the
 * networking / streaming / encoding primitives, and Bun's backend specs depend
 * on the native ones (real localhost fetches, SSRF guards, Hono Request/Response,
 * SSE ReadableStream, crypto.subtle, AbortSignal). A native `Request` rejects a
 * happy-dom `AbortSignal` ("signal is not of type AbortSignal"), etc. So we
 * snapshot those primitives before registration and restore them after — leaving
 * happy-dom to own only the DOM layer the render tests actually need.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Web platform primitives the backend relies on — restored to Bun-native after
// happy-dom registers. Intentionally excludes DOM-event types (Event/
// EventTarget) so Testing Library's fireEvent keeps working on happy-dom nodes.
const NATIVE_KEYS = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "WebSocket",
  "AbortController",
  "AbortSignal",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextEncoder",
  "TextDecoder",
  "Blob",
  "File",
  "FormData",
  "URL",
  "URLSearchParams",
  "crypto",
  "structuredClone",
] as const;

const g = globalThis as unknown as Record<string, unknown>;
const native: Record<string, unknown> = {};
for (const k of NATIVE_KEYS) native[k] = g[k];

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register();
}

for (const k of NATIVE_KEYS) {
  if (native[k] !== undefined) g[k] = native[k];
}

// React 19 + Testing Library: flag this as an act() environment so state
// updates flush deterministically and act() warnings stay meaningful.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
