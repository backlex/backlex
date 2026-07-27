/**
 * `GET /.well-known/jwks.json` — the public half of the app-plane token
 * signing key, in JWK Set form (RFC 7517).
 *
 * Deliberately public, CORS-open and cacheable: it exists so a *third party* —
 * an edge worker, a partner backend, another service in the mesh — can verify a
 * backlex access token locally instead of calling back here on every request.
 *
 * Returns `{"keys": []}` rather than a 404 when the instance signs symmetrically
 * (no `AUTH_JWT_PRIVATE_KEY`). An empty set is the standard-friendly way for a
 * client to discover "nothing here to verify with", and it keeps the endpoint's
 * shape stable across a later rollout of key-pair signing.
 */

import { Hono } from "hono";
import type { AppBindings } from "../app";
import { jwksDocument } from "../lib/jwt-keys";

export const jwksRoutes = () => {
  const router = new Hono<AppBindings>();
  // The global CORS middleware skips `/.well-known/*` (it's credentialed, and
  // would replace the wildcard below with a single origin), so the preflight
  // answer is ours to give.
  router.options("/jwks.json", () =>
    new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "Accept, Content-Type",
        "access-control-max-age": "86400",
      },
    }),
  );
  router.get("/jwks.json", async (c) => {
    const doc = await jwksDocument(c.get("ctx").env);
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: {
        "content-type": "application/jwk-set+json",
        "access-control-allow-origin": "*",
        // Short enough that a rotation propagates quickly, long enough that a
        // verifier isn't refetching per request.
        "cache-control": "public, max-age=300",
      },
    });
  });
  return router;
};
