/**
 * Where the MCP transport is mounted, in one place.
 *
 * An MCP OAuth access token (better-auth `mcp` plugin) is a credential for ONE
 * resource: the server publishes `resource: <APP_URL>/mcp` in its RFC 9728
 * protected-resource metadata (`packages/auth/src/index.ts`), and that is what
 * a strict client compares against the URL it was pointed at. So the token has
 * to be refused everywhere else — and "everywhere else" is only meaningful if
 * "here" is a single declared list rather than a string literal repeated in a
 * middleware.
 *
 * `app.ts` mounts the two routers with these very constants, and
 * `tests/security-audit-2026-09-token-scope.test.ts` re-derives the list from
 * `app.ts`'s source so a third MCP mount cannot land without appearing here.
 * The alternative — a hand-written list in the guard — is the shape that
 * covered 46 of 131 tables in Faz 2.
 */

/** `/mcp` — the tenant transport, the resource the OAuth metadata names. */
export const MCP_TENANT_MOUNT = "/mcp";

/** `/api/admin/mcp` — the admin transport (same tools, dotted wire names,
 *  additionally gated on the system `admin` role by its own router). */
export const MCP_ADMIN_MOUNT = "/api/admin/mcp";

export const MCP_MOUNT_PREFIXES = [MCP_TENANT_MOUNT, MCP_ADMIN_MOUNT] as const;

/**
 * Is `path` on an MCP mount?
 *
 * Prefix match with a boundary check, so `/mcpanel` is not `/mcp`. The
 * transport itself is POST-only on the exact mount path, but sub-paths are
 * matched too: a router that later adds `/mcp/<something>` should not have to
 * remember to come back here.
 */
export const isMcpMountPath = (path: string): boolean =>
  MCP_MOUNT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
