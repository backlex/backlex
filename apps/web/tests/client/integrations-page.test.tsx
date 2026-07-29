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
  kinds: ["slack", "jira"],
  fields: {
    slack: [{ key: "webhookUrl", label: "Incoming webhook URL", secret: true }],
    jira: [{ key: "baseUrl", label: "Base URL" }],
  },
  providers: [
    { id: "slack", label: "Slack", category: "chat", capabilities: ["sink"] },
    { id: "jira", label: "Jira", category: "issue-tracking", capabilities: ["sink"] },
  ],
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
