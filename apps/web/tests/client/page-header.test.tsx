import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { PageHeader } from "../../src/client/components/page-header";
import { renderWithProviders } from "./render";

// PageHeader uses the Lingui macro (`useLingui`) and react-router's <Link>, so a
// passing render here proves the whole client-test stack: the lingui-macro Bun
// loader transformed the compile-time macro, and the provider harness supplies
// the i18n + router contexts a real admin page needs.
describe("<PageHeader>", () => {
  afterEach(() => cleanup());

  test("renders the title and description", () => {
    renderWithProviders(
      <PageHeader title="Collections" description="Manage your data" />,
    );
    expect(screen.getByText("Collections")).toBeTruthy();
    expect(screen.getByText("Manage your data")).toBeTruthy();
  });

  test("renders breadcrumbs as links with a labelled nav (lingui macro ran)", () => {
    renderWithProviders(
      <PageHeader
        title="Edit"
        breadcrumbs={[
          { label: "Collections", to: "/collections" },
          { label: "Posts" },
        ]}
      />,
    );
    // The aria-label comes from a `t\`Breadcrumb\`` macro — if the macro hadn't
    // been transformed this render would have thrown.
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "Collections" });
    expect(link.getAttribute("href")).toBe("/collections");
  });

  test("renders the actions slot", () => {
    renderWithProviders(
      <PageHeader title="X" actions={<button type="button">Save</button>} />,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});
