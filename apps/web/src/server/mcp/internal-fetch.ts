import type { Hono } from "hono";
import type { Env } from "../env";

/**
 * The `Request` objects this module hands to `app.fetch`.
 *
 * A sub-request re-enters the whole middleware stack on a path like
 * `/api/items/<slug>`, so a guard that asks "is this path an MCP mount?" would
 * answer NO for the very calls the MCP dispatcher makes on a caller's behalf —
 * and refusing those breaks MCP for the credential the guard exists to bound
 * (`middleware/credential-scope.ts`). This set is how such a guard tells "the
 * MCP layer already vetted this call" from "someone posted a bearer at REST".
 *
 * It is a `WeakSet` keyed on object IDENTITY, and that is the whole security
 * argument: an external caller can send any header they like, but they cannot
 * hand us a `Request` instance that we ourselves already put in this set.
 * Entries disappear with the request object, so nothing accumulates.
 */
const internalRequests = new WeakSet<Request>();

/** Mark a request as one this process issued against its own router. */
const markInternal = (req: Request): Request => {
  internalRequests.add(req);
  return req;
};

/** Did this process issue the request against its own router? Unforgeable from
 *  the wire — see {@link internalRequests}. */
export const isInternalRequest = (req: Request): boolean =>
  internalRequests.has(req);

/** Build a forwarder that calls the Hono `app` with the original MCP
 *  request's identity (Authorization, Cookie, X-Backlex-Tenant). Every
 *  layer of middleware re-runs against the sub-request, so permissions,
 *  tenant resolution, CORS, and validation behave exactly as they would
 *  for a direct HTTP call. */
export const makeInternalFetch = (
  app: Hono,
  originRequest: Request,
  env: Env,
): ((path: string, init?: RequestInit) => Promise<Response>) => {
  const originUrl = new URL(originRequest.url);
  const auth = originRequest.headers.get("authorization");
  const cookie = originRequest.headers.get("cookie");
  const tenant = originRequest.headers.get("x-backlex-tenant");
  const xff = originRequest.headers.get("x-forwarded-for");
  const ip = originRequest.headers.get("cf-connecting-ip");

  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const subUrl = new URL(path, originUrl.origin);
    const headers = new Headers(init.headers ?? {});
    if (auth && !headers.has("authorization")) headers.set("authorization", auth);
    if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
    if (tenant && !headers.has("x-backlex-tenant"))
      headers.set("x-backlex-tenant", tenant);
    if (xff && !headers.has("x-forwarded-for")) headers.set("x-forwarded-for", xff);
    if (ip && !headers.has("cf-connecting-ip"))
      headers.set("cf-connecting-ip", ip);
    const req = markInternal(new Request(subUrl.toString(), { ...init, headers }));
    return app.fetch(req, env);
  };
};

/**
 * The same forwarder for work that has **no live request** to inherit from —
 * an agent turn running in the background after its HTTP response has returned.
 *
 * Identity comes from a short-lived agent-run token (see `lib/jwt`) instead of
 * the caller's cookie, and the tenant is pinned explicitly. Everything else is
 * identical: the sub-request re-enters the full middleware stack, so roles,
 * permissions, and tenant membership are resolved from the DB exactly as they
 * would be for a direct HTTP call — the turn cannot outlive its caller's access.
 */
export const makeDetachedFetch = (
  app: Hono,
  env: Env,
  opts: { origin: string; token: string; tenantId: string },
): ((path: string, init?: RequestInit) => Promise<Response>) => {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const subUrl = new URL(path, opts.origin);
    const headers = new Headers(init.headers ?? {});
    if (!headers.has("authorization"))
      headers.set("authorization", `Bearer ${opts.token}`);
    if (!headers.has("x-backlex-tenant"))
      headers.set("x-backlex-tenant", opts.tenantId);
    const req = markInternal(new Request(subUrl.toString(), { ...init, headers }));
    return app.fetch(req, env);
  };
};

/** Parse a Response as JSON and either return the parsed `data` slice or
 *  throw an Error carrying the upstream error code + message. MCP tools
 *  generally surface the upstream HTTP shape verbatim so the caller can
 *  trust the message even when an LLM relays it. */
export const readJson = async <T = unknown>(res: Response): Promise<T> => {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`upstream returned non-JSON (status ${res.status})`);
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    const code = err?.code ?? `HTTP_${res.status}`;
    const message = err?.message ?? `upstream failed (status ${res.status})`;
    throw new Error(`${code}: ${message}`);
  }
  return body as T;
};
