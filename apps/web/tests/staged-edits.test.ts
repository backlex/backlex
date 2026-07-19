/**
 * Staged edits (#15) on `stagedEdits` + versioned collections:
 *   - PATCH against a *published* row stages the patch — the live row (and what
 *     readers see) is untouched, response carries `_staged: true`;
 *   - staged saves merge shallowly per field across requests;
 *   - GET flags `_staged`; `?staged=1` previews the patch for privileged callers;
 *   - list annotates `_staged` on flagged rows;
 *   - publish applies the staged patch to the live row and clears it;
 *   - unpublish folds the patch into the (now draft) row;
 *   - DELETE /staged discards without applying;
 *   - `?live=1` bypasses staging but needs the publish permission;
 *   - draft rows PATCH directly (no staging);
 *   - GraphQL update mirrors the staging interception.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("Staged edits", () => {
  let h: TestHarness;
  const slug = `staged_${Date.now()}`;
  let adminEmail: string;

  const mkItem = async (title: string): Promise<string> => {
    const r = await h.fetch(`/api/items/${slug}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title, body: "v1" }),
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as { data: { id: string } }).data.id;
  };
  const publish = async (id: string) => {
    const r = await h.fetch(`/api/items/${slug}/${id}/publish`, { method: "POST" });
    expect(r.status).toBe(200);
    return ((await r.json()) as { data: Record<string, unknown> }).data;
  };
  const getItem = async (id: string, qs = "") => {
    const r = await h.fetch(`/api/items/${slug}/${id}${qs}`);
    expect(r.status).toBe(200);
    return ((await r.json()) as { data: Record<string, unknown> }).data;
  };

  beforeAll(async () => {
    h = makeHarness();
    adminEmail = (await seedAdmin(h)).email;
    const create = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug,
        versioned: true,
        stagedEdits: true,
        tenantScoped: true,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "body", type: "text" },
        ],
      }),
    });
    expect(create.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("PATCH on a published row stages instead of writing live", async () => {
    const id = await mkItem("hello");
    await publish(id);

    const patch = await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "staged title" }),
    });
    expect(patch.status).toBe(200);
    const preview = ((await patch.json()) as { data: Record<string, unknown> }).data;
    expect(preview._staged).toBe(true);
    expect(preview.title).toBe("staged title");

    // Live row untouched (privileged read without staged preview).
    const live = await getItem(id);
    expect(live.title).toBe("hello");
    expect(live._staged).toBe(true); // flag only — values stay live
    // Merged preview via ?staged=1.
    const merged = await getItem(id, "?staged=1");
    expect(merged.title).toBe("staged title");
    expect(merged.body).toBe("v1");
  });

  test("staged saves merge per field; list annotates _staged", async () => {
    const id = await mkItem("merge me");
    await publish(id);
    for (const body of [{ title: "t2" }, { body: "b2" }]) {
      const r = await h.fetch(`/api/items/${slug}/${id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(200);
    }
    const merged = await getItem(id, "?staged=1");
    expect(merged.title).toBe("t2");
    expect(merged.body).toBe("b2");

    const listRes = await h.fetch(`/api/items/${slug}`);
    const rows = ((await listRes.json()) as { data: Record<string, unknown>[] }).data;
    const row = rows.find((r) => r.id === id)!;
    expect(row._staged).toBe(true);
  });

  test("publish applies the staged patch and clears it", async () => {
    const id = await mkItem("apply me");
    await publish(id);
    await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "applied", body: "b-applied" }),
    });
    const republished = await publish(id);
    expect(republished.title).toBe("applied");
    expect(republished._status).toBe("published");
    const after = await getItem(id);
    expect(after.title).toBe("applied");
    expect(after.body).toBe("b-applied");
    expect(after._staged).toBeUndefined();
  });

  test("unpublish folds the staged patch into the draft", async () => {
    const id = await mkItem("fold me");
    await publish(id);
    await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "folded" }),
    });
    const r = await h.fetch(`/api/items/${slug}/${id}/publish?unpublish=1`, { method: "POST" });
    expect(r.status).toBe(200);
    const after = await getItem(id, "?status=all");
    expect(after._status).toBe("draft");
    expect(after.title).toBe("folded");
    expect(after._staged).toBeUndefined();
  });

  test("DELETE /staged discards without applying", async () => {
    const id = await mkItem("discard me");
    await publish(id);
    await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "junk" }),
    });
    const r = await h.fetch(`/api/items/${slug}/${id}/staged`, { method: "DELETE" });
    expect(r.status).toBe(200);
    const after = await getItem(id);
    expect(after.title).toBe("discard me");
    expect(after._staged).toBeUndefined();
    // Re-publish keeps the live values (nothing pending to apply).
    const rep = await publish(id);
    expect(rep.title).toBe("discard me");
  });

  test("?live=1 bypasses staging for a publish-permitted caller (admin)", async () => {
    const id = await mkItem("live edit");
    await publish(id);
    const r = await h.fetch(`/api/items/${slug}/${id}?live=1`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "hot-fixed" }),
    });
    expect(r.status).toBe(200);
    const live = await getItem(id);
    expect(live.title).toBe("hot-fixed");
    expect(live._staged).toBeUndefined();
  });

  test("draft rows PATCH directly — no staging", async () => {
    const id = await mkItem("draft flow");
    const r = await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "draft edited" }),
    });
    expect(r.status).toBe(200);
    const row = ((await r.json()) as { data: Record<string, unknown> }).data;
    expect(row._staged).toBeUndefined();
    const read = await getItem(id, "?status=all");
    expect(read.title).toBe("draft edited");
  });

  test("read-only caller keeps seeing the published content (no flag, no preview)", async () => {
    const id = await mkItem("reader view");
    await publish(id);
    await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "hidden staged" }),
    });

    // Grant read-only to authenticated, then act as a fresh non-admin user.
    const rolesRes = await h.fetch("/api/roles");
    const roles = ((await rolesRes.json()) as { data: { id: string; name: string }[] }).data;
    const authRole = roles.find((r) => r.name === "authenticated")!;
    await h.fetch(`/api/roles/${authRole.id}/permissions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: slug, action: "read", condition: null }),
    });
    // Admin sees the staged preview…
    const item = await getItem(id, "?staged=1");
    expect(item.title).toBe("hidden staged");
    // …then switch the session to a fresh read-only user (sign-up logs in).
    const email = `reader_${Date.now()}@example.com`;
    await h.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "Reader" }),
    });
    const r = await h.fetch(`/api/items/${slug}/${id}?staged=1`);
    expect(r.status).toBe(200);
    const asReader = ((await r.json()) as { data: Record<string, unknown> }).data;
    expect(asReader.title).toBe("reader view");
    expect(asReader._staged).toBeUndefined();
    // restore admin session for the remaining tests
    await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: adminEmail, password: "correct-horse-battery" }),
    });
  });

  test("MCP items.discard_staged discards via the shared route", async () => {
    const id = await mkItem("mcp discard");
    await publish(id);
    await h.fetch(`/api/items/${slug}/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "mcp junk" }),
    });
    const res = await h.fetch("/mcp", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "items.discard_staged", arguments: { collection: slug, id } },
      }),
    });
    const rpc = (await res.json()) as {
      result?: { structuredContent?: { ok?: boolean }; isError?: boolean };
      error?: { message: string };
    };
    expect(rpc.error).toBeUndefined();
    expect(rpc.result?.isError).toBeFalsy();
    expect(rpc.result?.structuredContent?.ok).toBe(true);
    const after = await getItem(id);
    expect(after.title).toBe("mcp discard");
    expect(after._staged).toBeUndefined();
  });

  test("GraphQL update stages against a published row too", async () => {
    const id = await mkItem("gql staged");
    await publish(id);
    const mutName = `updateStaged_${slug.split("_")[1]}`;
    const q = `mutation { ${mutName}(id: "${id}", data: { title: "gql title" }) { id title } }`;
    const r = await h.fetch("/api/graphql", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ query: q }),
    });
    expect(r.status).toBe(200);
    const gql = (await r.json()) as { data?: Record<string, any>; errors?: unknown };
    expect(gql.errors).toBeUndefined();
    expect(gql.data?.[mutName]?.title).toBe("gql title");
    // Live row untouched; staged flag visible on REST read.
    const live = await getItem(id);
    expect(live.title).toBe("gql staged");
    expect(live._staged).toBe(true);
    const merged = await getItem(id, "?staged=1");
    expect(merged.title).toBe("gql title");
  });
});
