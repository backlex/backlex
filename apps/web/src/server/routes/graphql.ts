import { Hono } from "hono";
import { createYoga } from "graphql-yoga";
import type { AppBindings } from "../app";
import { getSchema } from "../services/graphql";

export const graphqlRoutes = new Hono<AppBindings>().all("/", async (c) => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  const schema = await getSchema(ctx);
  const yoga = createYoga({
    schema,
    graphqlEndpoint: "/api/graphql",
    context: () => ({ ctx, auth }),
    landingPage: false,
    graphiql: { defaultQuery: "{ _empty }" },
  });
  return yoga.fetch(c.req.raw);
});
