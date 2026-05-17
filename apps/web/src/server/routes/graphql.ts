import { Hono } from "hono";
import { createYoga } from "graphql-yoga";
import { AppError } from "@workeros/core";
import type { AppBindings } from "../app";
import { getSchema } from "../services/graphql";

export const graphqlRoutes = new Hono<AppBindings>().all("/", async (c) => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  if (!auth.tenantId) {
    throw new AppError("UNAUTHORIZED", "Active tenant required");
  }
  const schema = await getSchema(ctx, auth.tenantId);
  const yoga = createYoga({
    schema,
    graphqlEndpoint: "/api/graphql",
    context: () => ({ ctx, auth }),
    landingPage: false,
    graphiql: { defaultQuery: "{ _empty }" },
    // Temporary: surface the real error message instead of `Unexpected
    // error` so we can diagnose the introspection failure on the live
    // worker. Revert once stable.
    maskedErrors: false,
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
});
