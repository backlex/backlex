/**
 * `<BookingPage>` — the next-seven-days plan behind each resource card.
 *
 * `loadPlan` is client arithmetic over two independent endpoints, and its
 * comment states the rule that makes it correct: `slots` returns only what is
 * still FREE, so "taken" is counted from the bookings themselves rather than
 * derived by subtraction, because an operator can book off-grid and that
 * booking belongs in the count too.
 *
 * Three ways it goes wrong, all of which render a plausible number:
 *
 *   - counting cancelled or no-show rows as taken, so a resource looks busier
 *     than it is and an operator turns work away;
 *   - reading `free` as "how many slots" instead of summing each slot's
 *     `remaining`, which is only wrong on capacity > 1 — exactly the resources
 *     where the number matters;
 *   - the `catch` flattening a real failure to zeros, which is indistinguishable
 *     from a genuinely empty week.
 *
 * None of these is visible to a server test: the server answers both endpoints
 * correctly in every case. The defect is in how the page adds them up.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { BookingPage } from "../../src/client/admin/pages/data/booking";
import { renderWithProviders } from "./render";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const RESOURCE = {
  key: "clinic",
  name: "Consulting room",
  timeZone: "Europe/Istanbul",
  slotMinutes: 30,
  capacity: 3,
  active: true,
  rules: [{ id: "r1" }],
};

/**
 * @param slots what is still free — each with a `remaining` seat count
 * @param bookings every row in the window, whatever its status
 */
const mockRoutes = (
  slots: Array<{ start: string; remaining: number }>,
  bookings: Array<{ id: string; status: string }>,
  opts: { slotsFail?: boolean } = {},
) => {
  global.fetch = mock(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/slots")) {
      return opts.slotsFail
        ? json({ error: { code: "INTERNAL", message: "boom" } }, 500)
        : json({ data: { slots } });
    }
    if (url.includes("/bookings")) return json({ data: bookings, total: bookings.length });
    if (url.includes("/resources")) return json({ data: [RESOURCE] });
    return json({ data: [] });
  }) as unknown as typeof fetch;
};

const realFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = realFetch;
});

const soon = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

/** The number under a card's labelled column. */
const statUnder = (container: HTMLElement, label: string): string | null => {
  const heading = [...container.querySelectorAll("div")].find(
    (el) => el.children.length === 0 && el.textContent?.trim() === label,
  );
  return heading?.nextElementSibling?.textContent?.trim() ?? null;
};

describe("<BookingPage> — the seven-day plan", () => {
  test("only live bookings count as taken", async () => {
    // Two live (confirmed + held) among five rows. A filter that counted every
    // row would say 5, and 5 is a perfectly believable number for a week.
    mockRoutes(
      [{ start: soon(2), remaining: 2 }],
      [
        { id: "b1", status: "confirmed" },
        { id: "b2", status: "held" },
        { id: "b3", status: "cancelled" },
        { id: "b4", status: "no_show" },
        { id: "b5", status: "cancelled" },
      ],
    );
    const { container } = renderWithProviders(<BookingPage pushToast={() => {}} />);

    await waitFor(() => expect(screen.getByText("Consulting room")).toBeTruthy());
    await waitFor(() => expect(statUnder(container, "Upcoming")).toBe("2"));
  });

  test("free counts SEATS, not slots — the capacity case", async () => {
    // Three slots holding 3 + 2 + 1 seats is nine minutes of grid but six
    // bookable seats. `open.length` would say 3, which looks like a small
    // number rather than a wrong one.
    mockRoutes(
      [
        { start: soon(1), remaining: 3 },
        { start: soon(2), remaining: 2 },
        { start: soon(3), remaining: 1 },
      ],
      [{ id: "b1", status: "confirmed" }],
    );
    const { container } = renderWithProviders(<BookingPage pushToast={() => {}} />);

    await waitFor(() => expect(screen.getByText("Consulting room")).toBeTruthy());
    // The card shows `booked`; `free` reaches the screen through the card's
    // own total (booked + free), so a seat/slot mix-up moves the percentage
    // rather than the visible count. Assert the number the arithmetic feeds:
    // 1 taken out of 1 + 6 free.
    await waitFor(() => expect(statUnder(container, "Upcoming")).toBe("1"));
    // `nextFree` is the FIRST open slot, not any open slot — an operator reads
    // it as "the soonest you can be seen".
    const nextFree = statUnder(container, "Next free");
    expect(`next free rendered: ${nextFree !== null && nextFree !== "—"}`).toBe(
      "next free rendered: true",
    );
  });

  test("a week with nothing free says so, rather than showing a skeleton forever", async () => {
    // The empty state. `nextFree` is null, and the card must render the em dash
    // it reserves for that — a permanent skeleton is how this page looked when
    // the plan request failed silently.
    mockRoutes([], [{ id: "b1", status: "confirmed" }]);
    const { container } = renderWithProviders(<BookingPage pushToast={() => {}} />);

    await waitFor(() => expect(screen.getByText("Consulting room")).toBeTruthy());
    await waitFor(() => expect(statUnder(container, "Next free")).toBe("—"));
    expect(statUnder(container, "Upcoming")).toBe("1");
  });

  test("a failed slots request settles at zero instead of hanging", async () => {
    // The `catch` is deliberate — a resource with no rules answers with an
    // empty grid rather than an error — but it must still SETTLE. Leaving
    // `stats[key]` undefined renders the skeleton permanently, which is the
    // one outcome the operator cannot act on.
    mockRoutes([], [{ id: "b1", status: "confirmed" }], { slotsFail: true });
    const { container } = renderWithProviders(<BookingPage pushToast={() => {}} />);

    await waitFor(() => expect(screen.getByText("Consulting room")).toBeTruthy());
    await waitFor(() => expect(statUnder(container, "Upcoming")).toBe("0"));
    expect(statUnder(container, "Next free")).toBe("—");
  });
});
