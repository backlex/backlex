/**
 * Items API — one sub-router per concern, mounted in the original
 * registration order (list → aggregate/search → csv → changes → read →
 * write/publish → batch). Split from the former 2,287-line routes/items.ts;
 * shared route-only helpers live in ./shared, everything heavier was already
 * in services/items/*.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppBindings } from "../../app";
import { itemsListRoutes } from "./list";
import { itemsQueryRoutes } from "./query";
import { itemsCsvRoutes } from "./csv";
import { itemsIngestRoutes } from "./ingest";
import { itemsChangesRoutes } from "./changes";
import { itemsReadRoutes } from "./read";
import { itemsWriteRoutes } from "./write";
import { itemsBatchRoutes } from "./batch";
import { defaultHook } from "../../lib/openapi-router";

export const itemsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .route("/", itemsListRoutes)
  .route("/", itemsQueryRoutes)
  .route("/", itemsCsvRoutes)
  .route("/", itemsIngestRoutes)
  .route("/", itemsChangesRoutes)
  .route("/", itemsReadRoutes)
  .route("/", itemsWriteRoutes)
  .route("/", itemsBatchRoutes);
