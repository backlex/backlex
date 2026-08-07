import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { WebhooksPage } from "../../src/client/admin/pages/automation/webhooks";
import { renderWithProviders } from "./render";

// Page-level render coverage for the webhooks list. The load path maps the
// API's camelCase row (consecutiveFailures / disabledReason) into the local
// HookRow — exactly the snake_case-vs-camelCase seam where a silent-undefined
// slips through every server spec (see testing-gaps: a mismatched key renders
// as "healthy" instead of a type error). These tests pin that binding: a
// tripped breaker must render its badge, not default to OK.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const mockFetchRoutes = () => {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/webhooks/_deliveries")) return json({ data: [] });
    if (url.includes("/api/webhooks"))
      return json({
        data: [
          {
            id: "w1",
            name: "Order sync",
            url: "https://example.com/hooks/orders",
            events: ["items.orders.*"],
            headers: null,
            secret: null,
            active: true,
            consecutiveFailures: 0,
            disabledReason: null,
          },
          {
            id: "w2",
            name: "Dead endpoint",
            url: "https://example.com/hooks/dead",
            events: ["items.*"],
            headers: null,
            secret: null,
            active: false,
            consecutiveFailures: 15,
            disabledReason: "15 consecutive failed deliveries",
          },
        ],
      });
    if (url.includes("/api/admin/metrics/entities"))
      return json({ data: { webhooks: { w1: { deliveries: 42, lastDelivery: null } } } });
    return json({ error: { code: "NOT_FOUND", message: `unmocked ${url}` } }, 404);
  }) as unknown as typeof fetch;
};

describe("<WebhooksPage>", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    cleanup();
    global.fetch = realFetch;
  });

  test("binds the camelCase API rows: names, events, and breaker state render", async () => {
    mockFetchRoutes();
    renderWithProviders(<WebhooksPage pushToast={() => {}} />);

    await waitFor(() => expect(screen.getByText("Order sync")).toBeTruthy());
    expect(screen.getByText("Dead endpoint")).toBeTruthy();
    // disabledReason → the auto-disabled badge. If the camelCase key ever
    // stopped binding (h.disabled_reason etc.) this would render as healthy.
    expect(screen.getByText("auto-disabled")).toBeTruthy();
  });
});
