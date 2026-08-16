import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { TemplateOnboarding } from "../../src/client/admin/pages/data/template-onboarding";
import { renderWithProviders } from "./render";

/**
 * The template picker's preview, and the line that says what a template brings
 * BESIDES tables.
 *
 * Worth pinning rather than eyeballing, because every failure mode here looks
 * like a working screen:
 *
 *  - a template with no bundles must render no heading at all, not an empty
 *    row with a title over nothing;
 *  - a count of zero must not be listed — "Flows · 0" reads as a promise the
 *    apply then breaks;
 *  - and the whole block has to survive `bundles` being absent, which is what
 *    an admin bundle cached from before this shipped will send.
 */
const catalog = (over: Record<string, unknown> = {}) => ({
  data: [
    {
      id: "invoicing",
      label: "Invoicing",
      description: "Billing.",
      category: "Finance",
      recommended: false,
      sampleRows: 29,
      groups: ["Billing"],
      roles: ["Bookkeeper"],
      dashboards: ["Billing overview"],
      bundles: {
        kpis: 4,
        flows: 6,
        documents: 2,
        forms: 1,
        agents: 1,
        flags: 0,
        channels: 0,
      },
      collections: [
        { slug: "invoices", label: "Invoices", fieldCount: 13, group: "Billing" },
      ],
      ...over,
    },
  ],
  defaultTemplateId: "invoicing",
  hasCollections: false,
  sampleSeeds: 0,
});

const renderPicker = (over?: Record<string, unknown>) =>
  renderWithProviders(<TemplateOnboarding pushToast={() => {}} onApplied={() => {}} />, {
    seed: (qc) => qc.setQueryData(["templates"], catalog(over)),
  });

describe("template preview — what else arrives", () => {
  afterEach(cleanup);

  test("lists each bundled kind with its count, and omits the empty ones", () => {
    const { container } = renderPicker();
    const heading = screen.getByText("Also arrives ready to run");
    // The badges are siblings of the heading inside the block it titles —
    // read them as rendered text rather than by label, since each badge is a
    // label node and a count node in one element.
    const block = heading.closest("div")?.parentElement;
    const badges = [...(block?.querySelectorAll("span") ?? [])]
      .map((el) => el.textContent?.replace(/\s+/g, " ").trim())
      .filter((t): t is string => !!t);

    for (const expected of [
      "Flows · 6",
      "PDF templates · 2",
      "Public forms · 1",
      "AI agents · 1",
      "KPIs · 4",
    ]) {
      expect(badges, expected).toContain(expected);
    }
    // Zeroes are not promises the apply has to keep.
    expect(container.textContent).not.toContain("Feature flags");
    expect(container.textContent).not.toContain("Channels");
  });

  test("a template that bundles nothing shows no heading", () => {
    renderPicker({
      bundles: { kpis: 0, flows: 0, documents: 0, forms: 0, agents: 0, flags: 0, channels: 0 },
    });
    expect(screen.queryByText("Also arrives ready to run")).toBeNull();
  });

  test("an older worker's payload, with no bundles at all, still renders", () => {
    // `bundles` is a field this release added. A preview that throws on its
    // absence takes the whole onboarding card down.
    renderPicker({ bundles: undefined });
    expect(screen.queryByText("Also arrives ready to run")).toBeNull();
    expect(screen.getByText("Invoicing")).toBeTruthy();
  });
});
