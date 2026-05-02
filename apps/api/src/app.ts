import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { buildContext, type Ctx } from "./context";
import { errorHandler } from "./middleware/error";
import { sessionMiddleware } from "./middleware/session";
import { authRoutes } from "./routes/auth";
import { collectionsRoutes } from "./routes/collections";
import { recordsRoutes } from "./routes/records";
import { storageRoutes } from "./routes/storage";
import { vectorRoutes } from "./routes/vector";
import { realtimeRoutes } from "./routes/realtime";
import type { Env } from "./env";

export type AppBindings = {
  Variables: {
    ctx: Ctx;
    auth: { userId: string | null; email: string | null; roles: string[] };
  };
};

export const createApp = (env: Env) => {
  const app = new Hono<AppBindings>();

  app.use("*", logger());
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: env.APP_URL,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  app.use("*", async (c, next) => {
    c.set("ctx", buildContext(env));
    await next();
  });

  app.use("*", sessionMiddleware);

  app.get("/health", (c) =>
    c.json({ ok: true, dialect: c.get("ctx").dialect, ts: Date.now() }),
  );

  app.route("/api/auth", authRoutes);
  app.route("/api/collections", collectionsRoutes);
  app.route("/api/records", recordsRoutes);
  app.route("/api/storage", storageRoutes);
  app.route("/api/vector", vectorRoutes);
  app.route("/api/realtime", realtimeRoutes);

  app.onError(errorHandler);

  return app;
};
