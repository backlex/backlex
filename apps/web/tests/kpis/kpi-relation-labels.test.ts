/**
 * A KPI grouped by a relation names the related rows.
 *
 * It printed their ids. "Posts by category" — shipped by the blog template —
 * grouped by `category`, which stores the category's UUID, and every surface
 * showed `ca5c194f-e427-480d-9998-328289c0eb44 · 1` where it meant "News · 1".
 *
 * `label` stays the id (a caller matches and filters on it, and the period
 * comparison pairs rows by it); `display` carries the name. The name is read
 * with the caller's permission on the TARGET collection: counting posts is not
 * a grant to read categories, so a reader who could not have fetched the
 * category keeps the id they already had, and nothing more.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AuthSubject } from "@backlex/core";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";
import { buildContext } from "../../src/server/context";
import { getKpiBySlug, kpiPanelRows, runKpiForCaller, type KpiResult } from "../../src/server/services/kpis";

const J = (m: string, b: unknown): RequestInit => ({
  method: m,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(b),
});

interface Row {
  label?: string;
  display?: string;
  value: number | null;
}

describe("a KPI grouped by a relation", () => {
  let h: TestHarness;
  const stamp = Date.now();
  const cats = `cat_${stamp}`;
  const posts = `post_${stamp}`;
  let newsId = "";
  let sportId = "";
  let tenantId = "";

  const run = async (slug: string): Promise<Row[]> => {
    const res = await h.fetch(`/api/admin/kpis/${slug}/run`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { rows: Row[] } }).data.rows;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    tenantId = ((await (await h.fetch("/api/me")).json()) as { data: { tenantId: string } }).data.tenantId;
    expect(
      (
        await h.fetch(
          "/api/collections",
          J("POST", {
            slug: cats,
            displayTemplate: "{{name}} ({{code}})",
            fields: [
              { name: "name", type: "text" },
              { name: "code", type: "text" },
            ],
          }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await h.fetch(
          "/api/collections",
          J("POST", {
            slug: posts,
            fields: [
              { name: "title", type: "text" },
              { name: "category", type: "relation", to: cats },
            ],
          }),
        )
      ).status,
    ).toBe(201);
    const cat = async (name: string, code: string) =>
      ((await (await h.fetch(`/api/items/${cats}`, J("POST", { name, code }))).json()) as { data: { id: string } })
        .data.id;
    newsId = await cat("News", "NW");
    sportId = await cat("Sport", "SP");
    for (const category of [newsId, newsId, sportId]) {
      expect((await h.fetch(`/api/items/${posts}`, J("POST", { title: "t", category }))).status).toBe(201);
    }
    for (const [slug, groupBy] of [
      ["by-category", "category"],
      ["by-title", "title"],
    ] as const) {
      const created = await h.fetch(
        "/api/admin/kpis",
        J("POST", { slug: `${slug}-${stamp}`, name: slug, collection: posts, agg: "count", groupBy, topN: 10 }),
      );
      expect(created.status).toBe(201);
    }
  });
  afterAll(() => h.cleanup());

  test("each row carries the related row's name, rendered through its display template", async () => {
    const rows = await run(`by-category-${stamp}`);
    expect(rows.map((r) => [r.label, r.display, r.value])).toEqual([
      [newsId, "News (NW)", 2],
      [sportId, "Sport (SP)", 1],
    ]);
  });

  test("a group that is not a relation gets no display", async () => {
    const rows = await run(`by-title-${stamp}`);
    expect(rows).toEqual([expect.objectContaining({ label: "t", value: 3 })]);
    expect(rows[0]!.display).toBeUndefined();
  });

  test("a dashboard panel draws the name, not the id", async () => {
    const res = await h.fetch(`/api/admin/kpis/by-category-${stamp}/run`);
    const panel = kpiPanelRows(((await res.json()) as { data: KpiResult }).data);
    expect(panel.map((r) => r.label)).toEqual(["News (NW)", "Sport (SP)"]);
    expect(panel.some((r) => "display" in r)).toBe(false);
  });

  test("a reader who may count posts but not read categories keeps the ids", async () => {
    const roles = ((await (await h.fetch("/api/roles")).json()) as { data: { id: string; name: string }[] }).data;
    const authenticated = roles.find((r) => r.name === "authenticated")!.id;
    expect((await h.fetch(`/api/roles/${authenticated}/permissions`, J("POST", { collection: posts, action: "read" }))).status).toBeLessThan(300);

    const email = `reader-${stamp}@labels.test`;
    const invited = await h.fetch("/api/app-users/invite", J("POST", { email }));
    expect(invited.status).toBe(201);
    const { token } = ((await invited.json()) as { data: { token: string } }).data;
    expect(
      (await h.app.request("/api/t/default/auth/invite/accept", J("POST", { token, password: "labels-pass-12345" }))).status,
    ).toBe(200);
    const users = ((await (await h.fetch("/api/app-users")).json()) as { data: { id: string; email: string }[] }).data;
    const userId = users.find((u) => u.email === email)!.id;

    const ctx = await buildContext(h.env);
    const kpi = (await getKpiBySlug(ctx, tenantId, `by-category-${stamp}`))!;
    const reader: AuthSubject = { plane: "app", userId, email, roles: [], tenantId, access: "member" };

    const denied = await runKpiForCaller(ctx, reader, tenantId, kpi);
    expect(denied.rows!.map((r) => [r.label, r.display])).toEqual([
      [newsId, undefined],
      [sportId, undefined],
    ]);

    // Granting read on categories — but not `code` — names them, from the
    // readable fields only: the template's `code` renders empty.
    expect(
      (
        await h.fetch(
          `/api/roles/${authenticated}/permissions`,
          J("POST", { collection: cats, action: "read", fields: ["name"] }),
        )
      ).status,
    ).toBeLessThan(300);
    const granted = await runKpiForCaller(ctx, reader, tenantId, kpi);
    expect(granted.rows!.map((r) => r.display)).toEqual(["News ()", "Sport ()"]);
  });
});
