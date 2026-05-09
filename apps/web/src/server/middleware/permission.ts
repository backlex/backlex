import type { Context, MiddlewareHandler } from "hono";
import type { Action } from "@workeros/core";
import { AppError } from "@workeros/core";
import type { AppBindings } from "../app";
import {
  resolvePermission,
  type ResolvedPermission,
} from "../services/permissions";

export type PermissionVar = ResolvedPermission;

type CollectionResolver = string | ((c: Context<AppBindings>) => string);

export const requirePermission =
  (collection: CollectionResolver, action: Action): MiddlewareHandler<AppBindings> =>
  async (c, next) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const slug =
      typeof collection === "function"
        ? collection(c as Context<AppBindings>)
        : collection;
    const result = await resolvePermission(ctx, auth, slug, action);
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
