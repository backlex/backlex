/**
 * Stand a plain handler in for the global `fetch`.
 *
 * Bun's `fetch` is a function WITH properties — `preconnect` at minimum — so a
 * bare `(input, init) => Promise<Response>` is not a `typeof fetch`, and
 * TypeScript refuses even the explicit `as` once the stub's signature has
 * drifted far enough (a zero-argument `async () => …`, the shape most of these
 * stubs take).
 *
 * `preconnect` is a NO-OP rather than a pass-through to the real one, and that
 * is the whole subtlety here. The first draft captured `globalThis.fetch` at
 * module load and forwarded to its `preconnect`. That works when the file is
 * run alone and fails 51 tests in the full suite: `bun test` runs
 * `--no-isolate`, so this module is initialised ONCE per worker, at whatever
 * moment the first importer is loaded — which may be after some other spec's
 * `beforeEach` has already put its own bare stub on `globalThis.fetch`. The
 * captured "real" fetch was then a stub with no `preconnect`, and every
 * `asFetch` call threw.
 *
 * A no-op is also the right semantics on its own terms: warming a connection
 * to a host that a fake is going to answer for is meaningless, and nothing
 * under test reads a return value from it.
 */
export type FetchStub = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response> | Response;

export const asFetch = (impl: FetchStub): typeof fetch =>
  Object.assign(impl, { preconnect: () => {} }) as unknown as typeof fetch;
