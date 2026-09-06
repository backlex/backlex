/**
 * Phase 10 of the 2026-09 pre-prod audit — the MCP per-key allowlist reached
 * `tools/*` and stopped there.
 *
 * Reproduced against the harness while the finding was written: a key minted
 * with `mcpTools: ["storage.list"]` got exactly one entry from `tools/list` and
 * was refused `collections.list` by name — and then
 * `resources/read backlex://collection/secrets` handed back that collection's
 * field list AND a sample row. `backlex://openapi` likewise returned the
 * workspace's whole endpoint surface.
 *
 * It is not privilege escalation past the credential's own reach — rows stay
 * clamped by the identity's permission DSL — but the allowlist is what the
 * product documents as the way to narrow an agent, and `db.execute_sql`'s own
 * description tells operators to "pair with the per-key MCP allowlist". A
 * control that is documented and half-applied is worse than none, because it is
 * the one people rely on. The module header already CLAIMED it gated the
 * resource channel.
 *
 * Driven through `listResources` / `readResource` directly with a stub
 * `fetchInternal`, because what is being asserted is the GUARD, not the data —
 * and a spec that needs a whole workspace to prove a predicate tends not to get
 * written for the negative case, which is how this survived.
 */
import { describe, expect, test } from "bun:test";
import { listResources, readResource } from "../src/server/mcp/resources";
import type { ToolCtx } from "../src/server/mcp/types";

const COLLECTIONS = {
  data: [
    { slug: "secrets", singular: "Secret", plural: "Secrets", fields: [{ name: "title", type: "text" }] },
  ],
};

const stubCtx = (allowlist: string[] | null, mode: "admin" | "tenant" = "admin"): ToolCtx =>
  ({
    mode,
    env: {} as never,
    guards: { allowlist, readOnly: false, roleAllowlist: null },
    usage: null,
    fetchInternal: async (path: string) => {
      if (path.startsWith("/api/collections")) {
        return new Response(JSON.stringify(COLLECTIONS), {
          headers: { "content-type": "application/json" },
        });
      }
      if (path.startsWith("/api/items/")) {
        return new Response(JSON.stringify({ data: [{ id: "1", title: "top-secret-row" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/api/openapi.json") {
        return new Response(JSON.stringify({ openapi: "3.1.0", paths: {} }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/api/me") {
        return new Response(JSON.stringify({ data: { id: "u1" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });
    },
  }) as unknown as ToolCtx;

const uris = async (ctx: ToolCtx): Promise<string[]> =>
  (await listResources(ctx)).resources.map((r) => r.uri);

describe("faz10: a narrowed key cannot read through the resource channel", () => {
  test("the exact reported case — a key allowed only `storage.list`", async () => {
    const ctx = stubCtx(["storage.list"]);
    const listed = await uris(ctx);
    expect(listed).not.toContain("backlex://collection/secrets");
    expect(listed).not.toContain("backlex://schema");
    expect(listed).not.toContain("backlex://openapi");
    await expect(readResource(ctx, "backlex://collection/secrets")).rejects.toThrow(
      /allowlist/,
    );
  });

  test("…and the sample row really was reachable before — the read is refused, not emptied", async () => {
    // A guard that returned `{contents: []}` would look the same in a list
    // assertion and leak nothing OR everything depending on a later edit. It
    // has to throw.
    const ctx = stubCtx(["storage.list"]);
    let threw = false;
    try {
      await readResource(ctx, "backlex://collection/secrets");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("an UNRESTRICTED key still sees and reads everything", async () => {
    // The other direction. A gate that refuses everyone passes the test above.
    const ctx = stubCtx(null);
    const listed = await uris(ctx);
    expect(listed).toContain("backlex://collection/secrets");
    expect(listed).toContain("backlex://schema");
    expect(listed).toContain("backlex://openapi");
    const read = await readResource(ctx, "backlex://collection/secrets");
    expect(JSON.stringify(read)).toContain("top-secret-row");
  });

  test("a key that DOES hold the covering tools keeps the resource", async () => {
    const ctx = stubCtx(["schema.describe_collection", "collections.list"]);
    expect(await uris(ctx)).toContain("backlex://collection/secrets");
    await expect(readResource(ctx, "backlex://collection/secrets")).resolves.toBeDefined();
  });

  test("the collection resource needs BOTH its covering tools", async () => {
    // It returns schema AND rows, so holding only the describe tool must not
    // hand over the sample.
    const ctx = stubCtx(["schema.describe_collection"]);
    expect(await uris(ctx)).not.toContain("backlex://collection/secrets");
    await expect(readResource(ctx, "backlex://collection/secrets")).rejects.toThrow();
  });

  test("a namespace glob still works", async () => {
    // The allowlist grammar is shared with `tools/call`; the resource gate must
    // not reimplement matching.
    const ctx = stubCtx(["schema.*", "collections.*"]);
    expect(await uris(ctx)).toContain("backlex://collection/secrets");
    expect(await uris(ctx)).toContain("backlex://schema");
  });

  test("`backlex://me` stays open — it reports the caller's OWN limits", async () => {
    // Most useful precisely to a key that has been narrowed and needs to say
    // why it cannot do something.
    const ctx = stubCtx(["storage.list"]);
    expect(await uris(ctx)).toContain("backlex://me");
    await expect(readResource(ctx, "backlex://me")).resolves.toBeDefined();
  });

  test("`backlex://roles` is gated on `roles.list`", async () => {
    expect(await uris(stubCtx(["storage.list"]))).not.toContain("backlex://roles");
    expect(await uris(stubCtx(["roles.list"]))).toContain("backlex://roles");
  });

  test("an unknown uri is still an unknown uri, not a FORBIDDEN", async () => {
    // The two answers mean different things to a client: one says retry never,
    // the other says ask for a wider key.
    await expect(readResource(stubCtx(null), "backlex://nope")).rejects.toThrow(/unknown/);
  });
});
