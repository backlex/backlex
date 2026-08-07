import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { CollectionKpisPanel } from "../../src/client/admin/collections/collection-kpis";
import { renderWithProviders } from "./render";

/**
 * The KPIs tab of a collection.
 *
 * Behaviours worth pinning, all of which look like "it works" on a screenshot
 * of the happy path:
 *
 *  - it shows only the KPIs of THIS collection (the list endpoint returns the
 *    whole workspace, and the filtering is client-side);
 *  - "none yet" is an empty state, and it is never shown while the list is
 *    still loading — a workspace WITH KPIs must not flash "you have none";
 *  - it does not print a fabricated comparison — a KPI with no date column
 *    says "Running total", and a zero baseline shows the absolute change
 *    rather than "+100%".
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const kpi = (over: Record<string, unknown>) => ({
  id: `id-${over.slug}`,
  tenantId: "t",
  slug: over.slug,
  name: over.name,
  description: null,
  collection: over.collection,
  agg: "sum",
  field: "total",
  filter: null,
  dateField: over.dateField ?? null,
  groupBy: null,
  topN: null,
  format: "number",
  unit: over.unit ?? null,
  decimals: null,
  direction: over.direction ?? "up",
  createdBy: null,
});

const mockRoutes = (
  kpis: unknown[],
  results: Record<string, unknown>,
) => {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const run = /\/api\/admin\/kpis\/([^/]+)\/run/.exec(url);
    if (run) return json({ data: results[decodeURIComponent(run[1]!)] });
    if (url.includes("/api/admin/kpis")) return json({ data: kpis });
    return json({ data: [] });
  }) as unknown as typeof fetch;
};

afterEach(() => cleanup());

describe("CollectionKpiStrip", () => {
  test("offers an empty state when the collection has no KPIs", async () => {
    mockRoutes([kpi({ slug: "elsewhere", name: "Elsewhere", collection: "invoices" })], {});
    renderWithProviders(<CollectionKpisPanel collection="orders" />);
    await waitFor(() =>
      expect(screen.getByText("No KPIs for this collection")).toBeTruthy(),
    );
    // …and the other collection's definition is not smuggled in.
    expect(screen.queryByText("Elsewhere")).toBeNull();
  });

  test("does not flash 'none yet' while the list is still loading", async () => {
    // A workspace that HAS KPIs must never be told it has none, however
    // briefly — that is a claim, and it is wrong.
    let release: (v: Response) => void = () => {};
    global.fetch = mock(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/admin/kpis") && !/\/run/.test(url)) {
        return new Promise<Response>((res) => {
          release = res;
        });
      }
      return json({ data: null });
    }) as unknown as typeof fetch;

    renderWithProviders(<CollectionKpisPanel collection="orders" />);
    await waitFor(() => expect(document.querySelectorAll("[data-slot]").length).toBeGreaterThan(0));
    expect(screen.queryByText("No KPIs for this collection")).toBeNull();

    release(json({ data: [kpi({ slug: "mine", name: "Mine", collection: "orders" })] }));
    await waitFor(() => expect(screen.getByText("Mine")).toBeTruthy());
  });

  test("shows only this collection's KPIs", async () => {
    mockRoutes(
      [
        kpi({ slug: "mine", name: "Mine", collection: "orders", dateField: "created_at" }),
        kpi({ slug: "theirs", name: "Theirs", collection: "invoices" }),
      ],
      {
        mine: {
          slug: "mine",
          name: "Mine",
          description: null,
          collection: "orders",
          format: "number",
          unit: null,
          decimals: null,
          direction: "up",
          groupBy: null,
          window: { from: 1, to: 2 },
          previousWindow: { from: 0, to: 1 },
          point: { value: 12, previousValue: 10, delta: 2, deltaPct: 0.2 },
          rows: null,
          computedAt: 3,
        },
      },
    );
    renderWithProviders(<CollectionKpisPanel collection="orders" />);
    await waitFor(() => expect(screen.getByText("Mine")).toBeTruthy());
    expect(screen.queryByText("Theirs")).toBeNull();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("20%")).toBeTruthy();
  });

  test("a KPI with no date column says so instead of showing a delta", async () => {
    mockRoutes([kpi({ slug: "total", name: "Total", collection: "orders", unit: "units" })], {
      total: {
        slug: "total",
        name: "Total",
        description: null,
        collection: "orders",
        format: "number",
        unit: "units",
        decimals: null,
        direction: "up",
        groupBy: null,
        // No dateField → no period at all.
        window: null,
        previousWindow: null,
        point: { value: 7, previousValue: null, delta: null, deltaPct: null },
        rows: null,
        computedAt: 3,
      },
    });
    renderWithProviders(<CollectionKpisPanel collection="orders" />);
    await waitFor(() => expect(screen.getByText("7 units")).toBeTruthy());
    expect(screen.getByText("Running total")).toBeTruthy();
  });

  test("a zero baseline shows the absolute change, not a fabricated percentage", async () => {
    mockRoutes([kpi({ slug: "new", name: "New", collection: "orders", dateField: "created_at" })], {
      new: {
        slug: "new",
        name: "New",
        description: null,
        collection: "orders",
        format: "number",
        unit: null,
        decimals: null,
        direction: "up",
        groupBy: null,
        window: { from: 1, to: 2 },
        previousWindow: { from: 0, to: 1 },
        // previousValue 0 → deltaPct null: there is no proportion to report.
        point: { value: 5, previousValue: 0, delta: 5, deltaPct: null },
        rows: null,
        computedAt: 3,
      },
    });
    renderWithProviders(<CollectionKpisPanel collection="orders" />);
    await waitFor(() => expect(screen.getByText("5")).toBeTruthy());
    expect(screen.getByText("+5")).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
  });
});
