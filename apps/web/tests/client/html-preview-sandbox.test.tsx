/**
 * Pre-prod audit 2026-09, Faz 7 — a stored value never becomes admin markup.
 *
 * The finding: a `longtext` field with `interface: "richtext"` was handed
 * straight to `dangerouslySetInnerHTML` in the item form's Preview toggle, and
 * there is no HTML sanitizer anywhere in this repo. That field is the default
 * in NINE bundled schema templates, and a public form over such a collection is
 * writable by an anonymous submitter — so the markup reaching that toggle is
 * not necessarily an admin's. Clicking Preview is an ordinary review action
 * performed with a full admin session.
 *
 * Rendering it in a `sandbox=""` iframe is the fix (`admin/html-preview.tsx`),
 * and this spec pins the property that matters: **the payload is not in the
 * admin document**. Asserting only "an iframe exists" would pass against a
 * build that rendered both.
 *
 * Note the second injection in the same call site, which the finding did not
 * name: the `markdown` branch escapes `<` and `>` before formatting, but built
 * `<a href="…">` from the captured URL WITHOUT escaping quotes — so a link
 * whose target carried a quote closed the attribute and added an event handler
 * to an element this code was generating. Escaping angle brackets stops new
 * elements, not new attributes on an element you are building yourself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { SchemaField } from "../../src/client/admin/config";
import { ItemFields, useItemForm } from "../../src/client/admin/collections/item-form";
import { renderWithProviders } from "./render";

const FIELDS = [
  { name: "body", type: "longtext", interface: "richtext" },
  { name: "notes", type: "longtext", interface: "markdown" },
] as unknown as SchemaField[];

/** What an anonymous public-form submitter can store in that column. Kept
 *  inert (no network, no real handler target) — it only has to be markup the
 *  browser would ACT on if it were injected. */
const PAYLOAD = '<img src="x" onerror="window.__pwned=1">';

function Editor({ initial }: { initial: Record<string, unknown> }) {
  const form = useItemForm({
    schema: { slug: "posts", fields: FIELDS } as any,
    initial: initial as any,
    active: true,
  });
  return <ItemFields form={form} />;
}

const openPreview = (index: number) => {
  const buttons = screen.getAllByText("Preview");
  fireEvent.click(buttons[index]!);
};

describe("richtext preview — the stored value never enters the admin document", () => {
  afterEach(() => cleanup());

  test("the payload is not injected into the page", () => {
    const { container } = renderWithProviders(<Editor initial={{ body: PAYLOAD, notes: "" }} />);
    openPreview(0);

    // The assertion the old build failed: React created a real <img> with a
    // real onerror in the admin's own document.
    //
    // Checked as live NODES, not as a substring of `innerHTML` — the frame's
    // own `srcdoc` attribute serialises the payload back into that string, so a
    // substring test passes for the wrong reason on a build that is fine and
    // could pass for the wrong reason on one that is not.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelectorAll("[onerror]").length).toBe(0);
  });

  test("it is rendered in a frame that grants nothing", () => {
    const { container } = renderWithProviders(<Editor initial={{ body: PAYLOAD, notes: "" }} />);
    openPreview(0);

    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    // `sandbox=""` is the whole guarantee: no scripts, no forms, no plugins,
    // no top-level navigation, and an opaque origin. `allow-scripts` together
    // with `allow-same-origin` would be equivalent to no sandbox at all.
    expect(frame!.getAttribute("sandbox")).toBe("");
    expect(frame!.getAttribute("src")).toBeNull();
    // The content IS carried — this is a preview, not a blank box.
    expect(frame!.getAttribute("srcdoc")).toContain("onerror");
  });

  test("the frame is named, so it is not announced as just “frame”", () => {
    const { container } = renderWithProviders(<Editor initial={{ body: "<p>hi</p>", notes: "" }} />);
    openPreview(0);
    expect(container.querySelector("iframe")!.getAttribute("title")).toBeTruthy();
  });

  test("toggling back returns the editable textarea", () => {
    // The other direction: the preview must still be a TOGGLE, not a one-way
    // door that strands the author.
    const { container } = renderWithProviders(<Editor initial={{ body: "<p>hi</p>", notes: "" }} />);
    openPreview(0);
    expect(container.querySelector("iframe")).not.toBeNull();
    fireEvent.click(screen.getAllByText("Edit")[0]!);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
  });
});

describe("markdown preview — a link target cannot become an attribute", () => {
  afterEach(() => cleanup());

  test("a quote in the URL is escaped instead of closing href", () => {
    // Paren-free on purpose: the link rule captures `[^)]+`, so a payload
    // containing `)` never reaches it and would prove nothing.
    const md = '[click](https://example.com" onfocus=alert autofocus="}';
    const { container } = renderWithProviders(<Editor initial={{ body: "", notes: md }} />);
    openPreview(1);

    const srcdoc = container.querySelector("iframe")!.getAttribute("srcdoc")!;
    // The quote survives as an entity inside one attribute value, so no new
    // attribute is created.
    expect(srcdoc).toContain("&quot;");
    expect(srcdoc).not.toContain('" onfocus=');
  });

  test("ordinary markdown still formats", () => {
    const { container } = renderWithProviders(
      <Editor initial={{ body: "", notes: "# Title\n\n**bold** and [a link](https://example.com)" }} />,
    );
    openPreview(1);
    const srcdoc = container.querySelector("iframe")!.getAttribute("srcdoc")!;
    expect(srcdoc).toContain("<h1>Title</h1>");
    expect(srcdoc).toContain("<strong>bold</strong>");
    expect(srcdoc).toContain('href="https://example.com"');
  });

  test("raw markup in markdown is still escaped, as it always was", () => {
    const { container } = renderWithProviders(
      <Editor initial={{ body: "", notes: PAYLOAD }} />,
    );
    openPreview(1);
    const srcdoc = container.querySelector("iframe")!.getAttribute("srcdoc")!;
    expect(srcdoc).toContain("&lt;img");
    expect(container.querySelector("img")).toBeNull();
  });
});
