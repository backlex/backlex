import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { DARK } from "@backlex/core/appearance";
import { DocumentsPage } from "../../src/client/admin/pages/settings/documents";
import { renderWithProviders } from "./render";

// Render coverage for Settings → Document templates, which now does everything
// the email-template editor does. The same questions a server spec cannot see:
// that list mutations paint BEFORE the request answers (every write is held
// open), that unsaved edits are guarded, that a theme reaches the preview, and
// that Render PDF sends the draft as it stands rather than the saved row.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const row = (over: Record<string, unknown>) => ({
  id: "row",
  key: "row",
  name: "Row",
  description: null,
  bodyHtml: "<html><body>Hi</body></html>",
  headerHtml: null,
  footerHtml: null,
  pageOptions: { format: "A4" },
  filename: null,
  variables: [],
  appearance: null,
  inherited: false,
  overridesDefault: false,
  ...over,
});

const ROWS = [
  row({ id: "shared-terms", key: "terms", name: "Terms", inherited: true, bodyHtml: "<html><body>Terms {{ data.party }}</body></html>" }),
  row({ id: "own-invoice", key: "invoice", name: "Invoice", bodyHtml: "<html><body>Invoice {{ data.no }}</body></html>", variables: ["data.no"], pageOptions: { format: "A4", margin: "12mm" } }),
  row({ id: "own-quote", key: "quote", name: "Quote", overridesDefault: true, appearance: { theme: "dark" } }),
];

interface Sent {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const mockRoutes = () => {
  const sent: Sent[] = [];
  const pending: Array<(r: Response) => void> = [];
  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && url.endsWith("/api/admin/documents/templates")) return json({ data: ROWS });
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ method, url, body });
    return new Promise<Response>((res) => pending.push(res));
  }) as unknown as typeof fetch;
  return {
    sent,
    finish: async (body: unknown, status = 200) => {
      await act(async () => {
        pending.shift()?.(json(body, status));
      });
    },
  };
};

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
});

const button = (name: RegExp | string, scope: Element | Document = document) => {
  const found = [...scope.querySelectorAll("button")].find((b) =>
    typeof name === "string"
      ? b.textContent?.trim() === name || b.getAttribute("aria-label") === name
      : name.test(b.textContent ?? "") || name.test(b.getAttribute("aria-label") ?? ""),
  );
  if (!found) throw new Error(`no button ${String(name)}`);
  return found as HTMLButtonElement;
};

const listItem = (key: string) =>
  [...document.querySelectorAll("button")].find((b) => b.querySelector(".font-mono")?.textContent === key) as
    | HTMLButtonElement
    | undefined;

const body = () => document.getElementById("document-template-bodyHtml") as HTMLTextAreaElement;

/** The editor's panels are tabs now; a test that types in a field has to open
 *  the tab holding it, exactly as an admin does. */
const openTab = async (name: string): Promise<HTMLElement> => {
  const trigger = document.querySelector(`[data-testid=template-tab-${name}]`) as HTMLElement | null;
  if (!trigger) throw new Error(`no ${name} tab`);
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
  return await waitFor(() => {
    const panel = document.querySelector(`[data-testid=template-tab-${name}][data-state=active]`);
    expect(panel).not.toBeNull();
    return panel as HTMLElement;
  });
};

const renderPage = async () => {
  renderWithProviders(<DocumentsPage pushToast={() => {}} />);
  await waitFor(() => expect(body()).not.toBeNull());
};

const open = async (key: string, contains: string) => {
  fireEvent.click(listItem(key)!);
  await waitFor(() => expect(body().value).toContain(contains));
};

