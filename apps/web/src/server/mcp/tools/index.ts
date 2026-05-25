import type { McpTool } from "../types";
import { schemaTools } from "./schema";
import { collectionsTools } from "./collections";
import { storageTools } from "./storage";
import { functionsTools } from "./functions";

/** The full tool roster. Both the `/mcp` and `/api/admin/mcp` mounts expose
 *  the same set — the mount gate is what differs (any-authenticated vs.
 *  admin-only). Tools that need higher privileges (functions.invoke) are
 *  enforced at the upstream HTTP endpoint, not at the MCP layer, so we
 *  don't double-gate here. */
export const allTools: McpTool[] = [
  ...schemaTools,
  ...collectionsTools,
  ...storageTools,
  ...functionsTools,
];
