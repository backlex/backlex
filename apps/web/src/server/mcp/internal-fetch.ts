import type { Hono } from "hono";
import type { Env } from "../env";

/** Build a forwarder that calls the Hono `app` with the original MCP
 *  request's identity (Authorization, Cookie, X-Workeros-Tenant). Every
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
  const tenant = originRequest.headers.get("x-workeros-tenant");
  const xff = originRequest.headers.get("x-forwarded-for");
  const ip = originRequest.headers.get("cf-connecting-ip");

  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const subUrl = new URL(path, originUrl.origin);
    const headers = new Headers(init.headers ?? {});
    if (auth && !headers.has("authorization")) headers.set("authorization", auth);
    if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
    if (tenant && !headers.has("x-workeros-tenant"))
      headers.set("x-workeros-tenant", tenant);
    if (xff && !headers.has("x-forwarded-for")) headers.set("x-forwarded-for", xff);
    if (ip && !headers.has("cf-connecting-ip"))
      headers.set("cf-connecting-ip", ip);
    const req = new Request(subUrl.toString(), { ...init, headers });
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
