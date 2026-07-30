import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { IntegrationSyncsCard } from "../../src/client/admin/pages/integration-syncs-card";
import { renderWithProviders } from "./render";

// A sync writes into a real business collection on a timer, so the card has to
// answer two questions without being opened: is it actually running, and if not,
// why. These pin that a paused sync shows its reason, a manual-only sync does
// not read as broken, and the create form cannot produce a sync the server will
// reject.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SOURCES = [{ id: "i1", kind: "google-sheets", label: "Google Sheets" }];
const SETTING_FIELDS = {
  "google-sheets": [
    { key: "spreadsheetId", label: "Spreadsheet ID" },
    { key: "sheetName", label: "Sheet name" },
  ],
};

const SYNC = {
  id: "s1",
  integrationId: "i1",
  collection: "leads",
  settings: { spreadsheetId: "abc", sheetName: "Sheet1" },
  mapping: { Name: "name" },
  intervalMinutes: 60,
  enabled: true,
  resuming: false,
  lastRunAt: Date.now() - 60_000,
  lastRowCount: 42,
  lastError: null,
  consecutiveFailures: 0,
  disabledReason: null,
};

let posted: { url: string; method: string; body: any }[] = [];

const mockRoutes = (syncs: unknown[], runResult?: unknown) => {
  posted = [];
  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method && init.method !== "GET") {
      posted.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null });
    }
    if (url.includes("/syncs/") && url.endsWith("/run")) {
      return json({ data: runResult ?? { written: 12, pages: 1, complete: true } });
    }
    if (url.includes("/integrations/syncs")) {
      if (init?.method === "POST") return json({ data: { ...SYNC, id: "new" } });
      if (init?.method === "PATCH") return json({ data: { ...SYNC, enabled: false } });
      if (init?.method === "DELETE") return json({ ok: true });
      return json({ data: syncs });
    }
    if (url.includes("/api/collections")) {
      return json({
        data: [
          { slug: "leads", fields: [{ name: "name" }, { name: "email" }, { name: "computed_total", computed: true }] },
        ],
      });
    }
    return json({ data: [] });
  }) as unknown as typeof fetch;
};

const click = async (el: Element) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};

const render = (props: Partial<Parameters<typeof IntegrationSyncsCard>[0]> = {}) =>
  renderWithProviders(
    <IntegrationSyncsCard
      sources={SOURCES}
      settingFields={SETTING_FIELDS}
      pushToast={() => {}}
      {...props}
    />,
  );

afterEach(() => cleanup());

describe("IntegrationSyncsCard", () => {
  test("with no source connected it says so rather than offering an empty form", async () => {
    mockRoutes([]);
    render({ sources: [] });
    await waitFor(() => expect(screen.getByText("No source connected")).toBeDefined());
    const add = screen.getByText("Add sync").closest("button") as HTMLButtonElement;
    // Opening the dialog here would present a picker with nothing in it.
    expect(add.disabled).toBe(true);
  });

  test("a healthy sync shows its cadence and last result", async () => {
    mockRoutes([SYNC]);
    render();
    await waitFor(() => expect(screen.getByText("leads")).toBeDefined());
    expect(document.body.textContent).toContain("every 60 min");
    expect(document.body.textContent).toContain("42 rows");
    expect(screen.queryByText("Paused")).toBeNull();
  });

  test("a paused sync shows the reason, not just the badge", async () => {
    mockRoutes([
      {
        ...SYNC,
        enabled: false,
        consecutiveFailures: 5,
        disabledReason: "Auto-paused after 5 consecutive failed runs (last: Google Sheets responded 404)",
      },
    ]);
    render();
    await waitFor(() => expect(screen.getByText("Paused")).toBeDefined());
    // "Paused" alone leaves the operator guessing whether they did it.
    expect(screen.getByText(/Auto-paused after 5/)).toBeDefined();
  });

  test("a manual-only sync is labelled, not left looking broken", async () => {
    mockRoutes([{ ...SYNC, intervalMinutes: 0 }]);
    render();
    await waitFor(() => expect(screen.getByText("Manual only")).toBeDefined());
    expect(document.body.textContent).toContain("runs only when you ask");
  });

  test("a part-way run says more pages are pending", async () => {
    mockRoutes([{ ...SYNC, resuming: true }]);
    render();
    // Otherwise a row count lower than the sheet's looks like data loss.
    await waitFor(() => expect(screen.getByText("More pages pending")).toBeDefined());
  });

  test("a never-run sync says so instead of showing a zero", async () => {
    mockRoutes([{ ...SYNC, lastRunAt: null, lastRowCount: 0 }]);
    render();
    await waitFor(() => expect(document.body.textContent).toContain("never run"));
  });

  test("running now reports what landed", async () => {
    const toasts: string[] = [];
    mockRoutes([SYNC], { written: 7, pages: 1, complete: true });
    render({ pushToast: (m: string) => toasts.push(m) });
    await click(await waitFor(() => screen.getByText("Run now")));
    await waitFor(() => expect(toasts.join(" ")).toContain("7"));
  });

  test("an incomplete run says the rest resumes, not that it failed", async () => {
    const toasts: string[] = [];
    mockRoutes([SYNC], { written: 2000, pages: 20, complete: false });
    render({ pushToast: (m: string) => toasts.push(m) });
    await click(await waitFor(() => screen.getByText("Run now")));
    await waitFor(() => expect(toasts.join(" ")).toMatch(/resume/));
  });

  test("pausing updates the row immediately, before the request settles", async () => {
    mockRoutes([SYNC]);
    render();
    await click(await waitFor(() => screen.getByText("Pause")));
    // Optimistic: the badge is there without waiting on a refetch.
    expect(screen.getByText("Paused")).toBeDefined();
  });
});

