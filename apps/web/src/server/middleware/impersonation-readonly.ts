/**
 * A read-only impersonation may change NOTHING, on any surface.
 *
 * WHAT THIS REPLACES
 *
 * Read-only was enforced in exactly one place: `middleware/permission.ts`
 * refuses a non-read action when `auth.impersonationReadOnly` is set, and its
 * comment gives the right reason — "this is the one place every collection
 * action already passes through". The reason is right and the conclusion is
 * incomplete, because it only covers what is COLLECTION-scoped. Every
 * app-plane surface that is not a collection walked straight past it: measured
 * before this middleware existed, a read-only impersonation POSTed
 * `/api/t/{slug}/orgs` and created an organization (201) with the same token
 * that was correctly refused a 403 on an item write.
 *
 * That gap is not a footnote. "Read-only" is what the impersonation UI defaults
 * to and what an operator relies on when they step inside a customer's account
 * to look at a ticket. Under it they could restructure that customer's
 * organizations and evict its members — actions attributed to the SUBJECT, in
 * tables that carry no audit trail of their own.
 *
 * So the question is asked once, centrally, off the HTTP method: a read-only
 * impersonation gets GET / HEAD / OPTIONS and nothing else. The method is the
 * right discriminator because it is the one property every route on every
 * surface already has, and because a NEW route inherits the answer without
 * anybody remembering this file exists.
 *
 * WHY THE PER-ROUTE GATE STAYS
 *
 * `permission.ts` keeps its check, and so do the write services that carry
 * `impersonationReadOnly` into `services/items/write.ts`. Two layers is the
 * same belt-and-braces reasoning `plane-firewall.ts` uses: this one is broad
 * and driven by a method, those are narrow and driven by each handler's own
 * reading of what it does. The lesson being applied is that ONE layer being
 * right is what let the other layers be wrong.
 *
 * Unlike the plane firewall, this one has no warn window. The plane table was a
 * first draft over ~110 mount prefixes and an `enforce` default risked an
 * outage for a paying tenant; this rule is one line — an operator who declared
 * read-only writes nothing — and the population it can inconvenience is
 * operators inside a support session, who can start a `readOnly: false` one.
 * Failing open here would leave the defect it exists to close.
 */
import type { MiddlewareHandler } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";

/** Methods that cannot, by their own definition, change the subject's data.
 *  Everything else is refused unless it appears in `READS_BEHIND_A_POST`. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The exceptions, each one decided explicitly rather than pattern-matched.
 *
 * A blanket "no POST" is wrong in two directions: it would strand the operator
 * inside the session they asked to be read-only, and it would refuse reads that
 * happen to need a request body. Nothing lands here because it is convenient —
 * an entry has to be either the operator's own exit, or a route whose only
 * effect is to compute an answer the caller could already have read.
 *
 * `*` matches exactly ONE path segment, the same convention `lib/route-planes.ts`
 * uses, so `/api/items/*​/search` cannot be widened by a slug carrying a slash.
 */
const READS_BEHIND_A_POST: ReadonlyArray<{
  method: string;
  pattern: string;
  why: string;
}> = [
  {
    method: "POST",
    pattern: "/api/admin/impersonation/*/end",
    why:
      "The operator's exit. A gate that can seal someone into a session they " +
      "declared read-only is a worse bug than the one being fixed, so this stays " +
      "reachable no matter what. (Today `requireAdminMiddleware` on that route " +
      "refuses any impersonated session outright — the operator ends it from " +
      "their OWN platform session, whose `impersonationReadOnly` is false and " +
      "which therefore never reaches this middleware at all. The allowance is " +
      "here so that the exit does not become unreachable if that route is ever " +
      "opened to the session itself.)",
  },
  {
    method: "POST",
    pattern: "/api/graphql",
    why:
      "GraphQL takes queries and mutations through the same POST, so refusing " +
      "the method refuses reading. Deciding it here would mean parsing the " +
      "document, and `graphql`'s parser is exactly what app.ts keeps out of the " +
      "cold-start path by mounting `/api/graphql` through a dynamic import — a " +
      "check here would drag the whole yoga dependency graph into every request. " +
      "So this one route is left to the layer underneath: mutations reach " +
      "`services/items/write.ts`, which refuses a read-only impersonation on its " +
      "own, and `captcha-impersonation.test.ts` proves a GraphQL mutation is " +
      "refused with the read-only message.",
  },
  {
    method: "POST",
    pattern: "/api/items/*/search",
    why:
      "Full-text / vector / hybrid ranking. Carries `requirePermission(slug, \"read\")` " +
      "and writes nothing; it is a POST only because the query object does not fit " +
      "in a URL. Searching is the single most likely thing an operator does inside " +
      "a support session.",
  },
  {
    method: "POST",
    pattern: "/api/items/*/aggregate",
    why:
      "count / sum / avg / min / max over rows the caller may already read, behind " +
      "the same `read` permission. Same shape as search: a POST body carrying a " +
      "question, not a change.",
  },
  {
    method: "POST",
    pattern: "/api/vector/query",
    why: "Similarity search over an existing index. Permission-gated read; writes nothing.",
  },
  {
    method: "POST",
    pattern: "/api/vector/search",
    why: "As /api/vector/query — the collection-scoped form of the same read.",
  },
];

/**
 * Read-shaped POSTs that are deliberately NOT allowed, so the next reader knows
 * they were considered rather than missed:
 *
 * - `/api/geo/geocode`, `/api/geo/reverse`, `/api/phone/normalize/*`,
 *   `/api/email/normalize/*` — pure computations, but they are field-EDITOR
 *   helpers: they exist to prepare a value for a write that a read-only session
 *   is not going to make, and geocoding spends the workspace's third-party
 *   quota. Refusing them costs an operator nothing they can see.
 * - `/api/t/*​/orgs/set-active` — pins an org onto the session row. An
 *   impersonation's `sid` is the synthetic `imp:<row-id>`, not an `app_sessions`
 *   id, so this never worked for one anyway; the supported way to look at
 *   another org through an impersonation is the `X-Backlex-Org` header, which
 *   rides on a GET.
 * - `/mcp` and `/api/mcp` — JSON-RPC multiplexes reads and writes over one POST,
 *   the same problem GraphQL has, without GraphQL's excuse: its tools replay the
 *   HTTP router through `makeInternalFetch`, so a read tool through MCP is a
 *   convenience an operator can get from the route it wraps. Refused whole.
 */

/** `*` matches exactly one segment; every other segment must match literally. */
const matches = (pattern: string, path: string): boolean => {
  const p = pattern.split("/");
  const s = path.split("/");
  if (p.length !== s.length) return false;
  return p.every((seg, i) => seg === "*" || seg === s[i]);
};

const allowed = (method: string, path: string): boolean =>
  READS_BEHIND_A_POST.some((e) => e.method === method && matches(e.pattern, path));

export const impersonationReadOnlyGate: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  const auth = c.get("auth");
  // Note the shape: this keys on the FLAG, never on impersonation as such. A
  // `readOnly: false` impersonation is an operator who deliberately said they
  // are acting on the customer's behalf, and it must keep working exactly as it
  // does today — otherwise the feature has no non-read mode left.
  if (!auth?.impersonationReadOnly) return next();

  const method = c.req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return next();

  const path = new URL(c.req.url).pathname;
  if (allowed(method, path)) return next();

  throw new AppError(
    "FORBIDDEN",
    `This is a read-only impersonation — ${method} ${path} is refused. ` +
      "Start one with `readOnly: false` if acting on the customer's behalf is intended.",
  );
};
