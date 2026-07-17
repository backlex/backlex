/**
 * Workspace branding config — `/api/workspace-config`.
 *
 * Covers: the public resolved view (GET /), the admin-only raw row (GET /raw),
 * the upsert (PUT /), color validation, the public asset streamer
 * (GET /asset/{kind}) with nothing configured, and the `isValidColor`
 * service helper directly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { isValidColor } from "../src/server/services/workspace-config";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const put = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

/** Sign out the current session and sign up a fresh (non-admin) user. */
const becomeNonAdmin = async (h: TestHarness): Promise<void> => {
  await h.fetch("/api/auth/sign-out", { method: "POST" });
  const res = await h.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      email: `viewer-${Date.now()}@example.test`,
      password: "correct-horse-battery",
      name: "Viewer",
    }),
  });
  expect(res.ok).toBe(true);
};

describe("isValidColor (unit)", () => {
  test("accepts hex colors of length 3/4/6/8", () => {
    expect(isValidColor("#fff")).toBe(true);
    expect(isValidColor("#ffff")).toBe(true); // #rgba
    expect(isValidColor("#a1b2c3")).toBe(true);
    expect(isValidColor("#a1b2c3d4")).toBe(true);
    expect(isValidColor("  #fff  ")).toBe(true); // trimmed
  });

  test("rejects hex colors of invalid length", () => {
    expect(isValidColor("#ffff0")).toBe(false); // 5 digits
    expect(isValidColor("#a1b2c3d")).toBe(false); // 7 digits
    expect(isValidColor("#")).toBe(false);
  });

  test("accepts CSS color functions with safe characters", () => {
    expect(isValidColor("rgb(255, 0, 0)")).toBe(true);
    expect(isValidColor("rgba(255, 0, 0, 0.5)")).toBe(true);
    expect(isValidColor("hsl(200 50% 50%)")).toBe(true);
    expect(isValidColor("oklch(0.63 0.16 253)")).toBe(true);
    expect(isValidColor("oklab(0.5 -0.1 0.1)")).toBe(true);
  });

  test("rejects named colors, keywords, and injection attempts", () => {
    expect(isValidColor("red")).toBe(false);
    expect(isValidColor("url(javascript:alert(1))")).toBe(false);
    expect(isValidColor("oklch(0.5 0.1 200); } </style>")).toBe(false);
    expect(isValidColor("rgb(alert)")).toBe(false);
    expect(isValidColor("")).toBe(false);
    // letters inside the parens (e.g. `deg`, `var(--x)`) are not allowed
    expect(isValidColor("hsl(200deg 50% 50%)")).toBe(false);
  });
});

describe("/api/workspace-config", () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  test("GET / is public and resolves to all-null defaults on a fresh instance", async () => {
    h = makeHarness();
    // No session at all — the sign-in screen must be able to read this.
    const res = await h.fetch("/api/workspace-config");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.workspaceName).toBeNull();
    expect(data.description).toBeNull();
    expect(data.logoUrl).toBeNull();
    expect(data.faviconUrl).toBeNull();
    expect(data.primaryColor).toBeNull();
    expect(data.defaultTheme).toBeNull();
  });

  test("PUT / upserts branding and GET / reflects it (same workspace)", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const saved = await h.fetch(
      "/api/workspace-config",
      put({
        workspaceName: "Acme Inc",
        description: "The Acme workspace",
        primaryColor: "#ff0000",
        defaultTheme: "dark",
      }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true });

    const res = await h.fetch("/api/workspace-config");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.workspaceName).toBe("Acme Inc");
    expect(data.description).toBe("The Acme workspace");
    expect(data.primaryColor).toBe("#ff0000");
    expect(data.defaultTheme).toBe("dark");
    // No logo/favicon file keys were set, so no asset URLs.
    expect(data.logoUrl).toBeNull();
    expect(data.faviconUrl).toBeNull();
  });

  test("PUT with '' clears a field; omitted fields stay untouched", async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/workspace-config",
      put({ workspaceName: "Acme Inc", defaultTheme: "light" }),
    );
    const res = await h.fetch("/api/workspace-config", put({ workspaceName: "" }));
    expect(res.status).toBe(200);
    const { data } = (
      (await (await h.fetch("/api/workspace-config")).json()) as {
        data: Record<string, unknown>;
      }
    );
    expect(data.workspaceName).toBeNull();
    expect(data.defaultTheme).toBe("light"); // untouched
  });

  test("GET /raw returns the workspace's own row after a PUT", async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/workspace-config",
      put({ workspaceName: "Raw Co", primaryColor: "oklch(0.63 0.16 253)" }),
    );
    const res = await h.fetch("/api/workspace-config/raw");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(typeof data.tenantId).toBe("string");
    expect(data.workspaceName).toBe("Raw Co");
    expect(data.primaryColor).toBe("oklch(0.63 0.16 253)");
    expect(data.logoFileKey).toBeNull();
    expect(data.faviconFileKey).toBeNull();
    expect(data.updatedAt).not.toBeUndefined();
  });

  test("PUT rejects an invalid primaryColor", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/workspace-config",
      put({ primaryColor: "red; } </style><script>alert(1)</script>" }),
    );
    expect(res.status).toBe(422);
    // And the invalid value never landed.
    const { data } = (
      (await (await h.fetch("/api/workspace-config")).json()) as {
        data: Record<string, unknown>;
      }
    );
    expect(data.primaryColor).toBeNull();
  });

  test("PUT rejects an unknown defaultTheme", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/workspace-config", put({ defaultTheme: "blue" }));
    expect(res.status).toBe(422);
  });

  test("GET /raw requires a session (401) and PUT is admin-only (403)", async () => {
    h = makeHarness();
    const anon = await h.fetch("/api/workspace-config/raw");
    expect(anon.status).toBe(401);

    await seedAdmin(h);
    await becomeNonAdmin(h);
    const raw = await h.fetch("/api/workspace-config/raw");
    expect(raw.status).toBe(403);
    const write = await h.fetch(
      "/api/workspace-config",
      put({ workspaceName: "Hax" }),
    );
    expect(write.status).toBe(403);
    const body = (await write.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("GET /asset/{kind} 404s cleanly when no asset is configured", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/workspace-config/asset/logo");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");

    const fav = await h.fetch("/api/workspace-config/asset/favicon");
    expect(fav.status).toBe(404);
  });

  test("GET /asset/{kind} rejects unknown kinds", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/workspace-config/asset/banner");
    expect(res.status).toBe(422);
  });
});
