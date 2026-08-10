/**
 * The switch that closes dynamic client registration.
 *
 * The better-auth `mcp` plugin owns `/api/auth/mcp/register`, and it is OPEN by
 * design — that is what lets a hosted MCP connector introduce itself without an
 * operator pre-registering it, and it is the reason the endpoint exists at all.
 *
 * An instance run as a company identity provider wants the opposite: a fixed
 * set of clients somebody approved. There is no plugin option for that, so the
 * refusal sits in front of the mount, where the lockout and captcha gates sit,
 * and answers in the shape RFC 7591 clients expect rather than ours.
 */
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { dynamicRegistrationEnabled } from "../services/oauth-clients";

const REGISTER = /^\/api\/auth\/mcp\/register(\/|$)/i;

export const dynamicRegistrationGate: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.req.method !== "POST" || !REGISTER.test(new URL(c.req.raw.url).pathname)) {
    return next();
  }
  if (dynamicRegistrationEnabled(c.get("ctx").env)) return next();
  // RFC 7591 §3.2.2 shape. A client that gets our JSON envelope here reports
  // an unknown failure; this one it can explain to whoever ran it.
  return new Response(
    JSON.stringify({
      error: "access_denied",
      error_description:
        "Dynamic client registration is disabled on this instance. An administrator registers clients.",
    }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
};
