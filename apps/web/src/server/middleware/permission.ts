import type { Context, MiddlewareHandler } from "hono";
import type { Action } from "@backlex/core";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import {
  resolvePermission,
  type PermResolveCache,
  type ResolvedPermission,
} from "../services/permissions";

export type PermissionVar = ResolvedPermission;

type CollectionResolver = string | ((c: Context<AppBindings>) => string);

/** Lazily attach (and return) the per-request L1 permission cache. Reused by
 *  every `requirePermission` middleware on a route + any service that pulls
 *  it off `c.var.permCache` (GraphQL, expand, etc.) so multiple lookups in
 *  one request collapse to zero extra DB work. */
export const getRequestPermCache = (
  c: Context<AppBindings>,
): PermResolveCache => {
  let cache = c.get("permCache");
  if (!cache) {
    cache = new Map();
    c.set("permCache", cache);
  }
  return cache;
};

/**
 * The returned handler is a NAMED FUNCTION EXPRESSION, and both halves of that
 * matter.
 *
 * Hono's `app.routes` records every registered handler, and the only thing it
 * carries about one is its function name — so an anonymous middleware is a gate
 * no registry can see. This factory used to return a bare arrow, which made the
 * most-applied authorization gate in the product read as `(anonymous)` from the
 * route table: every `/api/items/*` route looked ungated to anything auditing
 * the router, while `requireUser` and `requireAdmin` (plain top-level consts)
 * showed up by name.
 *
 * `const mw: MiddlewareHandler = async (c, next) => …` is NOT enough here.
 * Measured under Bun 1.4.2: a top-level const arrow keeps its name, and a const
 * arrow declared INSIDE a function comes out as `""`. Only an explicit function
 * expression name survives both. Name any future gate factory this way, and
 * check it — a registry keyed on names fails silent when one goes missing.
 */
export const requirePermission = (
  collection: CollectionResolver,
  action: Action,
): MiddlewareHandler<AppBindings> => {
  const mw: MiddlewareHandler<AppBindings> = async function requirePermissionMw(c, next) {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const slug =
      typeof collection === "function"
        ? collection(c as Context<AppBindings>)
        : collection;
    const result = await resolvePermission(
      ctx,
      auth,
      slug,
      action,
      getRequestPermCache(c as Context<AppBindings>),
    );
    if (!result.allowed) {
      throw new AppError(
        auth.userId ? "FORBIDDEN" : "UNAUTHORIZED",
        auth.userId
          ? `No permission to ${action} on "${slug}"`
          : "Sign in required",
      );
    }
    // A read-only impersonation may see everything the subject sees and change
    // none of it. Enforced HERE rather than in each write handler, because
    // this is the one place every collection action already passes through —
    // and a gate that has to be remembered per route is a gate that is missed.
    if (auth.impersonationReadOnly && action !== "read") {
      throw new AppError(
        "FORBIDDEN",
        `This is a read-only impersonation — "${action}" on "${slug}" is refused. ` +
          "Start one with `readOnly: false` if acting on the customer's behalf is intended.",
      );
    }
    c.set("permission", result);
    await next();
  };
  return mw;
};
