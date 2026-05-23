import type { Context, MiddlewareHandler } from "hono";
import type { Action } from "@workeros/core";
import { AppError } from "@workeros/core";
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

export const requirePermission =
  (collection: CollectionResolver, action: Action): MiddlewareHandler<AppBindings> =>
  async (c, next) => {
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
    c.set("permission", result);
    await next();
  };
