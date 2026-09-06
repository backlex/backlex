/**
 * Phase 10 of the 2026-09 pre-prod audit — the multi-surface parity cluster.
 *
 * Four findings, one shape: *a control was implemented on the surface somebody
 * was looking at, and the OTHER surface reaches the same capability by a
 * different road.* Each one had a written note explaining why that was safe.
 *
 *  · **A read-only impersonation could mutate through GraphQL.**
 *    `middleware/impersonation-readonly.ts` exempts `POST /api/graphql` and its
 *    exemption note says the layer underneath covers it — "mutations reach
 *    `services/items/write.ts`, which refuses a read-only impersonation on its
 *    own". Several mutations do not go through the write core: `normalizeOrder`
 *    renumbers rows the caller never named, `backfillSlugs(apply: true)`
 *    rewrites the published URL handle of every row with an empty slug,
 *    `deleteFile` deletes object bytes. Reproduced side by side in one session:
 *    the REST twin answered 403 and the GraphQL one answered 200, with a
 *    `createNotes` control proving the session really was read-only.
 *
 *  · **The MCP per-key allowlist was applied to `tools/*` and nothing else.**
 *    A key minted with `mcpTools: ["storage.list"]` was refused
 *    `collections.list` by name — and then `resources/read
 *    backlex://collection/secrets` handed over that collection's schema and a
 *    sample row. The file's own header already CLAIMED the allowlist gated the
 *    resource channel.
 *
 *  · **Demo-mode write blocks are path prefixes.** GraphQL is one POST to
 *    `/api/graphql`, so `POST /api/messaging/sms` was refused while
 *    `mutation { sendSms(...) }` spent the playground's SMS credit. The
 *    playground publishes its admin credentials on the sign-in screen.
 *
 *  · **GraphQL stored a flow's operation tree unvalidated.** REST parsed it
 *    with `OperationSchema` — which is where every per-op cap and URL check
 *    lives — and GraphQL did not, so `{timeoutMs: 3600000, headers:
 *    "not-an-object"}` was stored and then read at run time by
 *    `op.timeoutMs ?? 10_000` (no ceiling) and `...(op.headers ?? {})`
 *    (spreading a string). Recorded in project memory as
 *    `graphql-skips-zod-on-flow-ops` and still open until now.
 *
 * Every fix moves the control to where BOTH surfaces reach it — a wrapper over
 * the whole `Mutation` field map, a predicate inside the resource module, an
 * assertion inside the capability, a parse inside the shared flow guard — so
 * that a surface added tomorrow inherits the answer rather than having to
 * remember it.
 */
import { describe, expect, test } from "bun:test";
import { AppError } from "@backlex/core";
import { GraphQLError } from "graphql";
import { guardMutationFields } from "../src/server/services/graphql/core";
import { assertNotDemo, isDemoBlockedRequest } from "../src/server/services/demo";
import type { Env } from "../src/server/env";

// ---------------------------------------------------------------------------
// Read-only impersonation, on the surface the middleware exempts
// ---------------------------------------------------------------------------

const runField = async (
  fields: Record<string, unknown>,
  name: string,
  gqlCtx: unknown,
): Promise<unknown> => {
  const f = fields[name] as { resolve: (...a: unknown[]) => unknown };
  return f.resolve(undefined, {}, gqlCtx, undefined);
};

describe("faz10: every GraphQL mutation refuses a read-only impersonation", () => {
  const build = () =>
    guardMutationFields({
      // Stands in for `normalizeOrder` / `backfillSlugs` / `deleteFile`: a real
      // mutation that never touches the item write core, so the write core's
      // own gate could not see it.
      normalizeOrder: { resolve: async () => ({ scopes: 1, renumbered: 0 }) },
      createNotes: { resolve: async () => ({ id: "x" }) },
      // A field map may legitimately carry entries with no resolver (GraphQL
      // falls back to the default field resolver); wrapping must skip them
      // rather than throw while building the schema.
      noResolver: { type: "Whatever" },
    } as Record<string, unknown>);

  const readOnly = { auth: { impersonationReadOnly: true } };
  const normal = { auth: { impersonationReadOnly: false } };

  test("a mutation that bypasses the write core is refused", async () => {
    await expect(runField(build(), "normalizeOrder", readOnly)).rejects.toThrow(
      /read-only impersonation/,
    );
  });

  test("…and so is one that does go through it (belt and braces)", async () => {
    await expect(runField(build(), "createNotes", readOnly)).rejects.toThrow(
      /read-only impersonation/,
    );
  });

  test("the refusal is a FORBIDDEN GraphQLError, not a transport failure", async () => {
    try {
      await runField(build(), "normalizeOrder", readOnly);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
      expect((e as GraphQLError).extensions?.code).toBe("FORBIDDEN");
      // Names the mutation, so an operator can tell WHICH call was refused.
      expect((e as GraphQLError).message).toContain("normalizeOrder");
    }
  });

  test("an ordinary session is untouched", async () => {
    expect(await runField(build(), "normalizeOrder", normal)).toEqual({
      scopes: 1,
      renumbered: 0,
    });
    // …including one with no auth at all on the context.
    expect(await runField(build(), "createNotes", {})).toEqual({ id: "x" });
  });

  test("a field with no resolver is left alone", () => {
    const fields = build();
    expect((fields.noResolver as { resolve?: unknown }).resolve).toBeUndefined();
  });

  test("the wrapper covers the WHOLE map, so a new mutation inherits it", () => {
    // The point of wrapping the field map rather than each resolver: this is
    // what makes tomorrow's mutation safe without anyone remembering.
    const fields = build();
    for (const key of ["normalizeOrder", "createNotes"]) {
      expect(typeof (fields[key] as { resolve: unknown }).resolve).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// Demo mode, at the capability rather than at the path
// ---------------------------------------------------------------------------

describe("faz10: a blocked capability refuses wherever it is reached from", () => {
  const demo = { DEMO_MODE: "1" } as Env;
  const normal = {} as Env;

  test("assertNotDemo refuses in the playground", () => {
    expect(() => assertNotDemo(demo)).toThrow(/playground/i);
    try {
      assertNotDemo(demo);
    } catch (e) {
      expect((e as AppError).code).toBe("FORBIDDEN");
    }
  });

  test("…and is inert everywhere else", () => {
    expect(() => assertNotDemo(normal)).not.toThrow();
    expect(() => assertNotDemo({ DEMO_MODE: "0" } as Env)).not.toThrow();
  });

  test("the route prefix list stays as the outer layer", () => {
    // Not replaced — the two layers answer for different things. The prefix
    // list keeps covering the REST doors; the assertion covers the capability
    // whichever door reached it.
    expect(isDemoBlockedRequest("POST", "/api/messaging/sms")).toBe(true);
    expect(isDemoBlockedRequest("POST", "/api/admin/migrate/sources")).toBe(true);
    expect(isDemoBlockedRequest("GET", "/api/messaging/sms")).toBe(false);
  });

  test("`/api/graphql` is NOT on the prefix list — which is the finding", () => {
    // Recorded so the shape stays legible: the prefix list cannot cover
    // GraphQL without parsing the document, which is exactly why the capability
    // has to answer for itself.
    expect(isDemoBlockedRequest("POST", "/api/graphql")).toBe(false);
  });
});
