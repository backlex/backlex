import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { EmailTemplatesPage } from "../../src/client/admin/pages/settings/email-templates";
import { renderWithProviders } from "./render";

// Render coverage for Settings → Email templates. What a server spec cannot see:
// that the preview frame actually changes width, that a variable lands at the
// caret rather than at the end of the body, that a typo is called out before it
// is saved, and that list mutations paint BEFORE the request answers — every
// write here is held open until the test lets it finish.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const row = (over: Record<string, unknown>) => ({
  id: "row",
  tenantId: "ws1",
  key: "row",
  name: "Row",
  subject: "Subject",
  fromAddress: null,
  bodyHtml: "<p>Hi</p>",
  bodyText: null,
  variables: [],
  inherited: false,
  overridesDefault: false,
  ...over,
});

const ROWS = [
  row({ id: "shared-digest", tenantId: null, key: "digest", name: "Weekly digest", inherited: true, bodyHtml: "<p>{{ digest_url }}</p>", variables: ["digest_url"] }),
  row({ id: "own-welcome", key: "welcome", name: "Welcome email", subject: "Welcome {{ user.name }}", bodyHtml: "<p>Hello {{ user.name }}</p>", variables: ["user.name"] }),
  row({ id: "own-approval", key: "approval_request", name: "Approval request", subject: "Approve: {{ title }}", bodyHtml: "<p>{{ title }}</p>" }),
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
    if (method === "GET" && url.endsWith("/api/admin/email-templates")) return json({ data: ROWS });
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ method, url, body });
    // Held open: "the list already changed" only means something while the
    // request has not answered.
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
  [...document.querySelectorAll("button[aria-current], button")].find(
    (b) => b.querySelector(".font-mono")?.textContent === key,
  ) as HTMLButtonElement | undefined;

const body = () => document.getElementById("email-template-html") as HTMLTextAreaElement;

/** The editor's panels are tabs now; a test that types in a field has to open
 *  the tab holding it, exactly as an admin does. */
const openTab = (name: string) => {
  const trigger = document.querySelector(`[data-testid=template-tab-${name}]`) as HTMLElement | null;
  if (!trigger) throw new Error(`no ${name} tab`);
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
};


const renderPage = async () => {
  renderWithProviders(<EmailTemplatesPage pushToast={() => {}} />);
  await waitFor(() => expect(body()).not.toBeNull());
};

describe("EmailTemplatesPage — preview", () => {
  test("the device toggle switches the frame between desktop and phone widths", async () => {
    mockRoutes();
    await renderPage();
    const frame = () => screen.getByTestId("email-preview-frame");
    expect(frame().getAttribute("data-device")).toBe("desktop");
    expect(frame().style.width).toBe("720px");

    fireEvent.click(button(/Mobile/));
    expect(frame().getAttribute("data-device")).toBe("mobile");
    expect(frame().style.width).toBe("375px");
    expect(button(/Mobile/).getAttribute("aria-pressed")).toBe("true");
    expect(button(/Desktop/).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(button(/Desktop/));
    expect(frame().style.width).toBe("720px");
  });

  test("the preview renders through the sample data, subject included", async () => {
    mockRoutes();
    await renderPage();
    // The first entry is the form invitation, opened on its starter and its
    // sender's sample context.
    expect(screen.getByTestId("email-preview-subject").textContent).toBe("You're invited: Customer satisfaction survey");
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("srcdoc")).toContain("Customer satisfaction survey");
    expect(iframe.getAttribute("srcdoc")).not.toContain("{{");
    // Nothing is restyled for the preview's sake.
    expect(iframe.getAttribute("srcdoc")).not.toContain("border-radius:999px");
  });
});

