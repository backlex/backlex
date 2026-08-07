import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { ScimCard } from "../../src/client/admin/pages/settings/scim-card";
import { renderWithProviders } from "./render";

// The card's whole reason to exist is that the bearer token is shown EXACTLY
// once — there is no read-back path. So these pin the two things that would
// quietly break that: the token must appear after issuing, and it must never
// come from (or leak into) the ordinary config read, which only ever carries a
// display prefix.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CONFIG = {
  id: "s1",
  enabled: true,
  tokenPrefix: "scim_abc123",
  defaultRoleId: null,
  lastRequestAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const mockRoutes = (config: unknown, extra: Record<string, unknown> = {}) => {
  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/admin/scim/token")) {
      return json({ data: CONFIG, token: "scim_PLAINTEXT_ONLY_ONCE", baseUrl: "https://x.test/api/scim/v2" });
    }
    if (url.includes("/api/admin/scim")) {
      if (init?.method === "PATCH") return json({ data: { ...CONFIG, ...(extra as object) } });
      if (init?.method === "DELETE") return json({ ok: true });
      return json({ data: config });
    }
    return json({ data: [] });
  }) as unknown as typeof fetch;
};

const ROLES = [{ id: "r1", name: "member" }];

afterEach(() => cleanup());

describe("ScimCard", () => {
  test("offers to enable when SCIM has never been set up", async () => {
    mockRoutes(null);
    renderWithProviders(<ScimCard availableRoles={ROLES} pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Enable SCIM")).toBeDefined());
    // No token panel and no rotate affordance before there is anything to rotate.
    expect(screen.queryByText("Rotate token")).toBeNull();
    expect(screen.queryByText(/shown only once/)).toBeNull();
  });

  test("an existing config shows its prefix and never a full token", async () => {
    mockRoutes(CONFIG);
    const { container } = renderWithProviders(
      <ScimCard availableRoles={ROLES} pushToast={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText("Rotate token")).toBeDefined());
    expect(container.innerHTML).toContain("scim_abc123");
    // The read path has no token to leak, so nothing plaintext may appear.
    expect(container.innerHTML).not.toContain("PLAINTEXT");
  });

  test("\"never used\" is shown until the IdP actually calls", async () => {
    mockRoutes(CONFIG);
    renderWithProviders(<ScimCard availableRoles={ROLES} pushToast={() => {}} />);
    // The single most useful diagnostic when a sync is misconfigured.
    await waitFor(() => expect(screen.getByText("never used")).toBeDefined());
  });

  test("a disabled config is badged, not silently identical to an active one", async () => {
    mockRoutes({ ...CONFIG, enabled: false });
    renderWithProviders(<ScimCard availableRoles={ROLES} pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("disabled")).toBeDefined());
    expect(screen.queryByText("active")).toBeNull();
  });

  test("issuing surfaces the token and the base URL exactly once", async () => {
    mockRoutes(null);
    renderWithProviders(<ScimCard availableRoles={ROLES} pushToast={() => {}} />);
    const btn = await waitFor(() => screen.getByText("Enable SCIM"));
    await act(async () => {
      btn.click();
    });

    await waitFor(() => expect(screen.getByText(/shown only once/)).toBeDefined());
    const inputs = [...document.querySelectorAll("input[readonly]")] as HTMLInputElement[];
    const values = inputs.map((i) => i.value);
    expect(values).toContain("scim_PLAINTEXT_ONLY_ONCE");
    expect(values).toContain("https://x.test/api/scim/v2");

    // Dismissing drops it from the DOM — it is not recoverable afterwards.
    const saved = screen.getByText("I've saved it");
    await act(async () => {
      saved.click();
    });
    await waitFor(() => expect(screen.queryByText(/shown only once/)).toBeNull());
    expect(document.body.innerHTML).not.toContain("scim_PLAINTEXT_ONLY_ONCE");
  });
});
