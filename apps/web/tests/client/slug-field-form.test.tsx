/**
 * The slug field in the item form.
 *
 * Both behaviours pinned here were found on the REAL SCREEN and by nothing
 * else — the server tests were green throughout, because every other client
 * (SDK, GraphQL, CSV import) sends no slug at all and so could not produce
 * either one. They are the [[testing-gaps-admin-ui]] class, and this file is
 * the gap being closed.
 *
 *   1. **An auto-derived slug the operator never touched must not be SENT.**
 *      The server keeps a stated slug verbatim and 409s a collision; it
 *      suffixes a derived one. Submitting the preview turns it into a
 *      statement, so the second category called "Kadın Giyim" was refused with
 *      a 409 about a value nobody typed — the exact case the suffix exists for.
 *   2. **A row that already HAS a slug never re-derives it.** Retitling an
 *      existing post rewrote the box in front of the operator while the server
 *      correctly kept the published URL, so the box promised a move that was
 *      never going to happen.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { SchemaField } from "../../src/client/admin/api";
import { ItemFields, useItemForm } from "../../src/client/admin/collections/item-form";
import { renderWithProviders } from "./render";

const FIELDS = [
  { name: "name", type: "text" },
  {
    name: "slug",
    type: "text",
    unique: true,
    interface: "slug",
    slug: { from: ["name"] },
  },
] as unknown as SchemaField[];

/** Renders the editor and exposes the payload the form would submit. */
function Editor({
  initial,
  onPayload,
}: {
  initial: Record<string, unknown> | null;
  onPayload: (p: Record<string, unknown>) => void;
}) {
  const form = useItemForm({
    schema: { slug: "cats", fields: FIELDS } as any,
    initial: initial as any,
    active: true,
  });
  return (
    <>
      <ItemFields form={form} />
      <button type="button" onClick={() => onPayload(form.buildPayload() as any)}>
        submit
      </button>
    </>
  );
}

const boxes = () => screen.getAllByRole("textbox") as HTMLInputElement[];
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe("slug field — the item form", () => {
  // Without this the renders of one test are still in the document for the
  // next, and `getAllByRole` returns the PREVIOUS form's boxes — which passes
  // in isolation and fails the moment another client spec runs first.
  afterEach(() => cleanup());

  test("derives the preview from the source column, folding non-ASCII", () => {
    renderWithProviders(<Editor initial={null} onPayload={() => {}} />);
    const [name, slug] = boxes();
    type(name!, "Kadın Giyim");
    // The shared fold, not the old ASCII filter that made this "kad-n-giyim".
    expect((boxes()[1] as HTMLInputElement).value).toBe("kadin-giyim");
    expect(slug).toBeDefined();
  });

  test("the untouched preview is NOT submitted, so the server may suffix it", () => {
    let payload: Record<string, unknown> = {};
    renderWithProviders(<Editor initial={null} onPayload={(p) => { payload = p; }} />);
    type(boxes()[0]!, "Kadın Giyim");
    expect((boxes()[1] as HTMLInputElement).value).toBe("kadin-giyim");

    fireEvent.click(screen.getByText("submit"));
    expect(payload.name).toBe("Kadın Giyim");
    // The assertion that matters: the key is ABSENT, not empty. Sending it —
    // even sending the right string — makes the server treat it as a decision
    // and refuse the duplicate instead of numbering it.
    expect("slug" in payload).toBe(false);
  });

  test("a slug the operator DID type is submitted verbatim", () => {
    let payload: Record<string, unknown> = {};
    renderWithProviders(<Editor initial={null} onPayload={(p) => { payload = p; }} />);
    type(boxes()[0]!, "Erkek Giyim");
    type(boxes()[1]!, "men");

    fireEvent.click(screen.getByText("submit"));
    expect(payload.slug).toBe("men");
  });

  test("what the box shows is local; what the form holds is canonical", () => {
    // Press submit without ever leaving the box — the phone/email post-mortem.
    let payload: Record<string, unknown> = {};
    renderWithProviders(<Editor initial={null} onPayload={(p) => { payload = p; }} />);
    type(boxes()[0]!, "Anything");
    type(boxes()[1]!, "  Benim Özel Adresim!  ");

    expect((boxes()[1] as HTMLInputElement).value).toBe("  Benim Özel Adresim!  ");
    fireEvent.click(screen.getByText("submit"));
    expect(payload.slug).toBe("benim-ozel-adresim");
  });

  test("an existing row's slug is never re-derived when its source changes", () => {
    let payload: Record<string, unknown> = {};
    renderWithProviders(
      <Editor initial={{ id: "1", name: "Erkek Giyim", slug: "men" }} onPayload={(p) => { payload = p; }} />,
    );
    type(boxes()[0]!, "Erkek Giyim ve Aksesuar");

    // The box still shows the published URL…
    expect((boxes()[1] as HTMLInputElement).value).toBe("men");
    // …and the PATCH does not mention the slug at all, so the server leaves it.
    fireEvent.click(screen.getByText("submit"));
    expect("slug" in payload).toBe(false);
  });

  test("a row saved WITHOUT a slug still gets one derived", () => {
    // The empty-slug rows a workspace predating this feature is full of: the
    // guard is "already has one", not "is an update".
    renderWithProviders(
      <Editor initial={{ id: "1", name: "Old Row", slug: "" }} onPayload={() => {}} />,
    );
    type(boxes()[0]!, "Old Row Renamed");
    expect((boxes()[1] as HTMLInputElement).value).toBe("old-row-renamed");
  });
});
