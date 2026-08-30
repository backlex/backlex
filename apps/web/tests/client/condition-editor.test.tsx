import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { ConditionEditor } from "../../src/client/admin/pages/access/condition-editor";
import { renderWithProviders } from "./render";

/**
 * The rule editor is where an operator repairs a permission, so what it shows
 * has to be what is stored. It was not: an effect reset the builder to a
 * hard-coded template on every (role, action, collection) change and nothing
 * ever read the row back, so "Edit rule" on a live rule displayed a fabricated
 * one — and Save then replaced the real rule with the fabrication. Two further
 * tabs (Validation, Presets) collected input no request carried, under copy
 * that described server behaviour ("Failures return 422 invalid_payload") the
 * product does not implement.
 *
 * These specs pin the repair from the side a screenshot cannot show:
 *   - the stored condition is asserted by a value that appears ONLY in it
 *     ("emea-7734"), so a template can never pass the test by coincidence;
 *   - the template still appears when — and only when — there is no row;
 *   - Save carries the condition that is on screen, not a recompiled preset;
 *   - the two tabs that persisted nothing are gone, asserted against the two
 *     that remain so the absence cannot pass vacuously.
 *
 * The geometry half of the mobile rule (no horizontal overflow at 390px) is
 * asserted structurally rather than by rect: happy-dom loads no CSS and reports
 * every `getBoundingClientRect()` as zero, so a rect assertion here would pass
 * whatever the layout did — see the same note in `consent.test.tsx`. What IS
 * assertable is the mechanism that prevents the overflow: below the mobile
 * breakpoint the tab strip is replaced by an accordion, both sections stay
 * reachable, and the wide blocks sit in their own scroll containers.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const FIELDS = ["id", "title", "status", "owner_id", "region", "salary"];

/** A condition no template could produce — the literal `emea-7734` exists in
 *  this object and nowhere else in the editor's source. */
const STORED_CONDITION = {
  $or: [
    { region: { _eq: "emea-7734" } },
    { owner_id: { _eq: "$user.id" } },
  ],
};

const ROLES = [{ id: "r1", name: "editor" }];

/** The permission role this editor is opened for. Held in a constant because
 *  the prop is spelled `role`, and a literal there reads to the a11y linter as
 *  an ARIA role — which it is not. */
const ROLE = "editor";

interface Row {
  id: string;
  collection: string;
  action: string;
  fields: string[] | null;
  condition: unknown;
}

interface Harness {
  /** Every request the editor made, in order. */
  sent: { method: string; url: string; body: Record<string, unknown> | null }[];
}

const mockRoutes = (rows: Row[]): Harness => {
  const sent: Harness["sent"] = [];
  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    sent.push({
      method,
      url,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    if (url.endsWith("/api/roles")) return json({ data: ROLES });
    if (url.includes("/permissions") && method === "GET") return json({ data: rows });
    if (method === "DELETE") return json({ ok: true });
    if (method === "POST") return json({ data: { id: "p-new" } }, 201);
    return json({ data: [] });
  }) as unknown as typeof fetch;
  return { sent };
};

const row = (over: Partial<Row> = {}): Row => ({
  id: "p1",
  collection: "posts",
  action: "update",
  fields: null,
  condition: STORED_CONDITION,
  ...over,
});

const renderEditor = (opts: { roles?: { id?: string; name: string }[] } = {}) =>
  renderWithProviders(
    <ConditionEditor
      role={ROLE}
      action="update"
      collection="posts"
      roles={opts.roles ?? ROLES}
      pushToast={() => {}}
      availableFields={FIELDS}
    />,
  );

/** Every text input's CURRENT value — the rule builder renders each leaf's
 *  right-hand side as one. Read off the property, not the attribute: React
 *  never writes the latter. */
const inputValues = () =>
  Array.from(document.querySelectorAll("input")).map((el) => (el as HTMLInputElement).value);

const click = async (el: Element) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};

/** The row in the field table for `name`, so a checkbox is picked by the field
 *  it belongs to rather than by position. */
const fieldRow = (name: string): Element => {
  const cell = Array.from(document.querySelectorAll("span.font-mono")).find(
    (el) => el.textContent === name,
  );
  if (!cell?.parentElement) throw new Error(`no field row for "${name}"`);
  return cell.parentElement;
};

const setViewport = (width: number) => {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
};

afterEach(() => {
  cleanup();
  setViewport(1280);
});

