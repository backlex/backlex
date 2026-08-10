import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { AuthSettingsPage } from "../../src/client/admin/pages/settings/auth-settings";
import { OidcProviderDialog } from "../../src/client/admin/pages/settings/oidc-provider-dialog";
import { renderWithProviders } from "./render";

/**
 * Render coverage for the generic OIDC / OAuth2 SSO admin surface.
 *
 * The edges worth pinning here are all failure/omission shaped, not happy-path:
 *
 *  - `GET /api/admin/oidc/providers` 500s on an instance whose `oidc_providers`
 *    table has never been migrated. The section must degrade to "empty", the
 *    same way the SAML block does — a thrown load would take the whole auth
 *    settings page down with it.
 *  - The client secret is write-only (`hasClientSecret: boolean`, no read-back).
 *    Edit mode must advertise "leave blank to keep" rather than presenting what
 *    looks like an empty required field, and a blank field must be OMITTED from
 *    the PATCH — sending `clientSecret: ""` would read as an intentional clear.
 *  - Discovery failures carry an actionable server message ("Discovery URL
 *    responded 404"); swallowing it leaves the admin with no idea what broke.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const PROVIDER = {
  id: "p1",
  name: "Acme Okta",
  slug: "acme-okta",
  clientId: "0oa1b2c3d4",
  hasClientSecret: true,
  discoveryUrl: "https://acme.okta.com/.well-known/openid-configuration",
  authorizationUrl: "https://acme.okta.com/oauth2/v1/authorize",
  tokenUrl: "https://acme.okta.com/oauth2/v1/token",
  userInfoUrl: null,
  scopes: ["openid", "profile", "email"],
  pkce: true,
  emailClaim: null,
  groupsClaim: null,
  defaultRoleId: null,
  groupsToRoles: null,
  linkByVerifiedEmail: false,
  enabled: true,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const SECRETLESS_PROVIDER = {
  ...PROVIDER,
  id: "p2",
  name: "Keycloak dev",
  slug: "keycloak-dev",
  hasClientSecret: false,
  enabled: false,
};

/** Mock the whole auth-settings load fan-out; `oidc` decides what the OIDC
 *  list endpoint does (rows, or a hard failure). */
const mockAuthSettings = (oidc: { rows?: unknown[]; fail?: boolean }) => {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/admin/oidc/providers")) {
      return oidc.fail
        ? json({ error: { code: "INTERNAL", message: "no such table: oidc_providers" } }, 500)
        : json({ data: oidc.rows ?? [] });
    }
    if (url.includes("/api/admin/saml/providers")) return json({ data: [] });
    if (url.includes("/api/admin/ldap-config")) return json({ data: null });
    if (url.includes("/api/admin/auth/sessions")) return json({ data: [] });
    if (url.includes("/api/admin/auth/config"))
      return json({ data: { providers: {}, policy: {}, sessionLifetime: "30d", redirectUrls: [] } });
    if (url.includes("/api/tenants"))
      return json({
        data: [{ id: "t1", slug: "acme", name: "Acme", project: "p", branch: "main", env: "prod", mark: null, color: null, role: "admin" }],
        active: "t1",
      });
    if (url.includes("/api/roles")) return json({ data: [] });
    return json({ data: [] });
  }) as unknown as typeof fetch;
};

