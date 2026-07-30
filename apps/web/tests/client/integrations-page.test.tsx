import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { IntegrationsPage } from "../../src/client/admin/pages/integrations";
import { renderWithProviders } from "./render";

// Page-level render coverage for the integrations list. Same seam the webhooks
// page test guards: the API row is camelCase (consecutiveFailures /
// disabledReason) and a mismatched key would silently render as "healthy"
// rather than raise. These pin that a paused integration shows its badge and
// reason, and that a masked secret is what reaches the DOM.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const CATALOG = {
  kinds: ["slack", "jira", "notion"],
  fields: {
    slack: [{ key: "webhookUrl", label: "Incoming webhook URL", secret: true }],
    jira: [{ key: "baseUrl", label: "Base URL" }],
    notion: [
      { key: "clientId", label: "OAuth client ID" },
      { key: "clientSecret", label: "OAuth client secret", secret: true },
      { key: "pageId", label: "Target page ID" },
    ],
  },
  providers: [
    { id: "slack", label: "Slack", category: "chat", capabilities: ["sink"], oauth: false },
    { id: "jira", label: "Jira", category: "issue-tracking", capabilities: ["sink"], oauth: false },
    { id: "notion", label: "Notion", category: "productivity", capabilities: ["sink"], oauth: true },
  ],
  oauthRedirectUri: "https://admin.example/api/admin/integrations/oauth/callback",
};

const mockRoutes = (integrations: unknown[]) => {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/integrations/catalog")) return json({ data: CATALOG });
    if (url.includes("/deliveries")) return json({ data: [] });
    if (url.includes("/api/admin/integrations")) return json({ data: integrations });
    if (url.includes("/api/collections")) return json({ data: [] });
    return json({ data: [] });
  }) as unknown as typeof fetch;
};

afterEach(() => cleanup());