describe("EmailTemplatesPage — variables", () => {
  test("inserting a variable writes its placeholder at the caret, not at the end", async () => {
    mockRoutes();
    await renderPage();
    const area = body();
    fireEvent.change(area, { target: { value: "<p>Hi </p>" } });
    // Right after "<p>Hi " — inside the paragraph, well short of the end. The
    // selection travels with the event rather than through `focus()`: the tab
    // switch below unmounts the field, and a focus-dependent caret reads back
    // as "end of value" often enough to make this test lie.
    fireEvent.select(area, { target: { selectionStart: 6, selectionEnd: 6 } });

    // Clicking a variable also brings the body back on screen — the list it
    // was clicked in lives in another tab.
    openTab("variables");
    fireEvent.click(button("Insert {{ recipient.name }}"));
    await waitFor(() => expect(body().value).toBe("<p>Hi {{ recipient.name }}</p>"));
    expect(document.getElementById("email-template-html")).not.toBeNull();
  });

  test("a typo'd variable in a built-in email is called out as never sent", async () => {
    mockRoutes();
    await renderPage();
    fireEvent.change(body(), { target: { value: "<p>{{ recipient.email }} {{ usr.email }}</p>" } });
    // The warning has its own tab now, and the tab says so from the outside.
    expect(document.querySelector("[data-testid=template-tab-warn-variables]")).not.toBeNull();
    openTab("variables");
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("{{ usr.email }}");
    expect(status.textContent).toContain("is not sent with this email");
    // The real variable is not flagged.
    expect(status.textContent).not.toContain("{{ recipient.email }}");
  });

  test("a custom template's variable with no sample value is called out, and can be added", async () => {
    mockRoutes();
    await renderPage();
    fireEvent.click(listItem("welcome")!);
    await waitFor(() => expect(body().value).toBe("<p>Hello {{ user.name }}</p>"));
    fireEvent.change(body(), { target: { value: "<p>Hello {{ user.name }}, order {{ order.number }}</p>" } });

    openTab("variables");
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("{{ order.number }}");
    expect(status.textContent).toContain("has no sample value");

    fireEvent.click(button("Add them to the sample data"));
    const sample = document.getElementById("email-template-sample") as HTMLTextAreaElement;
    expect(JSON.parse(sample.value)).toMatchObject({ order: { number: "" } });
  });
});