describe("OIDC providers admin UI", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    cleanup();
    global.fetch = realFetch;
  });

  test("lists provider rows with name, slug and issuer", async () => {
    mockAuthSettings({ rows: [PROVIDER] });
    renderWithProviders(<AuthSettingsPage pushToast={() => {}} />, {
      // The open panel comes from the path now — see `useUrlTab`.
      route: "/authentication/sso",
    });

    await waitFor(() => expect(screen.getByText("Acme Okta")).toBeTruthy());
    // slug + discovery URL share one mono line under the name.
    expect(screen.getByText(/acme-okta/)).toBeTruthy();
    expect(screen.getByText("OIDC / OAuth2 SSO")).toBeTruthy();
  });

  test("a row with no stored client secret is called out as broken", async () => {
    mockAuthSettings({ rows: [SECRETLESS_PROVIDER] });
    renderWithProviders(<AuthSettingsPage pushToast={() => {}} />, {
      // The open panel comes from the path now — see `useUrlTab`.
      route: "/authentication/sso",
    });

    await waitFor(() => expect(screen.getByText("Keycloak dev")).toBeTruthy());
    expect(screen.getByText("No client secret stored — login will fail.")).toBeTruthy();
  });

  test("a failing list (table not migrated) renders as empty, not as a crash", async () => {
    mockAuthSettings({ fail: true });
    renderWithProviders(<AuthSettingsPage pushToast={() => {}} />, {
      // The open panel comes from the path now — see `useUrlTab`.
      route: "/authentication/sso",
    });

    // The rest of the page still loads, and the OIDC card shows its empty state.
    await waitFor(() => expect(screen.getByText("OIDC / OAuth2 SSO")).toBeTruthy());
    expect(
      screen.getByText(/No OIDC providers configured\./),
    ).toBeTruthy();
    // The SAML card is rendered after it — proof the throw didn't unmount the page.
    expect(screen.getByText("SAML 2.0 SSO")).toBeTruthy();
  });

  test("edit mode offers 'leave blank to keep' instead of an empty required secret field", () => {
    renderWithProviders(
      <OidcProviderDialog
        existing={PROVIDER}
        workspaceSlug="acme"
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    const secret = screen.getByLabelText(/Client secret/) as HTMLInputElement;
    expect(secret.value).toBe("");
    expect(secret.placeholder).toBe("leave blank to keep the current secret");
    expect(
      screen.getByText(/Leave this blank to keep the current secret\./),
    ).toBeTruthy();
    // Not a dead end: the form is submittable with the secret untouched.
    expect((screen.getByText("Save").closest("button") as HTMLButtonElement).disabled).toBe(false);
  });

  test("a blank secret is omitted from the PATCH body, never sent as an empty string", () => {
    let body: Record<string, unknown> | null = null;
    renderWithProviders(
      <OidcProviderDialog
        existing={PROVIDER}
        workspaceSlug="acme"
        onClose={() => {}}
        onSave={(b) => { body = b as unknown as Record<string, unknown>; }}
      />,
    );
    fireEvent.click(screen.getByText("Save").closest("button") as HTMLButtonElement);
    expect(body).not.toBeNull();
    expect("clientSecret" in (body as unknown as object)).toBe(false);
  });

  test("a typed secret does travel, so rotation still works", () => {
    let body: Record<string, unknown> | null = null;
    renderWithProviders(
      <OidcProviderDialog
        existing={PROVIDER}
        workspaceSlug="acme"
        onClose={() => {}}
        onSave={(b) => { body = b as unknown as Record<string, unknown>; }}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: " rotated-secret " } });
    fireEvent.click(screen.getByText("Save").closest("button") as HTMLButtonElement);
    expect((body as unknown as { clientSecret?: string })?.clientSecret).toBe("rotated-secret");
  });

  test("create mode cannot submit without a client secret", () => {
    renderWithProviders(
      <OidcProviderDialog
        existing={null}
        workspaceSlug="acme"
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Keycloak" } });
    fireEvent.change(screen.getByLabelText(/Client ID/), { target: { value: "abc" } });
    fireEvent.change(screen.getByLabelText(/Discovery URL/), {
      target: { value: "https://kc.example.com/realms/main" },
    });
    const add = screen.getByText("Add provider").closest("button") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: "s3cret" } });
    expect((screen.getByText("Add provider").closest("button") as HTMLButtonElement).disabled).toBe(false);
  });

  test("a discovery failure surfaces the API's own message", async () => {
    global.fetch = mock(async () =>
      json({ error: { code: "VALIDATION", message: "Discovery URL responded 404" } }, 422),
    ) as unknown as typeof fetch;

    renderWithProviders(
      <OidcProviderDialog
        existing={null}
        workspaceSlug="acme"
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Discovery URL/), {
      target: { value: "https://issuer.example.com" },
    });
    fireEvent.click(screen.getByText("Fetch endpoints").closest("button") as HTMLButtonElement);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Discovery URL responded 404"));
    // A failed fetch must not half-fill the endpoint fields.
    expect((screen.getByLabelText(/Authorization URL/) as HTMLInputElement).value).toBe("");
  });

  test("a successful discovery fills the endpoint fields", async () => {
    global.fetch = mock(async () =>
      json({
        data: {
          issuer: "https://issuer.example.com",
          authorizationUrl: "https://issuer.example.com/authorize",
          tokenUrl: "https://issuer.example.com/token",
          userInfoUrl: "https://issuer.example.com/userinfo",
          scopesSupported: ["openid", "email"],
        },
      }),
    ) as unknown as typeof fetch;

    renderWithProviders(
      <OidcProviderDialog
        existing={null}
        workspaceSlug="acme"
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Discovery URL/), {
      target: { value: "https://issuer.example.com" },
    });
    fireEvent.click(screen.getByText("Fetch endpoints").closest("button") as HTMLButtonElement);

    await waitFor(() =>
      expect((screen.getByLabelText(/Authorization URL/) as HTMLInputElement).value).toBe(
        "https://issuer.example.com/authorize",
      ),
    );
    expect((screen.getByLabelText(/Token URL/) as HTMLInputElement).value).toBe(
      "https://issuer.example.com/token",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
