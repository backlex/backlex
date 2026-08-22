import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup } from "@testing-library/react";
import { ConsentPage } from "../../src/client/admin/pages/observability/consent";
import { renderWithProviders } from "./render";

/**
 * The consent tab, and the one thing its form must not do.
 *
 * The server refuses to invent a compliance posture. A UI that preselected one
 * would route straight around that: the operator would click Save on a legal
 * position they never chose, the server would accept it because the field is
 * present, and every layer would look correct. So these pin that both dropdowns
 * open EMPTY and that Save is unreachable until the operator answers.
 *
 * The geometry half of the UI rules — no horizontal overflow at 390px, the
 * dialog footer staying on screen — needs a real layout engine and is not
 * assertable here; happy-dom reports every rect as zero.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const SITES = [
  {
    id: "site-1",
    name: "Acme",
    domain: "acme.example",
    tz: "UTC",
    excludedPaths: [],
    ignoredIps: [],
    filterBots: true,
    requireKnownOrigin: true,
    createdAt: 1,
    updatedAt: 1,
  },
];

const POLICY = {
  siteId: "site-1",
  categoriesOffered: ["analytics"],
  undecidedBehaviour: "block",
  trackerCategory: "none",
  wording: {},
  defaultLocale: "en",
  policyUrl: null,
  position: "bottom",
  theme: {},
  cookieMaxAgeDays: 180,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

let puts: { url: string; body: any }[] = [];

const mockRoutes = (policies: unknown[], opts: { slowSites?: boolean | number } = {}) => {
  puts = [];
  global.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method === "PUT") {
      puts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ data: { ...POLICY, ...JSON.parse(String(init.body)) } });
    }
    if (url.includes("/api/admin/consent/policies")) return json({ data: policies });
    if (url.includes("/api/admin/analytics/sites")) {
      if (opts.slowSites) {
        const ms = typeof opts.slowSites === "number" ? opts.slowSites : 50;
        await new Promise((r) => setTimeout(r, ms));
      }
      return json({ data: SITES });
    }
    return json({ data: [] });
  }) as unknown as typeof fetch;
};

const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
};

const click = async (el: Element) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === text,
  ) as HTMLButtonElement | undefined;

// RTL's auto-cleanup is order-dependent under bun:test — this codebase calls it
// explicitly.
afterEach(() => cleanup());

describe("the loading state", () => {
  test("a fast load shows no skeleton at all — no flash", async () => {
    // 50ms, inside `page-skeletons.tsx`'s SKELETON_DELAY_MS (200). Every page
    // skeleton is wrapped in `withSkeletonDelay`, which renders `null` until
    // the window elapses precisely so a quick load goes straight to content.
    // This page carried its own UNDELAYED skeleton while it was a tab, so it
    // used to flash one on every render; moving it to `page-skeletons.tsx`
    // fixed that, and this is the assertion that says so.
    mockRoutes([], { slowSites: 50 });
    const { container } = renderWithProviders(<ConsentPage pushToast={() => {}} />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
    await settle();
  });

  test("a slow one shows a skeleton, never a 'Loading…' string or a bare spinner", async () => {
    mockRoutes([], { slowSites: 600 });
    const { container } = renderWithProviders(<ConsentPage pushToast={() => {}} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(container.textContent ?? "").not.toContain("Loading");
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    await settle();
  });
});

describe("a site with no policy", () => {
  test("says so, rather than showing an empty policy", async () => {
    mockRoutes([]);
    const { container } = renderWithProviders(<ConsentPage pushToast={() => {}} />);
    await settle();
    const text = container.textContent ?? "";
    // The honest reading: nothing configured means nothing asked and nothing
    // blocked, which is materially different from "configured, but off".
    expect(text).toContain("No policy yet");
    expect(buttonByText("Set up consent")).toBeTruthy();
    // Nothing to remove when there is nothing configured.
    expect(buttonByText("Remove")).toBeUndefined();
  });
});

describe("a configured site", () => {
  test("shows the posture on the card, not just that a policy exists", async () => {
    mockRoutes([POLICY]);
    const { container } = renderWithProviders(<ConsentPage pushToast={() => {}} />);
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("Banner live");
    expect(text).toContain("Blocks before consent");
    expect(text).toContain("Tag: strictly necessary");
    expect(buttonByText("Edit policy")).toBeTruthy();
  });
});

describe("the two decisions with no default", () => {
  test("open empty, and Save stays disabled until both are answered", async () => {
    mockRoutes([]);
    renderWithProviders(<ConsentPage pushToast={() => {}} />);
    await settle();

    await click(buttonByText("Set up consent")!);
    await settle();

    // Radix renders a Select trigger as a button carrying the placeholder while
    // nothing is chosen. Both must be in that state.
    const placeholders = [...document.querySelectorAll("button")].filter((b) =>
      (b.textContent ?? "").includes("there is no default"),
    );
    expect(placeholders.length).toBe(2);

    const save = buttonByText("Save");
    expect(save).toBeTruthy();
    // The whole point: an operator cannot save a policy without answering.
    expect(save!.disabled).toBe(true);
    expect(puts.length).toBe(0);
  });

  test("the option hints state the consequence, not just the value", async () => {
    mockRoutes([]);
    renderWithProviders(<ConsentPage pushToast={() => {}} />);
    await settle();
    await click(buttonByText("Set up consent")!);
    await settle();

    // Read the option text out of the component's own props rather than opening
    // a Radix portal: what matters is that the strings ship, and that an
    // operator choosing `allow` is told it is unlawful in the EU before they
    // choose it — not after a regulator does.
    const html = document.body.innerHTML;
    expect(html).toContain("Before a visitor decides");
    expect(html).toContain("own analytics tag");
    // The label sits next to a control the operator must answer, so the helper
    // text explaining WHY there is no default has to ship with it.
    expect(html).toContain("neither answer is safe everywhere");
  });
});

describe("editing an existing policy", () => {
  test("seeds from the stored policy and can save without restating it", async () => {
    mockRoutes([POLICY]);
    renderWithProviders(<ConsentPage pushToast={() => {}} />);
    await settle();

    await click(buttonByText("Edit policy")!);
    await settle();

    // Seeded, so Save is reachable immediately — an admin fixing the banner
    // position is not re-deciding the compliance posture.
    const save = buttonByText("Save")!;
    expect(save.disabled).toBe(false);

    await click(save);
    await settle();

    expect(puts.length).toBe(1);
    expect(puts[0]!.url).toContain("/api/admin/consent/policies/site-1");
    // …and what it sends is the STORED posture, carried forward rather than
    // blanked by the round trip.
    expect(puts[0]!.body.undecidedBehaviour).toBe("block");
    expect(puts[0]!.body.trackerCategory).toBe("none");
  });

  test("the dialog closes immediately — the save is optimistic", async () => {
    mockRoutes([POLICY]);
    renderWithProviders(<ConsentPage pushToast={() => {}} />);
    await settle();
    await click(buttonByText("Edit policy")!);
    await settle();
    await click(buttonByText("Save")!);
    // No settle: the dialog must be gone before the request resolves, not
    // after. Waiting on the round trip is the await-then-refetch shape this
    // codebase does not ship.
    expect(buttonByText("Cancel")).toBeUndefined();
  });
});

describe("with no sites at all", () => {
  test("points at the Sites tab instead of showing an empty consent list", async () => {
    global.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/admin/analytics/sites")) return json({ data: [] });
      return json({ data: [] });
    }) as unknown as typeof fetch;

    const { container } = renderWithProviders(<ConsentPage pushToast={() => {}} />);
    await settle();
    expect(container.textContent ?? "").toContain("No websites registered");
  });
});
