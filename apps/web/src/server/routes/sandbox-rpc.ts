import { Hono } from "hono";
import { z } from "zod";
import { AppError, type AuthSubject } from "@backlex/core";
import type { AppBindings } from "../app";
import { dispatchRpc } from "../services/sandbox/host-bridge";
import type { RpcOp } from "../services/sandbox/types";
import { verifySandboxGrant } from "../lib/crypto";
import { readJson } from "../lib/body";

const Body = z.object({
  // A copy of `RpcOp` (services/sandbox/types.ts), which is the canonical list.
  // Forgetting an op here breaks it on the remote-http executor ALONE — the
  // callback 422s — and on no other provider.
  op: z.enum(["fetch", "db.list", "db.one", "email.send", "push.send", "ai.generate"]),
  args: z.unknown().optional(),
  auth: z.object({
    userId: z.string().nullable(),
    email: z.string().nullable(),
    roles: z.array(z.string()),
    // Read ONLY on the legacy shared-secret path (see below). When the bearer
    // is a grant this whole object is ignored — the subject comes from the
    // signature.
    tenantId: z.string().nullable().optional(),
  }),
});

/**
 * Ops with nothing but the subject standing behind them.
 *
 * `fetch` is bounded by `FUNCTIONS_FETCH_ALLOW` and `db.list` / `db.one`
 * re-resolve the caller's permissions from the DATABASE for (userId, tenantId),
 * so a forged subject buys an attacker no more than naming a real user id.
 * These three have no such second check: `email.send` goes out over whatever
 * transport the named workspace configured, from its verified sender;
 * `push.send` reaches that workspace's devices; `ai.generate` spends its
 * budget. They are the reason the subject has to be signed rather than stated.
 */
const GRANT_ONLY_OPS: ReadonlySet<string> = new Set([
  "email.send",
  "push.send",
  "ai.generate",
]);

/** Compare two secrets without leaking their common prefix through timing.
 *  Length is not secret here (both sides are hex of a known width), so the
 *  early return on mismatched length is fine. */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * Internal endpoint used **only** by the `remote-http` executor service to
 * proxy `ctx.fetch / ctx.db / ctx.email` calls back into the main app.
 *
 * ## Who the call is running as
 *
 * The executor is a soft sandbox running user-authored code, so the request
 * body is attacker-controlled: a function author can read the executor's own
 * bearer off an outbound callback (wrap `globalThis.fetch`, call `ctx.db`) and
 * then replay it with any `auth` it likes. This route therefore does NOT take
 * the subject from the body.
 *
 * Instead `providers/remote-http.ts` mints a short-lived signed grant per
 * invocation, carrying (userId, email, roles, tenantId), and passes it as the
 * `/run` body's `rpcToken`. The executor already echoes that field back as its
 * bearer, so the wire format did not change — but the subject now arrives
 * signed by the main app and `body.auth` is ignored.
 *
 * ## The legacy path
 *
 * A hand-built executor that sends `SANDBOX_RPC_TOKEN` from its own env rather
 * than the `rpcToken` it was handed still authenticates, and still reads its
 * subject from the body — because that subject cannot be verified, the three
 * ops that have no second check (see {@link GRANT_ONLY_OPS}) are refused on
 * that path. Forward the `/run` body's `rpcToken` and they come back.
 */
export const sandboxRpcRoutes = new Hono<AppBindings>().post("/", async (c) => {
  const ctx = c.get("ctx");
  const expected = ctx.env.SANDBOX_RPC_TOKEN;
  if (!expected) {
    throw new AppError(
      "FORBIDDEN",
      "SANDBOX_RPC_TOKEN is not configured; sandbox RPC disabled",
    );
  }
  const header = c.req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

  // Grant first: it is what the shipped provider sends. The shared secret is
  // only reached when the presented value is not a valid grant, so the two
  // never race and a grant is never mistaken for the raw secret.
  const grant = presented ? await verifySandboxGrant(presented, expected) : null;
  if (!grant && !(presented && timingSafeEqual(presented, expected))) {
    throw new AppError("UNAUTHORIZED", "invalid sandbox RPC token");
  }

  const body = Body.parse(await readJson(c.req));

  if (!grant && GRANT_ONLY_OPS.has(body.op)) {
    // Delivered the way every other refusal on this bridge is — 200 with
    // `{ok:false}` — so the executor's proxy turns it into a thrown Error whose
    // MESSAGE reaches the function's logs. A 4xx would reach the operator as
    // "sandbox-rpc http 403" and name nothing.
    return c.json(
      {
        ok: false,
        error:
          `${body.op} needs the per-invocation token from the /run body's \`rpcToken\`, ` +
          "which carries the workspace this run belongs to. This request presented " +
          "the raw SANDBOX_RPC_TOKEN, whose holder could name any workspace — " +
          "forward `rpcToken` instead (the shipped fn-exec-server template already does).",
      },
      200,
    );
  }

  const subject: AuthSubject = grant
    ? { userId: grant.u, email: grant.e, roles: grant.r, tenantId: grant.t }
    : body.auth;

  try {
    const value = await dispatchRpc(
      { ctx, auth: subject },
      body.op as RpcOp,
      body.args,
    );
    return c.json({ ok: true, value });
  } catch (e) {
    return c.json(
      { ok: false, error: (e as Error).message },
      // 200 from the HTTP perspective — the executor still got an answer.
      // The {ok: false} body is what its proxy turns into a thrown Error.
      200,
    );
  }
});
