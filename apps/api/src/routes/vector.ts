import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

const UpsertInput = z.object({
  records: z
    .array(
      z.object({
        id: z.string().min(1),
        values: z.array(z.number()),
        namespace: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    )
    .min(1),
});

const QueryInput = z.object({
  values: z.array(z.number()).min(1),
  topK: z.number().int().min(1).max(100).optional(),
  namespace: z.string().optional(),
  filter: z.record(z.unknown()).optional(),
});

const DeleteInput = z.object({
  ids: z.array(z.string()).min(1),
  namespace: z.string().optional(),
});

export const vectorRoutes = new Hono<AppBindings>()
  .post("/upsert", requireUser, async (c) => {
    const { vector } = c.get("ctx");
    const body = UpsertInput.parse(await c.req.json());
    await vector.upsert(body.records);
    return c.json({ ok: true, count: body.records.length });
  })
  .post("/query", async (c) => {
    const { vector } = c.get("ctx");
    const body = QueryInput.parse(await c.req.json());
    const matches = await vector.query(body);
    return c.json({ data: matches });
  })
  .post("/delete", requireUser, async (c) => {
    const { vector } = c.get("ctx");
    const body = DeleteInput.parse(await c.req.json());
    await vector.delete(body.ids, body.namespace);
    return c.json({ ok: true });
  });
