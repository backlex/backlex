import { AppError } from "@backlex/core";
import { createYoga } from "graphql-yoga";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import { getRequestPermCache } from "../middleware/permission";
import { getSchema } from "../services/graphql";

/**
 * GraphQL request handler. app.ts mounts this via a **dynamic import** so the
 * whole graphql-yoga + graphql + @graphql-tools dependency graph (a large slice
 * of the worker bundle) stays OUT of the cold-start eval path — it loads only
 * when `/api/graphql` is first hit, then the module is cached per isolate.
 */
export const handleGraphql = async (
  c: Context<AppBindings>,
): Promise<Response> => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  if (!auth.tenantId) {
    throw new AppError("UNAUTHORIZED", "Active tenant required");
  }
  const schema = await getSchema(ctx, auth.tenantId);
  const permCache = getRequestPermCache(c);
  const yoga = createYoga({
    schema,
    graphqlEndpoint: "/api/graphql",
    context: () => ({ ctx, auth, permCache }),
    landingPage: false,
    graphiql: { defaultQuery: "{ _empty }" },
  });
  // yoga returns a Response with a ReadableStream body. Returning it
  // directly through Hono on Cloudflare workers serializes the body as
  // the literal string `[object ReadableStream]`. Drain to text and
  // forward as a fresh Response so the client gets the actual payload.
  const res = await yoga.fetch(c.req.raw);
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: res.headers,
  });
};
