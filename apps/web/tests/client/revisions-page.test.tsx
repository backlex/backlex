import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { RevisionsPage } from "../../src/client/admin/pages/observability/revisions";
import { renderWithProviders } from "./render";

// Revisions took the workspace's FIRST collection on mount and offered no way
// to pick another, so on the ecommerce playground only `addresses` had a
// browsable history. Its header also printed `c_<slug>` as though that were the
// table name (#383).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const COLLECTIONS = [
  { slug: "addresses", fields: [{ name: "line1", type: "text" }, { name: "city", type: "text" }], ownerScoped: false, versioned: false },
  { slug: "orders", fields: [{ name: "number", type: "text" }], ownerScoped: false, versioned: false, hasUpdatedAt: false },
];

let calls: string[] = [];
const realFetch = global.fetch;
beforeEach(() => {
  calls = [];
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.startsWith("/api/collections")) return json({ data: COLLECTIONS, meta: { groups: [] } });
    if (url.startsWith("/api/revisions/")) return json({ data: [] });
    const one = /^\/api\/items\/([^/?]+)\/([^/?]+)$/.exec(url);
    if (one) return json({ data: { id: one[2], number: "ORD-1", line1: "1 Market St", city: "San Francisco" } });
    if (url.startsWith("/api/items/addresses")) {
      return json({ data: [{ id: "a1", line1: "1 Market St", city: "San Francisco" }] });
    }
    if (url.startsWith("/api/items/orders")) {
      return json({ data: new URL(url, "http://x").searchParams.get("q") ? [] : [{ id: "o1", number: "ORD-1" }, { id: "o2", number: "ORD-2" }] });
    }
    return json({ error: { code: "NOT_FOUND", message: `unmocked ${url}` } }, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
});

const choose = async (trigger: HTMLElement, label: string) => {
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger.click();
  });
  const option = [...document.querySelectorAll("[role=option]")].find((o) => o.textContent?.trim() === label) as
    | HTMLElement
    | undefined;
  if (!option) throw new Error(`no option "${label}"`);
  await act(async () => {
    option.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    option.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0 }));
    option.click();
  });
};

describe("<RevisionsPage>", () => {
  test("any collection can be picked, and its rows read by label rather than by id", async () => {
    renderWithProviders(<RevisionsPage />);
    // A row with no title field reads as its first two text fields.
    await waitFor(() => expect(screen.getByText("1 Market St · San Francisco")).toBeTruthy());
    expect(document.body.textContent).not.toContain("c_addresses");

    await choose(screen.getByRole("combobox"), "orders");
    await waitFor(() => expect(screen.getByText("ORD-2")).toBeTruthy());
    // `orders` has no updated_at column, so the list sorts by the one it has.
    const ordersList = calls.find((u) => u.startsWith("/api/items/orders?"));
    expect(ordersList).toContain("sort=-created_at");
    await waitFor(() => expect(calls.some((u) => u === "/api/revisions/orders/o1")).toBe(true));
  });

  test("the item search asks the server, and says when nothing matches", async () => {
    renderWithProviders(<RevisionsPage target={{ collection: "orders", itemId: "o1" }} onTarget={() => {}} />);
    await waitFor(() => expect(screen.getByText("ORD-2")).toBeTruthy());
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search items"), { target: { value: "nothing-like-this" } });
    });
    await waitFor(() => expect(screen.getByText("No items match your search.")).toBeTruthy());
    expect(calls.some((u) => u.includes("q=nothing-like-this"))).toBe(true);
  });

  test("a routed page opens the collection and item the URL names, not the first one", async () => {
    const onTarget = mock(() => {});
    renderWithProviders(<RevisionsPage target={{ collection: "orders", itemId: "o2" }} onTarget={onTarget} />);
    await waitFor(() => expect(calls.some((u) => u === "/api/revisions/orders/o2")).toBe(true));
    expect(calls.some((u) => u.startsWith("/api/items/addresses"))).toBe(false);
    // The URL already names an item, so nothing is auto-selected over it.
    expect(onTarget).not.toHaveBeenCalled();
  });

  test("a link to a collection that is not there falls back to the first one, in place", async () => {
    const onTarget = mock(() => {});
    renderWithProviders(<RevisionsPage target={{ collection: "gone", itemId: null }} onTarget={onTarget} />);
    await waitFor(() => expect(onTarget).toHaveBeenCalledWith("addresses", null, { replace: true }));
  });
});