describe("DocumentsPage — list and editor", () => {
  test("the list is grouped, searchable and marks shared and customized templates", async () => {
    mockRoutes();
    await renderPage();
    expect(document.body.textContent).toContain("Your templates");
    expect(document.body.textContent).toContain("Shared defaults");
    expect(listItem("terms")?.textContent).toContain("shared");
    expect(listItem("quote")?.textContent).toContain("customized");

    fireEvent.change(document.querySelector("input[aria-label='Search templates']")!, { target: { value: "inv" } });
    expect(listItem("invoice")).toBeDefined();
    expect(listItem("terms")).toBeUndefined();
  });

  test("choosing a theme repaints the preview with the theme's values and marks the draft unsaved", async () => {
    mockRoutes();
    await renderPage();
    await open("invoice", "Invoice");
    fireEvent.change(body(), {
      target: { value: '<html><body style="background:{{ theme.bg }}">{{ theme.mode }}</body></html>' },
    });
    await openTab("appearance");
    const panel = await waitFor(() => {
      const found = document.querySelector("[data-testid=template-appearance]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    fireEvent.click(button("Dark", panel));
    await waitFor(() => {
      const frame = document.querySelector("[data-testid=document-preview-frame] iframe");
      expect(frame?.getAttribute("srcdoc")).toContain(`background:${DARK.bg}`);
    });
    expect(listItem("invoice")?.querySelector("[title='Unsaved changes']")).not.toBeNull();
  });

  test("a theme variable is never reported as missing sample data", async () => {
    mockRoutes();
    await renderPage();
    await open("invoice", "Invoice");
    fireEvent.change(body(), { target: { value: "<html>{{ theme.accent }} {{ data.missing }}</html>" } });
    // The tab says there is something to look at before it is opened.
    expect(document.querySelector("[data-testid=template-tab-warn-variables]")).not.toBeNull();
    await openTab("variables");
    const status = await waitFor(() => document.querySelector("[role=status]") as HTMLElement);
    expect(status.textContent).toContain("data.missing");
    expect(status.textContent).not.toContain("theme.accent");
  });

  test("the preview is laid out at the sheet size, and turns with the orientation", async () => {
    mockRoutes();
    await renderPage();
    await open("invoice", "Invoice");
    const frame = () => document.querySelector("[data-testid=document-preview-frame]")!;
    expect(frame().getAttribute("data-device")).toBe("A4-portrait");
    expect((frame() as HTMLElement).style.width).toBe("794px");
  });

  test("switching away from unsaved edits asks before discarding them", async () => {
    mockRoutes();
    await renderPage();
    await open("invoice", "Invoice");
    fireEvent.change(body(), { target: { value: "<html>edited</html>" } });
    fireEvent.click(listItem("quote")!);
    const dialog = await waitFor(() => document.querySelector("[role=alertdialog]") as HTMLElement);
    expect(dialog.textContent).toContain("Discard unsaved changes?");
    fireEvent.click(button("Cancel", dialog));
    await waitFor(() => expect(document.querySelector("[role=alertdialog]")).toBeNull());
    expect(body().value).toBe("<html>edited</html>");
  });
});

describe("DocumentsPage — management", () => {
  test("delete asks first, removes the template before the server answers, and calls DELETE", async () => {
    const api = mockRoutes();
    await renderPage();
    await open("invoice", "Invoice");
    fireEvent.click(button("Delete template"));
    const dialog = await waitFor(() => document.querySelector("[role=alertdialog]") as HTMLElement);
    fireEvent.click(button("Delete", dialog));

    await waitFor(() => expect(api.sent.some((s) => s.method === "DELETE")).toBe(true));
    expect(api.sent.find((s) => s.method === "DELETE")!.url).toEndWith("/api/admin/documents/templates/invoice");
    expect(listItem("invoice")).toBeUndefined();
    await api.finish({ ok: true, data: null });
    expect(listItem("invoice")).toBeUndefined();
  });

  test("a failed delete puts the template back", async () => {
    const api = mockRoutes();
    await renderPage();
    await open("invoice", "Invoice");
    fireEvent.click(button("Delete template"));
    const dialog = await waitFor(() => document.querySelector("[role=alertdialog]") as HTMLElement);
    fireEvent.click(button("Delete", dialog));
    await waitFor(() => expect(listItem("invoice")).toBeUndefined());
    await api.finish({ error: { code: "INTERNAL", message: "boom" } }, 500);
    await waitFor(() => expect(listItem("invoice")).toBeDefined());
  });

  test("reset on a customized template deletes the copy and shows the shared default it restores", async () => {
    const api = mockRoutes();
    await renderPage();
    await open("quote", "Hi");
    fireEvent.click(button("Reset to default"));
    const dialog = await waitFor(() => document.querySelector("[role=alertdialog]") as HTMLElement);
    fireEvent.click(button("Reset to default", dialog));
    await waitFor(() => expect(api.sent.some((s) => s.method === "DELETE")).toBe(true));
    await api.finish({
      ok: true,
      data: row({ id: "shared-quote", key: "quote", name: "Quote", inherited: true, bodyHtml: "<html>shared quote</html>" }),
    });
    await waitFor(() => expect(listItem("quote")?.textContent).toContain("shared"));
  });

  test("duplicate saves the copy under a free key, appearance included, and lists it first", async () => {
    const api = mockRoutes();
    await renderPage();
    await open("quote", "Hi");
    fireEvent.click(button("Duplicate template"));
    await waitFor(() => expect(api.sent.some((s) => s.method === "PUT")).toBe(true));
    const put = api.sent.find((s) => s.method === "PUT")!;
    expect(put.url).toEndWith("/api/admin/documents/templates/quote_copy");
    expect(put.body).toMatchObject({ name: "Quote (copy)", appearance: { theme: "dark" } });
    expect(listItem("quote_copy")).toBeDefined();
    expect(listItem("quote")).toBeDefined();
  });

  test("each panel is behind its own tab, and the page settings are not in Content", async () => {
    mockRoutes();
    await renderPage();
    await open("invoice", "Invoice");
    // Content: the body, not the sheet.
    expect(document.getElementById("document-template-bodyHtml")).not.toBeNull();
    expect(document.getElementById("document-template-filename")).toBeNull();
    await openTab("page");
    await waitFor(() => expect(document.getElementById("document-template-filename")).not.toBeNull());
    expect(document.getElementById("document-template-bodyHtml")).toBeNull();
    await openTab("appearance");
    await waitFor(() => expect(document.querySelector("[data-testid=template-appearance]")).not.toBeNull());
    expect(document.querySelector("[data-testid=theme-variables]")).not.toBeNull();
    await openTab("content");
    await waitFor(() => expect(document.getElementById("document-template-bodyHtml")).not.toBeNull());
  });

  test("saving keeps page options this editor does not show, and drops theme paths from variables", async () => {
    const api = mockRoutes();
    await renderPage();
    await open("invoice", "Invoice");
    fireEvent.change(body(), { target: { value: "<html>{{ theme.accent }} {{ data.no }}</html>" } });
    fireEvent.click(button("Save"));
    await waitFor(() => expect(api.sent.some((s) => s.method === "PUT")).toBe(true));
    const put = api.sent.find((s) => s.method === "PUT")!;
    expect(put.body).toMatchObject({
      pageOptions: { format: "A4", landscape: false, margin: "12mm" },
      variables: ["data.no"],
    });
  });

  test("saving a shared default writes the workspace's copy and marks it customized", async () => {
    const api = mockRoutes();
    await renderPage();
    await open("terms", "Terms");
    fireEvent.change(body(), { target: { value: "<html>Our terms {{ data.party }}</html>" } });
    fireEvent.click(button("Save"));
    await waitFor(() => expect(api.sent.some((s) => s.method === "PUT")).toBe(true));
    expect(api.sent.find((s) => s.method === "PUT")!.url).toEndWith("/templates/terms");
    expect(listItem("terms")?.textContent).toContain("customized");
  });

  test("a new template's key is checked, and saving lists it before the server answers", async () => {
    const api = mockRoutes();
    await renderPage();
    fireEvent.click(button("New template"));
    const key = document.getElementById("document-template-key") as HTMLInputElement;
    await waitFor(() => expect(key.disabled).toBe(false));

    fireEvent.change(key, { target: { value: "has space" } });
    expect(document.body.textContent).toContain("1–100 characters");
    fireEvent.change(key, { target: { value: "invoice" } });
    expect(document.body.textContent).toContain("already has a template with this key");
    fireEvent.change(key, { target: { value: "terms" } });
    expect(document.body.textContent).toContain("replaces “Terms”");
    fireEvent.change(key, { target: { value: "receipt" } });
    fireEvent.change(document.getElementById("document-template-name")!, { target: { value: "Receipt" } });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(api.sent.some((s) => s.method === "PUT")).toBe(true));
    expect(api.sent.find((s) => s.method === "PUT")!.url).toEndWith("/templates/receipt");
    expect(listItem("receipt")).toBeDefined();
  });

  test("Render PDF sends the draft as it stands — body, footer, page setup, theme and sample data", async () => {
    const api = mockRoutes();
    const opened: string[] = [];
    const realOpen = window.open;
    const realCreate = URL.createObjectURL;
    window.open = ((u: string) => {
      opened.push(u);
      return null;
    }) as typeof window.open;
    URL.createObjectURL = (() => "blob:pdf") as typeof URL.createObjectURL;
    try {
      await renderPage();
      await open("invoice", "Invoice");
      fireEvent.change(body(), { target: { value: "<html>unsaved {{ data.no }}</html>" } });
      await openTab("page");
      const footer = await waitFor(() => {
        const f = document.getElementById("document-template-footerHtml");
        expect(f).not.toBeNull();
        return f as HTMLTextAreaElement;
      });
      fireEvent.change(footer, { target: { value: '<span class="pageNumber"></span>' } });
      await openTab("appearance");
      const panel = await waitFor(() => {
        const found = document.querySelector("[data-testid=template-appearance]");
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      fireEvent.click(button("Dark", panel));
      fireEvent.click(button("Render PDF"));
      await waitFor(() => expect(api.sent.some((s) => s.url.endsWith("/render"))).toBe(true));
      const render = api.sent.find((s) => s.url.endsWith("/render"))!;
      expect(render.body).toMatchObject({
        html: "<html>unsaved {{ data.no }}</html>",
        footerHtml: '<span class="pageNumber"></span>',
        headerHtml: null,
        pageOptions: { format: "A4", landscape: false },
        appearance: { theme: "dark" },
        vars: { data: { no: "" } },
      });
      expect(render.body.templateKey).toBeUndefined();
      await act(async () => {
        // The render answers bytes, not JSON.
      });
    } finally {
      window.open = realOpen;
      URL.createObjectURL = realCreate;
    }
  });
});
