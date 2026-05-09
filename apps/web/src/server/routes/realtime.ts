import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import type { AppBindings } from "../app";
import { resolvePermission } from "../services/permissions";
import {
  publishLocal,
  subscribeLocal,
  type SubscriptionMeta,
} from "../services/events";

const ITEMS_PREFIX = "items:";

interface Gate {
  meta?: SubscriptionMeta;
}

const gateForChannel = async (
  ctx: Parameters<typeof resolvePermission>[0] & { dialect: "pg" | "sqlite" },
  auth: { userId: string | null; email: string | null; roles: string[] },
  channel: string,
  isPublish: boolean,
): Promise<Gate> => {
  if (channel.startsWith(ITEMS_PREFIX)) {
    const slug = channel.slice(ITEMS_PREFIX.length);
    if (isPublish) {
      throw new AppError(
        "FORBIDDEN",
        "items:* channels are published by the API; client publish is disabled",
      );
    }
    const perm = await resolvePermission(ctx, auth, slug, "read");
    if (!perm.allowed) {
      throw new AppError(
        auth.userId ? "FORBIDDEN" : "UNAUTHORIZED",
        auth.userId
          ? `No read permission for ${slug}`
          : "Sign in required",
      );
    }
    return {
      meta: {
        authSubject: auth,
        conditions: perm.isAdmin ? null : perm.conditions,
        fields: perm.fields ? [...perm.fields] : null,
      },
    };
  }
  if (channel === "collections") {
    if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
      throw new AppError(
        auth.userId ? "FORBIDDEN" : "UNAUTHORIZED",
        "Admin only",
      );
    }
    if (isPublish) {
      throw new AppError(
        "FORBIDDEN",
        "collections channel is published by the API",
      );
    }
    return {
      meta: { authSubject: auth, conditions: null, fields: null },
    };
  }
  // user-defined channel: no auth, no filter
  return {};
};

export const realtimeRoutes = new Hono<AppBindings>()
  .post("/:channel/publish", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const channel = c.req.param("channel");
    await gateForChannel(ctx, auth, channel, true);

    const payload = await c.req.json();
    if (ctx.env.REALTIME) {
      const id = ctx.env.REALTIME.idFromName(channel);
      const stub = ctx.env.REALTIME.get(id);
      await stub.fetch("https://do/publish", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    } else {
      publishLocal(channel, payload);
    }
    return c.json({ ok: true });
  })
  .get("/:channel/subscribe", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const channel = c.req.param("channel");
    const gate = await gateForChannel(ctx, auth, channel, false);

    if (ctx.env.REALTIME) {
      const url = new URL("https://do/subscribe");
      if (gate.meta) {
        url.searchParams.set("meta", btoa(JSON.stringify(gate.meta)));
      }
      const id = ctx.env.REALTIME.idFromName(channel);
      const stub = ctx.env.REALTIME.get(id);
      return stub.fetch(url.toString(), {
        headers: { upgrade: "websocket" },
      });
    }

    return streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const wakeUp = () => {
        if (wake) {
          wake();
          wake = null;
        }
      };
      const send = (msg: string) => {
        queue.push(msg);
        wakeUp();
      };
      const unsub = subscribeLocal(channel, { send, meta: gate.meta });
      const aborted = { value: false };
      c.req.raw.signal.addEventListener("abort", () => {
        aborted.value = true;
        wakeUp();
      });

      await stream.writeSSE({ event: "ready", data: channel });
      try {
        while (!aborted.value) {
          while (queue.length > 0) {
            const msg = queue.shift()!;
            await stream.writeSSE({ event: "message", data: msg });
          }
          if (aborted.value) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        unsub();
      }
    });
  });