describe("ConditionEditor", () => {
  test("opens on the rule that is stored, not on a template", async () => {
    mockRoutes([row()]);
    renderEditor();

    // Positive first: the value that only the STORED condition contains is on
    // screen. Without this, the absence asserted below could pass on an editor
    // that rendered nothing at all.
    await waitFor(() => expect(inputValues()).toContain("emea-7734"));
    expect(screen.getByText("Showing the rule stored for this role, action and collection.")).toBeDefined();

    // `archived` is the tell of the update template (`status _neq archived`).
    // It must not appear over a rule that does not contain it.
    expect(inputValues()).not.toContain("archived");

    // The stored rule is an $or; the template for `update` is an $and.
    const or = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "OR");
    expect(or?.getAttribute("aria-pressed")).toBe("true");
  });

  test("resolves the role by name when the caller has no id for it", async () => {
    const h = mockRoutes([row()]);
    renderEditor({ roles: [{ name: "editor" }] });

    await waitFor(() => expect(inputValues()).toContain("emea-7734"));
    expect(h.sent.some((r) => r.url.endsWith("/api/roles"))).toBe(true);
  });

  test("a combination with nothing stored still gets the suggested template", async () => {
    // A row for a DIFFERENT action, so the fetch succeeds and returns data —
    // the editor must still treat this (collection, action) as unwritten.
    mockRoutes([row({ id: "p2", action: "delete" })]);
    renderEditor();

    await waitFor(() => expect(inputValues()).toContain("archived"));
    expect(inputValues()).toContain("$user.id");
    expect(
      screen.getByText(/Nothing is stored for this combination yet/),
    ).toBeDefined();
  });

  test("a saved rule with no condition reads as matching everything", async () => {
    mockRoutes([row({ condition: null })]);
    renderEditor();

    await waitFor(() =>
      expect(screen.getByText("No conditions — this rule matches everything.")).toBeDefined(),
    );
    // Not the template, and not the stored $or either: an empty rule is empty.
    expect(inputValues()).not.toContain("archived");
    expect(inputValues()).not.toContain("emea-7734");
  });

  test("the stored field allow-list is what the checkboxes show", async () => {
    mockRoutes([row({ fields: ["id", "title"] })]);
    renderEditor();

    await waitFor(() => expect(screen.getByText("Field permissions")).toBeDefined());
    await click(screen.getByText("Field permissions"));

    expect(fieldRow("title").querySelector('[role="checkbox"]')?.getAttribute("data-state")).toBe("checked");
    expect(fieldRow("salary").querySelector('[role="checkbox"]')?.getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByText("2 of 6 readable")).toBeDefined();
  });

  test("Save carries the condition on screen and the allow-list beside it", async () => {
    const h = mockRoutes([row()]);
    renderEditor();
    await waitFor(() => expect(inputValues()).toContain("emea-7734"));

    await click(screen.getByText("Field permissions"));
    await click(fieldRow("salary").querySelector('[role="checkbox"]')!);
    await click(screen.getByText("Save"));

    await waitFor(() => expect(h.sent.some((r) => r.method === "POST")).toBe(true));
    const posted = h.sent.find((r) => r.method === "POST")!;
    // The rule that was loaded is the rule that goes back — the defect this
    // phase closes was Save writing a recompiled template instead.
    expect(posted.body?.condition).toEqual(STORED_CONDITION);
    expect(posted.body?.fields).toEqual(["id", "title", "status", "owner_id", "region"]);
    // The existing row is removed before the replacement is written, so the
    // (collection, action) pair never doubles up.
    const del = h.sent.findIndex((r) => r.method === "DELETE");
    expect(del).toBeGreaterThan(-1);
    expect(del).toBeLessThan(h.sent.indexOf(posted));
  });

  test("the tabs that persisted nothing are gone", async () => {
    mockRoutes([row()]);
    renderEditor();

    // The two sections that DO persist are present — so the absences below are
    // absences, not an editor that failed to render.
    await waitFor(() => expect(screen.getByText("Item permissions")).toBeDefined());
    expect(screen.getByText("Field permissions")).toBeDefined();

    expect(screen.queryByText("Validation")).toBeNull();
    expect(screen.queryByText("Presets")).toBeNull();
    expect(screen.queryByText(/422 invalid_payload/)).toBeNull();
    expect(screen.queryByText(/stamped server-side/)).toBeNull();

    // The write half of the field table went with them: only the read set is
    // ever sent, as the `fields` allow-list.
    await click(screen.getByText("Field permissions"));
    expect(screen.getByText("Readable")).toBeDefined();
    expect(screen.queryByText("Write")).toBeNull();
  });

  test("at 390px the tab strip becomes an accordion and both sections stay reachable", async () => {
    setViewport(390);
    mockRoutes([row()]);
    renderEditor();

    await waitFor(() => expect(screen.getByText("Item permissions")).toBeDefined());

    // The strip that does not fit is not merely restyled — it is not rendered.
    expect(document.querySelector('[data-slot="section-tabs"]')).toBeNull();
    const triggers = Array.from(document.querySelectorAll('[data-slot="collapsible-trigger"]'));
    expect(triggers.length).toBe(2);

    // The first section is open, the second is reachable by its own header.
    expect(inputValues()).toContain("emea-7734");
    expect(screen.queryByText("Readable")).toBeNull();
    const fieldsTrigger = triggers.find((el) => el.textContent?.includes("Field permissions"))!;
    expect(fieldsTrigger.getAttribute("aria-expanded")).toBe("false");
    await click(fieldsTrigger);
    expect(fieldsTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Readable")).toBeDefined();
  });

  test("the desktop layout keeps the tab strip", async () => {
    setViewport(1280);
    mockRoutes([row()]);
    renderEditor();

    await waitFor(() => expect(screen.getByText("Item permissions")).toBeDefined());
    expect(document.querySelector('[data-slot="section-tabs"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-slot="collapsible-trigger"]').length).toBe(0);
  });

  test("the compiled clause scrolls in its own container", async () => {
    mockRoutes([row()]);
    renderEditor();
    await waitFor(() => expect(inputValues()).toContain("emea-7734"));

    await click(screen.getByText("View compiled WHERE"));
    const pre = document.querySelector("pre")!;
    expect(pre.textContent).toContain("emea-7734");
    // A long clause has to scroll inside this block rather than widen the
    // dialog and take the page sideways with it.
    expect(pre.closest('[data-slot="scroll-area"]')).not.toBeNull();
  });

  test("a rule that cannot be read is not replaced by a guess", async () => {
    global.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/api/roles")) return json({ data: ROLES });
      return json({ error: { message: "permissions unavailable" } }, 500);
    }) as unknown as typeof fetch;
    renderEditor();

    await waitFor(() => expect(screen.getByText("Could not read the stored rule")).toBeDefined());
    // No builder, so no Save that could overwrite the live rule with a template.
    expect(screen.queryByText("Save")).toBeNull();
    expect(inputValues()).not.toContain("archived");
  });
});
