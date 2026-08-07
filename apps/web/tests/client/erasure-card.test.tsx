import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { ErasureCard } from "../../src/client/admin/pages/access/erasure-card";
import { renderWithProviders } from "./render";

// Erasure is the one place in the admin where an optimistic update would be
// wrong: the action cannot be taken back, so nothing may look done before the
// server says it is. These pin the two-step shape, that the destructive button
// is only reachable after a preview, and that the address never reaches the DOM.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SUBJECT = "alice@example.test";

const LIMITS = [
  "Backups taken before this request still contain the subject; that is a retention-policy matter.",
  "Data already delivered to third parties through integrations must be erased at those destinations.",
];

const PREVIEW = {
  id: "e1",
  subjectType: "email",
  subjectRef: "a1b2c3d4e5f6",
  mode: "anonymize",
  status: "previewed",
  plan: { counts: { collections: 3, revisions: 7, activity: 12, files: 0 } },
  report: null,
  error: null,
  reference: "DSR-42",
  previewedAt: Date.now(),
  completedAt: null,
  createdAt: Date.now(),
  limits: LIMITS,
};

let posted: { url: string; body: any }[] = [];

const mockRoutes = (list: unknown[], previewResult: unknown = PREVIEW) => {
  posted = [];
  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.body) posted.push({ url, body: JSON.parse(String(init.body)) });
    if (url.endsWith("/preview")) return json({ data: previewResult });
    if (url.endsWith("/run")) return json({ data: { ...PREVIEW, status: "completed" } });
    if (url.includes("/api/admin/erasure")) return json({ data: list });
    return json({ data: [] });
  }) as unknown as typeof fetch;
};

const click = async (el: Element) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};

const setInput = async (placeholder: string, value: string) => {
  const el = document.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

afterEach(() => cleanup());

describe("ErasureCard", () => {
  test("an empty list explains what this is for", async () => {
    mockRoutes([]);
    renderWithProviders(<ErasureCard pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("No erasure requests")).toBeDefined());
  });

  test("a completed request shows what was removed, never who", async () => {
    mockRoutes([
      {
        ...PREVIEW,
        status: "completed",
        mode: "delete",
        report: { counts: { collections: 3, revisions: 7 } },
        completedAt: Date.now(),
      },
    ]);
    renderWithProviders(<ErasureCard pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Carried out")).toBeDefined());
    expect(document.body.textContent).toContain("3 collections");
    // The short digest stands in for the person; the address is not stored and
    // must not appear.
    expect(screen.getByText("a1b2c3d4e5f6")).toBeDefined();
    expect(document.body.textContent).not.toContain(SUBJECT);
  });

  test("a failed run shows its reason rather than reading as done", async () => {
    mockRoutes([{ ...PREVIEW, status: "failed", error: "Could not scan collection \"orders\"" }]);
    renderWithProviders(<ErasureCard pushToast={() => {}} />);
    await waitFor(() => expect(screen.getByText("Failed")).toBeDefined());
    expect(screen.getByText(/Could not scan collection/)).toBeDefined();
  });
});

describe("the two-step flow", () => {
  const openDialog = async () => {
    mockRoutes([]);
    renderWithProviders(<ErasureCard pushToast={() => {}} />);
    await click(await waitFor(() => screen.getByText("New request")));
    await waitFor(() => expect(screen.getByText("New erasure request")).toBeDefined());
  };

  test("the destructive button does not exist before a preview", async () => {
    await openDialog();
    // Reaching the irreversible action without seeing the counts is the one
    // thing this interface must not allow.
    expect(screen.queryByText("Erase permanently")).toBeNull();
    expect(screen.getByText("Preview")).toBeDefined();
  });

  test("Preview stays disabled until a subject is given", async () => {
    await openDialog();
    const btn = screen.getByText("Preview").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await setInput("alice@example.com", SUBJECT);
    expect((screen.getByText("Preview").closest("button") as HTMLButtonElement).disabled).toBe(false);
  });

  test("previewing shows the counts and what the run cannot reach", async () => {
    await openDialog();
    await setInput("alice@example.com", SUBJECT);
    await click(screen.getByText("Preview"));

    await waitFor(() => expect(screen.getByText("Confirm erasure")).toBeDefined());
    expect(document.body.textContent).toContain("revisions");
    expect(screen.getByText("7")).toBeDefined();
    // Not a footnote: an operator signing off on a legal request has to know.
    expect(screen.getByText("This does not reach")).toBeDefined();
    expect(screen.getByText(/Backups taken before/)).toBeDefined();
  });

  test("a preview that found nothing cannot be carried out", async () => {
    await openDialog();
    await setInput("alice@example.com", SUBJECT);
    mockRoutes([], { ...PREVIEW, plan: { counts: { collections: 0, revisions: 0 } } });
    await click(screen.getByText("Preview"));
    await waitFor(() => expect(screen.getByText(/Nothing was found/)).toBeDefined());
    expect((screen.getByText("Erase permanently").closest("button") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("the run re-sends the subject, because the request only stored a hash", async () => {
    await openDialog();
    await setInput("alice@example.com", SUBJECT);
    await click(screen.getByText("Preview"));
    await waitFor(() => expect(screen.getByText("Erase permanently")).toBeDefined());
    await click(screen.getByText("Erase permanently"));

    await waitFor(() => expect(posted.some((p) => p.url.endsWith("/run"))).toBe(true));
    const run = posted.find((p) => p.url.endsWith("/run"))!;
    expect(run.body.subject).toEqual({ type: "email", value: SUBJECT });
    // An empty body must not be able to trigger it.
    expect(run.body.confirm).toBe(true);
  });

  test("nothing reports success until the server answers", async () => {
    const toasts: string[] = [];
    mockRoutes([]);
    renderWithProviders(<ErasureCard pushToast={(m: string) => toasts.push(m)} />);
    await click(await waitFor(() => screen.getByText("New request")));
    await setInput("alice@example.com", SUBJECT);
    await click(screen.getByText("Preview"));
    await waitFor(() => expect(screen.getByText("Erase permanently")).toBeDefined());
    // Everything else in the admin is optimistic. This is not: showing "done"
    // before it is true would be a lie about an action nobody can take back.
    expect(toasts).toEqual([]);
    await click(screen.getByText("Erase permanently"));
    await waitFor(() => expect(toasts.length).toBe(1));
  });
});
