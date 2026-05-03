import { Hono } from "hono";
import { AppError } from "@workeros/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

export const storageRoutes = new Hono<AppBindings>()
  .get("/", async (c) => {
    const { storage } = c.get("ctx");
    const prefix = c.req.query("prefix") ?? "";
    return c.json({ data: await storage.list(prefix) });
  })
  .put("/:key{.+}", requireUser, async (c) => {
    const { storage } = c.get("ctx");
    const key = c.req.param("key");
    const contentType = c.req.header("content-type") ?? undefined;
    const body = c.req.raw.body;
    if (!body) throw new AppError("BAD_REQUEST", "Empty body");
    const obj = await storage.put({ key, body, contentType });
    return c.json({ data: obj }, 201);
  })
  .get("/:key{.+}", async (c) => {
    const { storage } = c.get("ctx");
    const obj = await storage.get(c.req.param("key"));
    if (!obj) throw new AppError("NOT_FOUND", "Object not found");
    return new Response(obj.body, {
      headers: {
        "content-type": obj.meta.contentType ?? "application/octet-stream",
        "content-length": String(obj.meta.size),
      },
    });
  })
  .delete("/:key{.+}", requireUser, async (c) => {
    const { storage } = c.get("ctx");
    await storage.delete(c.req.param("key"));
    return c.json({ ok: true });
  });
