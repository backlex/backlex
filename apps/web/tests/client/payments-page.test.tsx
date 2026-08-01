import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { PaymentsPage } from "../../src/client/admin/pages/payments";
import { renderWithProviders } from "./render";

// Render coverage for the Payments page, pinning two things a server-side test
// cannot see.
//
// 1. **A required dropdown must arrive pre-selected.** The connect dialog shows
//    a `choices` field's first option on the trigger; if that value is not also
//    in state, `ready` stays false and Connect is permanently disabled with
//    nothing on the form saying why. That made every provider with a required
//    `environment` — Paddle, iyzico, and now Adyen — unconnectable from the UI.
//
// 2. **`reconcilable: false` must hide "Sync now".** Offering the button for an
//    acquirer with no object catalog can only ever produce an explanation.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const CATALOG = {
  providers: [
    {
      provider: "stripe",
      label: "Stripe",
      checkoutMode: "adhoc",
      reconcilable: true,
      fields: [{ key: "apiKey", label: "Secret API key", secret: true }],
    },
    {
      provider: "adyen",
      label: "Adyen",
      checkoutMode: "adhoc",
      reconcilable: false,
      fields: [
        { key: "apiKey", label: "API key", secret: true },
        { key: "merchantAccount", label: "Merchant account" },
        { key: "webhookSecret", label: "HMAC key", secret: true },
        // Required, with a finite value set — the field this test exists for.
        { key: "environment", label: "Environment", choices: ["test", "live"] },
        { key: "liveUrlPrefix", label: "Live URL prefix", optional: true },
      ],
    },
  ],
  recordKinds: ["customer", "subscription", "invoice", "payment"],
};

const connection = (provider: string) => ({
  id: `conn_${provider}`,
  provider,
  status: "connected",
  config: { apiKey: "••••••••" },
  webhookPath: `/api/payments/webhook/pwh_${provider}`,
  lastEventAt: null,
  lastSyncAt: null,
  lastSyncError: null,
});

const mockRoutes = (connected: unknown[]) => {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/payments/catalog")) return json(CATALOG);
    if (url.includes("/payments/events")) return json({ data: [] });
    if (url.includes("/payments/providers")) return json({ data: connected });
    return json({ data: [] });
  }) as unknown as typeof fetch;
};

afterEach(() => cleanup());

describe("PaymentsPage", () => {
  test("a required dropdown is pre-selected, so Connect is reachable", async () => {
    mockRoutes([]);
    renderWithProviders(<PaymentsPage pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Adyen")).toBeDefined());

    // Open Adyen's connect dialog — walk up from the label to the card that
    // actually holds a button.
    let card: HTMLElement | null = screen.getByText("Adyen");
    let connectButton: HTMLButtonElement | undefined;
    for (let i = 0; i < 8 && card; i++) {
      connectButton = [...card.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Connect",
      );
      if (connectButton) break;
      card = card.parentElement;
    }
    expect(connectButton).toBeDefined();
    fireEvent.click(connectButton as HTMLButtonElement);

    const dialog = await screen.findByRole("dialog");
    const inputs = [...dialog.querySelectorAll("input")];
    // Four text/password inputs; `environment` renders as a Select instead.
    expect(inputs).toHaveLength(4);

    // Fill everything that is required and typed. `liveUrlPrefix` is optional
    // and `environment` is the dropdown — deliberately left untouched, because
    // the whole point is that its displayed default already counts.
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: "AQE1hmfx" } });
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: "BacklexECOM" } });
    fireEvent.change(inputs[2] as HTMLInputElement, { target: { value: "9EB1C7A8" } });

    const submit = [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Connect",
    ) as HTMLButtonElement;
    expect(submit).toBeDefined();
    // Without the seed this is still disabled and no field looks unfilled.
    expect(submit.disabled).toBe(false);
  });

  test("a provider with no object catalog does not offer Sync now", async () => {
    mockRoutes([connection("adyen")]);
    renderWithProviders(<PaymentsPage pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Adyen")).toBeDefined());
    await waitFor(() => expect(screen.getByText("Payment link")).toBeDefined());
    expect(screen.queryByText("Sync now")).toBeNull();
  });

  test("a provider with a catalog still offers Sync now", async () => {
    mockRoutes([connection("stripe")]);
    renderWithProviders(<PaymentsPage pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Stripe")).toBeDefined());
    await waitFor(() => expect(screen.getByText("Sync now")).toBeDefined());
  });
});