describe("EmailTemplatesPage — management", () => {
  test("delete asks first, removes the template before the server answers, and calls DELETE", async () => {
    const api = mockRoutes();
    await renderPage();
    fireEvent.click(listItem("welcome")!);
    await waitFor(() => expect(body().value).toContain("Hello"));

    fireEvent.click(button("Delete template"));
    const dialog = await waitFor(() => {
      const d = document.querySelector("[role=alertdialog]");
      expect(d).not.toBeNull();
      return d as HTMLElement;
    });
    fireEvent.click(button("Delete", dialog));

    await waitFor(() => expect(api.sent.some((s) => s.method === "DELETE")).toBe(true));
    const del = api.sent.find((s) => s.method === "DELETE")!;
    expect(del.url).toEndWith("/api/admin/email-templates/own-welcome");
    // Still unanswered, already gone.
    expect(listItem("welcome")).toBeUndefined();

    await api.finish({ ok: true, data: null });
    expect(listItem("welcome")).toBeUndefined();
  });

  test("a failed delete puts the template back", async () => {
    const api = mockRoutes();
    await renderPage();
    fireEvent.click(listItem("welcome")!);
    await waitFor(() => expect(body().value).toContain("Hello"));
    fireEvent.click(button("Delete template"));
    const dialog = await waitFor(() => document.querySelector("[role=alertdialog]") as HTMLElement);
    fireEvent.click(button("Delete", dialog));
    await waitFor(() => expect(listItem("welcome")).toBeUndefined());

    await api.finish({ error: { code: "INTERNAL", message: "boom" } }, 500);
    await waitFor(() => expect(listItem("welcome")).toBeDefined());
  });

  test("duplicate creates the copy under a free key and lists it before the server answers", async () => {
    const api = mockRoutes();
    await renderPage();
    fireEvent.click(listItem("welcome")!);
    await waitFor(() => expect(body().value).toContain("Hello"));

    fireEvent.click(button("Duplicate template"));
    await waitFor(() => expect(api.sent.some((s) => s.method === "POST")).toBe(true));
    const post = api.sent.find((s) => s.method === "POST")!;
    expect(post.url).toEndWith("/api/admin/email-templates");
    expect(post.body).toMatchObject({
      key: "welcome_copy",
      name: "Welcome email (copy)",
      bodyHtml: "<p>Hello {{ user.name }}</p>",
      variables: ["user.name"],
    });
    expect(listItem("welcome_copy")).toBeDefined();
    expect(listItem("welcome")).toBeDefined();

    await api.finish({ data: { ...ROWS[1], ...post.body, id: "own-copy" } });
    expect(listItem("welcome_copy")).toBeDefined();
  });

  test("reset on a customized built-in email deletes the workspace's version", async () => {
    const api = mockRoutes();
    await renderPage();
    fireEvent.click(listItem("approval_request")!);
    await waitFor(() => expect(body().value).toBe("<p>{{ title }}</p>"));

    fireEvent.click(button("Reset to default"));
    const dialog = await waitFor(() => document.querySelector("[role=alertdialog]") as HTMLElement);
    fireEvent.click(button("Reset to default", dialog));

    await waitFor(() => expect(api.sent.some((s) => s.method === "DELETE")).toBe(true));
    expect(api.sent.find((s) => s.method === "DELETE")!.url).toEndWith("/own-approval");
    // Optimistically back on the built-in starter, and no longer marked.
    await waitFor(() => expect(body().value).toContain("You have been asked to approve"));
    expect(listItem("approval_request")?.textContent).not.toContain("customized");
  });

  test("saving a shared default patches it and marks the entry customized", async () => {
    const api = mockRoutes();
    await renderPage();
    fireEvent.click(listItem("digest")!);
    await waitFor(() => expect(body().value).toBe("<p>{{ digest_url }}</p>"));
    fireEvent.change(body(), { target: { value: "<p>Read it: {{ digest_url }}</p>" } });

    fireEvent.click(button("Save"));
    await waitFor(() => expect(api.sent.some((s) => s.method === "PATCH")).toBe(true));
    const patch = api.sent.find((s) => s.method === "PATCH")!;
    expect(patch.url).toEndWith("/shared-digest");
    expect(patch.body).toMatchObject({ bodyHtml: "<p>Read it: {{ digest_url }}</p>", variables: ["digest_url"] });
    expect(listItem("digest")?.textContent).toContain("customized");
  });

  test("a new template's key is checked the server's way, and saving lists it before the server answers", async () => {
    const api = mockRoutes();
    await renderPage();
    fireEvent.click(button("New template"));
    const key = document.getElementById("email-template-key") as HTMLInputElement;
    await waitFor(() => expect(key.disabled).toBe(false));

    fireEvent.change(key, { target: { value: "has space" } });
    expect(document.body.textContent).toContain("2–40 characters");
    // The workspace already owns `welcome` — the unique index would 409.
    fireEvent.change(key, { target: { value: "welcome" } });
    expect(document.body.textContent).toContain("already has a template with this key");
    // A dotted key is what booking sends under; the old page refused the dot.
    fireEvent.change(key, { target: { value: "order.shipped" } });
    expect(document.body.textContent).not.toContain("2–40 characters");

    fireEvent.change(document.getElementById("email-template-name")!, { target: { value: "Order shipped" } });
    fireEvent.change(document.getElementById("email-template-subject")!, { target: { value: "Shipped: {{ data.id }}" } });
    fireEvent.change(body(), { target: { value: "<p>On its way.</p>" } });
    fireEvent.click(button("Save"));

    await waitFor(() => expect(api.sent.some((s) => s.method === "POST")).toBe(true));
    expect(api.sent.find((s) => s.method === "POST")!.body).toMatchObject({
      key: "order.shipped",
      name: "Order shipped",
      bodyText: null,
      variables: ["data.id"],
    });
    expect(listItem("order.shipped")).toBeDefined();
  });

  test("switching away from unsaved edits asks before discarding them", async () => {
    mockRoutes();
    await renderPage();
    fireEvent.change(body(), { target: { value: "<p>edited</p>" } });
    fireEvent.click(listItem("welcome")!);
    const dialog = await waitFor(() => document.querySelector("[role=alertdialog]") as HTMLElement);
    expect(dialog.textContent).toContain("Discard unsaved changes?");
    fireEvent.click(button("Cancel", dialog));
    await waitFor(() => expect(document.querySelector("[role=alertdialog]")).toBeNull());
    expect(body().value).toBe("<p>edited</p>");
  });

  test("a chosen theme reaches the preview and travels with the test send", async () => {
    const api = mockRoutes();
    await renderPage();
    fireEvent.change(body(), { target: { value: '<p style="color:{{ theme.accent }}">{{ theme.mode }}</p>' } });
    openTab("appearance");
    const panel = await waitFor(() => {
      const found = document.querySelector("[data-testid=template-appearance]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    fireEvent.click(button("Dark", panel));
    await waitFor(() => {
      const frame = document.querySelector("[data-testid=email-preview-frame] iframe");
      expect(frame?.getAttribute("srcdoc")).toContain(">dark</p>");
    });
    // A theme variable is never a variable the sender owes — no warning dot.
    expect(document.querySelector("[data-testid=template-tab-warn-variables]")).toBeNull();
    fireEvent.click(button("Send test"));
    await waitFor(() => expect(api.sent.some((s) => s.url.endsWith("/send-test"))).toBe(true));
    expect(api.sent.find((s) => s.url.endsWith("/send-test"))!.body).toMatchObject({ appearance: { theme: "dark" } });
  });

  test("send test mails the draft as it stands, with the sample data", async () => {
    const api = mockRoutes();
    await renderPage();
    fireEvent.click(button("Send test"));
    await waitFor(() => expect(api.sent.some((s) => s.url.endsWith("/send-test"))).toBe(true));
    const send = api.sent.find((s) => s.url.endsWith("/send-test"))!;
    expect(send.url).toEndWith("/api/admin/email-templates/send-test");
    expect(send.body).toMatchObject({
      subject: "You're invited: {{ form }}",
      vars: { form: "Customer satisfaction survey" },
    });
  });
});