describe("the create dialog cannot build a sync the server would reject", () => {
  const openDialog = async () => {
    mockRoutes([]);
    render();
    await click(await waitFor(() => screen.getByText("Add sync")));
    await waitFor(() => expect(screen.getByText("New data sync")).toBeDefined());
  };

  const createButton = () => screen.getByText("Create sync").closest("button") as HTMLButtonElement;

  test("Create stays disabled until a collection and a mapping exist", async () => {
    await openDialog();
    // A sync with no mapping writes rows that are nothing but ids, and the
    // server refuses it — so the form must not let it be submitted at all.
    expect(createButton().disabled).toBe(true);
  });

  test("the provider's own settings are asked for by name", async () => {
    await openDialog();
    expect(screen.getByText("Spreadsheet ID")).toBeDefined();
    expect(screen.getByText("Sheet name")).toBeDefined();
  });

  test("the mapping target is a picker, not free text", async () => {
    await openDialog();
    // A typed field name would be refused by the server only after the whole
    // form was filled in, so the target is chosen from the collection itself.
    const externalInputs = document.querySelectorAll('input[placeholder="External column"]');
    expect(externalInputs.length).toBe(1);
    expect(document.querySelectorAll('[role="combobox"]').length).toBeGreaterThanOrEqual(3);
  });

  test("adding and removing mapping rows keeps one row minimum", async () => {
    await openDialog();
    await click(screen.getByText("Add column"));
    expect(document.querySelectorAll('input[placeholder="External column"]').length).toBe(2);

    const removes = [...document.querySelectorAll('button[aria-label="Remove column"]')];
    expect(removes).toHaveLength(2);
    await click(removes[0]!);
    expect(document.querySelectorAll('input[placeholder="External column"]').length).toBe(1);
    // The last row cannot go — a mapping is mandatory.
    const last = document.querySelector('button[aria-label="Remove column"]') as HTMLButtonElement;
    expect(last.disabled).toBe(true);
  });

  test("the field picker says what to do first instead of sitting empty", async () => {
    await openDialog();
    // No collection is chosen yet, so the target list would be empty — the
    // placeholder has to name the missing step rather than read "Select…".
    expect(screen.getByText("Pick a collection first")).toBeDefined();
  });

  test("the schedule is a picker, never a raw number field", async () => {
    await openDialog();
    // "60" typed into a box invites "0", "5" and "90000", all of which the
    // server refuses; the useful cadences are a short list.
    expect(document.querySelector('input[type="number"]')).toBeNull();
  });
});
