import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { SyncHooksCard } from "../../src/client/admin/pages/automation/sync-hooks-card";
import { renderWithProviders } from "./render";

// A sync hook blocks writes, so the UI has to make its two consequential
// settings impossible to miss: `onError` (which decides what happens when the
// hook is down) and `canMutate` (which decides whether it can rewrite rows).
// These pin that the form does not quietly choose either one for the operator.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const HOOK = {
  id: "h1",
  name: "tax",
  url: "https://app.example/tax",
  events: ["orders.beforeCreate"],
  headers: null,
  timeoutMs: 2000,
  onError: "deny" as const,
  canMutate: false,
  priority: 0,
  enabled: true,
  hasSecret: true,
  consecutiveFailures: 0,
  lastFailureAt: null,
  disabledReason: null,
  createdAt: 1,
  updatedAt: 1,
};

let posted: { url: string; body: any }[] = [];

const mockRoutes = (hooks: unknown[], testResult?: unknown) => {
  posted = [];
  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.body) posted.push({ url, body: JSON.parse(String(init.body)) });
    if (url.includes("/sync-hooks") && url.endsWith("/test")) {
      return json(testResult ?? { ok: true, ms: 12, verdict: { allow: true } });
    }
    if (url.includes("/api/admin/sync-hooks")) {
      if (init?.method === "POST") return json({ data: { ...HOOK, id: "new" } });
      if (init?.method === "PATCH") return json({ data: { ...HOOK, enabled: false } });
      return json({ data: hooks });
    }
    return json({ data: [] });
  }) as unknown as typeof fetch;
};

const click = async (el: Element) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};

afterEach(() => cleanup());

describe("SyncHooksCard", () => {
  test("an empty instance explains what a sync hook is for", async () => {
    mockRoutes([]);
    renderWithProviders(<SyncHooksCard pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("No sync hooks")).toBeDefined());
  });

  test("the failure policy is on the row, not hidden in the editor", async () => {
    mockRoutes([HOOK]);
    renderWithProviders(<SyncHooksCard pushToast={() => {}} />);
    // `deny` means this hook can block live writes — the operator must see it
    // without opening anything.
    await waitFor(() => expect(screen.getByText("blocks on failure")).toBeDefined());
  });

  test("an allow-on-failure hook is labelled differently", async () => {
    mockRoutes([{ ...HOOK, onError: "allow" }]);
    renderWithProviders(<SyncHooksCard pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("allows on failure")).toBeDefined());
    expect(screen.queryByText("blocks on failure")).toBeNull();
  });

  test("a mutating hook is flagged", async () => {
    mockRoutes([{ ...HOOK, canMutate: true }]);
    renderWithProviders(<SyncHooksCard pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("can patch")).toBeDefined());
  });

  test("a breaker-paused hook shows the badge and the reason", async () => {
    mockRoutes([
      { ...HOOK, enabled: false, disabledReason: "Auto-disabled after 15 consecutive failures" },
    ]);
    renderWithProviders(<SyncHooksCard pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Paused")).toBeDefined());
    expect(screen.getByText(/Auto-disabled after 15/)).toBeDefined();
  });

  test("a failing test says plainly that writes are being blocked", async () => {
    mockRoutes([HOOK], { ok: false, ms: 2000, error: "timeout after 2000ms" });
    renderWithProviders(<SyncHooksCard pushToast={() => {}} />);
    const btn = await waitFor(() => screen.getByText("Test"));
    await click(btn);
    await waitFor(() => expect(screen.getByText(/Unreachable/)).toBeDefined());
    // The consequence, not just the error: a `deny` hook that is down is an
    // outage, and the operator should not have to infer that.
    expect(screen.getByText(/writes to matching collections are being blocked/)).toBeDefined();
  });

  test("a rejecting test shows the reason the hook gave", async () => {
    mockRoutes([HOOK], { ok: true, ms: 8, verdict: { allow: false, reason: "VAT id required" } });
    renderWithProviders(<SyncHooksCard pushToast={() => {}} />);
    await click(await waitFor(() => screen.getByText("Test")));
    await waitFor(() => expect(screen.getByText(/VAT id required/)).toBeDefined());
  });
});

describe("the editor refuses to choose onError for you", () => {
  const openCreate = async () => {
    mockRoutes([]);
    renderWithProviders(<SyncHooksCard pushToast={() => {}} />);
    await click(await waitFor(() => screen.getByText("Add hook")));
    await waitFor(() => expect(screen.getByText("New sync hook")).toBeDefined());
  };

  const setInput = async (placeholder: string, value: string) => {
    const el = document.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  test("Create stays disabled until a failure policy is chosen", async () => {
    await openCreate();
    await setInput("tax-calculator", "guard");
    await setInput("https://app.example/hook", "https://app.example/hook");
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea, "orders.beforeCreate");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const create = screen.getByText("Create").closest("button") as HTMLButtonElement;
    // Everything else is filled; only onError is missing. Pre-selecting a
    // default here would hide the one decision the operator has to make.
    expect(create.disabled).toBe(true);
  });

  test("the failure-policy field explains both directions", async () => {
    await openCreate();
    expect(screen.getByText(/drops the guarantee this hook provides/)).toBeDefined();
  });

  test("edit mode offers to keep the stored secret rather than blanking it", async () => {
    mockRoutes([HOOK]);
    renderWithProviders(<SyncHooksCard pushToast={() => {}} />);
    await click(await waitFor(() => screen.getByText("Edit")));
    await waitFor(() => expect(screen.getByText("Edit sync hook")).toBeDefined());
    expect(screen.getByText("Leave blank to keep the current secret.")).toBeDefined();
  });

  test("saving without touching the secret omits it from the request", async () => {
    mockRoutes([HOOK]);
    renderWithProviders(<SyncHooksCard pushToast={() => {}} />);
    await click(await waitFor(() => screen.getByText("Edit")));
    await waitFor(() => expect(screen.getByText("Edit sync hook")).toBeDefined());
    await click(screen.getByText("Save"));

    await waitFor(() => expect(posted.some((p) => p.url.includes("/sync-hooks/h1"))).toBe(true));
    const patch = posted.find((p) => p.url.includes("/sync-hooks/h1"))!;
    // Sending "" would blank a credential the UI cannot even read.
    expect("secret" in patch.body).toBe(false);
  });
});
