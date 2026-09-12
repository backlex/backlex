/**
 * An embed runs as `public`, and the API says so instead of pretending
 * otherwise.
 *
 * A dashboard share used to accept an `embedRoleId`. It was stored, put in the
 * synthetic subject's `roles`, and passed along as a scope — and all three were
 * decorative. `resolvePermission` loads roles from the database BY USER ID
 * (`loadRolesForUser`), an embed subject has `userId: null`, and that branch
 * returns the workspace's `public` role and nothing else; `auth.roles` is never
 * read. The scope's `embedRoleName` was never read either — `scope` was only
 * ever tested for truthiness. See #331.
 *
 * It failed CLOSED: a MORE privileged embed role produced LESS access, not
 * more. So there was nothing to leak — only a feature the docs described and
 * the code did not have.
 *
 * The decision recorded here is the one the issue calls the honest description
 * of an anonymous embed: it always runs as `public`, and a publisher who needs
 * it to show more grants that to `public` explicitly.
 *
 * These assertions are behavioural: a role that WOULD have granted more is
 * created and named, and the embed must still see only what `public` can. A
 * test that only checked the request is refused would pass on a server that
 * accepted the field and ignored it — which is the state being fixed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";

const json = { "Content-Type": "application/json" };

describe("a public dashboard embed", () => {
  let h: TestHarness;
  let dashboardId = "";
  let roleId = "";

  const post = (path: string, body: unknown) =>
    h.fetch(path, { method: "POST", headers: json, body: JSON.stringify(body) });

  /** POST and fail loudly with the server's own message. A bare status assert
   *  in setup says which line broke but never why. */
  const mustPost = async (path: string, body: unknown, want = 201) => {
    const res = await post(path, body);
    if (res.status !== want) {
      throw new Error(`POST ${path} -> ${res.status}: ${await res.text()}`);
    }
    return res;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    await mustPost("/api/collections", {
      slug: "sales",
      fields: [{ name: "region", type: "text" }],
    });
    await mustPost("/api/items/sales", { region: "north" });

    // A role that CAN read `sales`. `public` deliberately gets no grant, so the
    // two answers differ — which is what makes naming the role observable.
    const role = await mustPost("/api/roles", { name: "viewer" });
    roleId = ((await role.json()) as { data: { id: string } }).data.id;
    await mustPost(`/api/roles/${roleId}/permissions`, {
      collection: "sales",
      action: "read",
    });

    const dash = await mustPost("/api/admin/dashboards", { name: "Sales" });
    dashboardId = ((await dash.json()) as { data: { id: string } }).data.id;

    await mustPost("/api/admin/panels", {
      dashboardId,
      name: "By region",
      kind: "items-aggregate",
      viz: "bars",
      config: { collection: "sales", agg: "count", groupBy: "region" },
    });
  });
  afterAll(() => h.cleanup());

  test("sharing with a roleId is refused, and says what to do instead", async () => {
    const res = await post(`/api/admin/dashboards/${dashboardId}/share`, { roleId });
    expect(res.status).toBe(422);
    const text = await res.text();
    // The message has to name the alternative — a bare refusal leaves the
    // caller with the same wrong belief they arrived with.
    expect(text).toContain("public");
  });

  test("a plain share works, and the embed sees only what `public` can", async () => {
    const res = await post(`/api/admin/dashboards/${dashboardId}/share`, {});
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(token).toBeTruthy();

    const embed = await h.fetch(`/api/public/dashboards/${token}`);
    expect(embed.status).toBe(200);
    const body = (await embed.json()) as {
      data: { panels: { data: unknown[]; error?: string }[] };
    };
    const panel = body.data.panels[0]!;
    // `public` holds no grant on `sales`, so the panel is refused — the clamp
    // Faz 4 established. This is what the embed sees whatever role anyone
    // names, and the reason naming one was never worth accepting.
    expect(panel.data).toEqual([]);
    expect(panel.error ?? "").toContain("Not permitted");
  });

  test("granting `public` read is what makes the embed show the panel", async () => {
    // The vacuous-pass guard, and the documented way to publish a panel: the
    // refusal above must be the ROLE's doing, not a broken embed path.
    const publicRole = (await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; name: string }[];
    };
    const pub = publicRole.data.find((r) => r.name === "public");
    expect(pub).toBeDefined();
    expect(
      (await post(`/api/roles/${pub!.id}/permissions`, { collection: "sales", action: "read" }))
        .status,
    ).toBe(201);

    const res = await post(`/api/admin/dashboards/${dashboardId}/share`, {});
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };

    const embed = await h.fetch(`/api/public/dashboards/${token}`);
    expect(embed.status).toBe(200);
    const body = (await embed.json()) as {
      data: { panels: { data: Record<string, unknown>[]; error?: string }[] };
    };
    const panel = body.data.panels[0]!;
    expect(panel.error ?? null).toBeNull();
    expect(panel.data.length).toBeGreaterThan(0);
  });

  test("the dashboard view no longer carries embedRoleId", async () => {
    const res = await h.fetch(`/api/admin/dashboards/${dashboardId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect("embedRoleId" in body.data).toBe(false);
    // The rest of the embed surface is untouched.
    expect("embedEnabled" in body.data).toBe(true);
  });
});