describe("IntegrationsPage", () => {
  test("renders every catalog provider, connected or not", async () => {
    mockRoutes([]);
    renderWithProviders(<IntegrationsPage pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Slack")).toBeDefined());
    expect(screen.getByText("Jira")).toBeDefined();
  });

  test("a healthy connection shows Connected, not the failure line", async () => {
    mockRoutes([
      {
        id: "i1",
        kind: "slack",
        status: "connected",
        events: null,
        config: { webhookUrl: "enc:…abc=" },
        lastEventAt: null,
        consecutiveFailures: 0,
        disabledReason: null,
      },
    ]);
    renderWithProviders(<IntegrationsPage pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Connected")).toBeDefined());
    expect(screen.queryByText("Paused")).toBeNull();
    expect(screen.queryByText(/failed deliveries in a row/)).toBeNull();
  });

  test("accumulating failures surface on a still-connected integration", async () => {
    mockRoutes([
      {
        id: "i1",
        kind: "slack",
        status: "connected",
        events: null,
        config: {},
        consecutiveFailures: 4,
        disabledReason: null,
      },
    ]);
    renderWithProviders(<IntegrationsPage pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText(/4 failed deliveries in a row/)).toBeDefined());
  });

  test("a breaker-paused integration shows the badge, the reason, and Resume", async () => {
    mockRoutes([
      {
        id: "i1",
        kind: "slack",
        status: "disabled",
        events: null,
        config: {},
        consecutiveFailures: 15,
        disabledReason: "Auto-disabled after 15 consecutive failed deliveries (last: HTTP 500)",
      },
    ]);
    renderWithProviders(<IntegrationsPage pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Paused")).toBeDefined());
    expect(screen.getByText(/Auto-disabled after 15 consecutive/)).toBeDefined();
    expect(screen.getByText("Resume")).toBeDefined();
    // Deliveries stays reachable while paused — it's how you find out why.
    expect(screen.getByText("Deliveries")).toBeDefined();
  });

  test("the masked secret is what reaches the DOM, never a plaintext token", async () => {
    mockRoutes([
      {
        id: "i1",
        kind: "slack",
        status: "connected",
        events: null,
        config: { webhookUrl: "enc:…Zm8=" },
        consecutiveFailures: 0,
      },
    ]);
    const { container } = renderWithProviders(<IntegrationsPage pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Connected")).toBeDefined());
    expect(container.innerHTML).not.toContain("hooks.slack.com");
  });
});

// An OAuth provider has a state the others do not: the row exists and reads
// `status: connected`, but no token has been issued yet, so nothing delivers.
// Showing that as "Connected" would tell the operator the opposite of the
// truth, and these pin the distinction from both directions.
const NOTION_ROW = {
  id: "n1",
  kind: "notion",
  status: "connected",
  events: null,
  lastEventAt: null,
  consecutiveFailures: 0,
  lastFailureAt: null,
  disabledReason: null,
};

describe("an OAuth provider that has not been authorized", () => {
  test("reads as Not authorized, not as Connected", async () => {
    mockRoutes([{ ...NOTION_ROW, config: { clientId: "cid", clientSecret: "en…c=" } }]);
    renderWithProviders(<IntegrationsPage pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Not authorized")).toBeDefined());
    expect(screen.getByText("Authorize")).toBeDefined();
    // The consequence, spelled out rather than left to be inferred.
    expect(screen.getByText(/nothing is delivered until you do/)).toBeDefined();
  });

  test("once a token exists it reads as Connected and offers reauthorization", async () => {
    mockRoutes([
      { ...NOTION_ROW, config: { clientId: "cid", _oauthAccessToken: "nt••••ken" } },
    ]);
    renderWithProviders(<IntegrationsPage pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Connected")).toBeDefined());
    expect(screen.queryByText("Not authorized")).toBeNull();
    expect(screen.getByText("Reauthorize")).toBeDefined();
  });

  test("the masked token never reaches the DOM in full", async () => {
    mockRoutes([{ ...NOTION_ROW, config: { _oauthAccessToken: "nt••••ken" } }]);
    renderWithProviders(<IntegrationsPage pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Connected")).toBeDefined());
    // The API masks it, but the page must not render even the masked form —
    // there is no reason for a credential to appear on a card at all.
    expect(document.body.textContent).not.toContain("nt••••ken");
  });

  test("a non-OAuth provider gets no authorize affordance", async () => {
    mockRoutes([
      {
        id: "i9",
        kind: "slack",
        status: "connected",
        events: null,
        config: { webhookUrl: "enc:…abc=" },
        lastEventAt: null,
        consecutiveFailures: 0,
        lastFailureAt: null,
        disabledReason: null,
      },
    ]);
    renderWithProviders(<IntegrationsPage pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Connected")).toBeDefined());
    expect(screen.queryByText("Authorize")).toBeNull();
    expect(screen.queryByText("Reauthorize")).toBeNull();
  });
});

// The provider redirects the browser back with a fixed status slug and no other
// signal. If the page did not act on it, a completed — or a rejected —
// authorization would look exactly like an ordinary page load.
describe("the OAuth return status", () => {
  const returnWith = (status: string) => {
    window.history.replaceState(null, "", `/integrations?oauth=${status}&keep=1`);
  };
  const toasts: string[] = [];

  afterEach(() => {
    toasts.length = 0;
    window.history.replaceState(null, "", "/integrations");
  });

  test("a successful return is reported and the param is dropped", async () => {
    mockRoutes([]);
    returnWith("connected");
    renderWithProviders(<IntegrationsPage pushToast={(m) => toasts.push(m)} />);
    await waitFor(() => expect(toasts).toContain("Account connected."));
    // Left in place, a refresh would repeat the toast; unrelated params stay.
    expect(window.location.search).toBe("?keep=1");
  });

  test("a cancelled consent screen is not reported as a failure", async () => {
    mockRoutes([]);
    returnWith("denied");
    renderWithProviders(<IntegrationsPage pushToast={(m) => toasts.push(m)} />);
    await waitFor(() => expect(toasts).toContain("Authorization was cancelled."));
  });

  test("a failed exchange names the three things worth checking", async () => {
    mockRoutes([]);
    returnWith("failed");
    renderWithProviders(<IntegrationsPage pushToast={(m) => toasts.push(m)} />);
    // The server deliberately does not say which of the reasons applied, so the
    // UI has to be the one that tells the operator where to look.
    await waitFor(() => expect(toasts[0]).toMatch(/client ID, secret and redirect URI/));
  });

  test("an expired session says so instead of blaming the credentials", async () => {
    mockRoutes([]);
    returnWith("signed_out");
    renderWithProviders(<IntegrationsPage pushToast={(m) => toasts.push(m)} />);
    await waitFor(() => expect(toasts).toContain("Sign in again and retry the connection."));
  });

  test("an ordinary load reports nothing", async () => {
    mockRoutes([]);
    renderWithProviders(<IntegrationsPage pushToast={(m) => toasts.push(m)} />);
    await waitFor(() => expect(screen.getByText("Slack")).toBeDefined());
    expect(toasts).toEqual([]);
  });
});
