import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { AskAiPage } from "../../src/client/admin/pages/ask-ai";
import { renderWithProviders } from "./render";

// Page-level coverage for the Ask tab's two schema-grounding fixes:
//   1. Example chips derive from the workspace's real collections — the old
//      hard-coded ecommerce prompts ("top customers…") guaranteed a NOT_FOUND
//      in any workspace without an `orders` collection.
//   2. A plan the server annotates with `validationError` renders the amber
//      warning band and is NEVER auto-run, even with auto-run enabled.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const DEALS = {
  slug: "deals",
  status: "active",
  fields: [
    { name: "owner", type: "relation", to: "users" },
    { name: "amount", type: "number" },
    { name: "status", type: "text" },
  ],
};

const mockFetchRoutes = (opts: { validationError?: string } = {}) => {
  const runCalls: string[] = [];
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/admin/ai/plan"))
      return json({
        data: {
          rationale: "Aggregate over deals.",
          tool: "collections.aggregate",
          args: { collection: "orders", agg: "sum", field: "total" },
          model: "anthropic/claude-haiku-4-5",
          ...(opts.validationError
            ? { validationError: opts.validationError }
            : {}),
        },
      });
    if (url.includes("/api/admin/ai/run")) {
      runCalls.push(url);
      return json({ ok: true, tool: "collections.aggregate", durationMs: 1 });
    }
    if (url.includes("/api/collections")) return json({ data: [DEALS] });
    if (url.includes("/api/api-keys")) return json({ data: [] });
    if (url.includes("/api/activity")) return json({ data: [] });
    return json({ error: { code: "NOT_FOUND", message: `unmocked ${url}` } }, 404);
  }) as unknown as typeof fetch;
  return runCalls;
};

describe("<AskAiPage>", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    cleanup();
    global.fetch = realFetch;
    window.localStorage.clear();
  });

  test("example chips derive from the live schema, not hard-coded ecommerce", async () => {
    mockFetchRoutes();
    renderWithProviders(<AskAiPage pushToast={() => {}} />);

    // deals has relation `owner` + numeric `amount` + status-shaped `status`.
    await waitFor(() => expect(screen.getByText("Top owner by amount")).toBeTruthy());
    expect(screen.getByText("deals by status")).toBeTruthy();
    expect(screen.getByText("Recent deals")).toBeTruthy();
    // The collection-independent schema-draft chip survives.
    expect(screen.getByText("Draft support_tickets schema")).toBeTruthy();
    // The old hard-coded prompts are gone.
    expect(screen.queryByText("Top customers by spend")).toBeNull();
    expect(screen.queryByText("Orders by status")).toBeNull();
  });

  test("plan with validationError shows the warning band and skips auto-run", async () => {
    const runCalls = mockFetchRoutes({
      validationError: 'NOT_FOUND: Collection "orders" not found',
    });
    renderWithProviders(<AskAiPage pushToast={() => {}} />);

    const textarea = await screen.findByPlaceholderText(/Ask about your data/);
    fireEvent.change(textarea, { target: { value: "top customers by spend" } });
    const runButton = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Run");
    expect(runButton).toBeTruthy();
    fireEvent.click(runButton!);

    // The amber band renders with the server's dry-run error…
    await waitFor(() =>
      expect(screen.getByText(/This plan failed validation/)).toBeTruthy(),
    );
    expect(screen.getByText(/Collection "orders" not found/)).toBeTruthy();
    // …and auto-run (on by default) did NOT fire the tool.
    expect(runCalls.length).toBe(0);
  });

  test("valid plan still auto-runs (auto-run default on)", async () => {
    const runCalls = mockFetchRoutes();
    renderWithProviders(<AskAiPage pushToast={() => {}} />);

    const textarea = await screen.findByPlaceholderText(/Ask about your data/);
    fireEvent.change(textarea, { target: { value: "sum deal amounts" } });
    const runButton = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Run");
    fireEvent.click(runButton!);

    await waitFor(() => expect(runCalls.length).toBe(1));
  });
});
