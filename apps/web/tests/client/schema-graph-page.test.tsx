/**
 * The schema graph's reading aids, driven through the real page.
 *
 * React Flow renders its nodes under happy-dom but not its edges: an edge is
 * drawn between measured handle positions, and there is no layout engine here
 * to measure them. So these tests read what is observable on the nodes — which
 * rows a card draws, and the class that lights or fades it — and leave edge
 * styling (labels only on focused relations) to a browser pass.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { SchemaGraphPage } from "../../src/client/admin/pages/data/schema-graph";
import { renderWithProviders } from "./render";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Three groups: an order points at a customer; products relate to nothing.
const COLLECTIONS = [
  {
    slug: "orders",
    group: "Orders",
    ownerScoped: false,
    versioned: false,
    fields: [
      { name: "customer", type: "relation", to: "customers" },
      { name: "total_due", type: "number" },
    ],
  },
  {
    slug: "customers",
    group: "Customers",
    ownerScoped: false,
    versioned: false,
    fields: [{ name: "email_address", type: "text" }],
  },
  {
    slug: "products",
    group: "Catalog",
    ownerScoped: false,
    versioned: false,
    fields: [{ name: "title", type: "text" }],
  },
];

const DENSITY_KEY = "backlex.schemaGraph.density";

const mountPage = async () => {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/collections")) {
      return json({ data: COLLECTIONS, meta: { groups: ["Catalog", "Orders", "Customers"] } });
    }
    if (url.includes("/api/admin/settings")) return json({ data: {} });
    return json({ error: { code: "NOT_FOUND", message: `unmocked ${url}` } }, 404);
  }) as unknown as typeof fetch;
  renderWithProviders(<SchemaGraphPage pushToast={() => {}} />);
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node").length).toBe(3), { timeout: 5000 });
};

/** The canvas only — the relations table below it repeats the same names. */
const canvas = () => within(document.querySelector(".react-flow") as HTMLElement);

const node = (slug: string) => document.querySelector(`.react-flow__node[data-id="${slug}"]`) as HTMLElement | null;

/** Each card on the canvas with its look: lit (""), faded, or context. */
const looks = () =>
  Object.fromEntries(
    [...document.querySelectorAll(".react-flow__node")].map((n) => {
      const cls = n.classList;
      const look = cls.contains("erd-dim") ? "faded" : cls.contains("erd-context") ? "context" : "lit";
      return [n.getAttribute("data-id"), look];
    }),
  );

const press = async (target: Window | Element, key: string) => {
  await act(async () => {
    fireEvent.keyDown(target, { key });
  });
};

/** Radix opens on pointerdown and commits on pointerup, neither of which
 *  `.click()` alone produces in happy-dom. */
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

const findTable = async (query: string, slug: string) => {
  await act(async () => {
    fireEvent.click(screen.getByText("Find a table…"));
  });
  const input = document.querySelector("[cmdk-input]") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: query } });
  });
  const item = document.querySelector(`[cmdk-item][data-value="${slug}"]`) as HTMLElement;
  await act(async () => {
    fireEvent.click(item);
  });
};

describe("<SchemaGraphPage> reading aids", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    cleanup();
    global.fetch = realFetch;
    localStorage.removeItem(DENSITY_KEY);
  });

  test("relations only draws each card's relation rows; all fields brings the rest back", async () => {
    await mountPage();
    // Three tables is a small schema, so it opens on every field.
    expect(canvas().queryByText("total_due")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Relations only"));
    });
    expect(canvas().queryByText("total_due")).toBeNull();
    expect(canvas().queryByText("customer")).toBeTruthy();
    // The choice is the viewer's, and survives the next visit.
    expect(localStorage.getItem(DENSITY_KEY)).toBe("compact");

    await act(async () => {
      fireEvent.click(screen.getByText("All fields"));
    });
    expect(canvas().queryByText("total_due")).toBeTruthy();
  });

  test("selecting a table keeps it and its neighbours lit and fades the rest; Escape clears it", async () => {
    await mountPage();
    expect(looks()).toEqual({ orders: "lit", customers: "lit", products: "lit" });

    await act(async () => {
      fireEvent.click(node("orders")!);
    });
    expect(node("orders")!.classList.contains("selected")).toBe(true);
    expect(looks()).toEqual({ orders: "lit", customers: "lit", products: "faded" });

    await press(window, "Escape");
    expect(looks()).toEqual({ orders: "lit", customers: "lit", products: "lit" });
    expect(node("orders")!.classList.contains("selected")).toBe(false);
  });

  test("hovering previews the same focus, and a background tap clears a preview a touch screen never ends", async () => {
    await mountPage();
    await act(async () => {
      fireEvent.mouseEnter(node("orders")!);
      await new Promise((r) => setTimeout(r, 260));
    });
    expect(looks()).toEqual({ orders: "lit", customers: "lit", products: "faded" });

    // A tap: mouseenter arrived, mouseleave never will. Tapping the background
    // must still bring the whole canvas back.
    await act(async () => {
      fireEvent.click(document.querySelector(".react-flow__pane") as HTMLElement);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(looks()).toEqual({ orders: "lit", customers: "lit", products: "lit" });
  });

  test("the fade rules name React Flow's classes the way Tailwind can read them", async () => {
    await mountPage();
    const variants = (document.querySelector(".react-flow") as HTMLElement).className
      .split(/\s+/)
      .filter((c) => c.startsWith("[&_.react-flow"));
    expect(variants.length).toBeGreaterThanOrEqual(5);
    // Tailwind decodes `_` inside an arbitrary variant as a space, so an
    // unescaped `react-flow__node` compiles to `.react-flow node`: a valid
    // selector that matches nothing, and every class assertion above would
    // still pass while no card on screen ever faded.
    expect(variants.filter((c) => c.includes("react-flow__"))).toEqual([]);
  });

  test("Backspace does not take a selected card off the canvas", async () => {
    await mountPage();
    await act(async () => {
      fireEvent.click(node("products")!);
    });
    await press(document.querySelector(".react-flow") as HTMLElement, "Backspace");
    await press(document.body, "Backspace");
    expect(node("products")).toBeTruthy();
  });

  test("find a table jumps to it and focuses it", async () => {
    await mountPage();
    await findTable("prod", "products");
    expect(node("products")!.classList.contains("selected")).toBe(true);
    expect(looks()).toEqual({ orders: "faded", customers: "faded", products: "lit" });
  });

  test("the group filter shows one group, and fades in the tables it relates to", async () => {
    await mountPage();
    await choose(screen.getByRole("combobox"), "Orders");
    // Catalog relates to nothing in Orders, so it leaves the canvas entirely.
    expect(node("products")).toBeNull();
    expect(looks()).toEqual({ orders: "lit", customers: "context" });

    // Jumping to a table the filter hides widens the canvas back out.
    await findTable("prod", "products");
    await waitFor(() => expect(node("products")).toBeTruthy());
    expect(node("products")!.classList.contains("selected")).toBe(true);
  });
});
