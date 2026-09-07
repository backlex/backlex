/**
 * The Live tail says what it is actually doing.
 *
 * It used to say "Subscribed. Waiting for events…" unconditionally, over a
 * green status dot, because both call sites passed a bare `connected` — the
 * literal `true`. On a first visit to the Realtime page nothing was subscribed
 * at all: `showRealtime` defaults false and the subscription effect returned
 * early. So the pane reported a state it had not reached, and an operator
 * debugging a realtime problem reads that as "the client is connected, so the
 * problem is upstream" and spends their time in the wrong half of the system.
 * See #330.
 *
 * The assertion is on the COPY rather than on the prop, because the prop being
 * threaded correctly is not the property that failed — the prop existed. What
 * failed is that the words did not depend on it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { renderWithProviders as render } from "./render";
import { RealtimeTail, type TailStatus } from "../../src/client/admin/extras";

const dot = (c: HTMLElement) => c.querySelector("span.rounded-full") as HTMLElement | null;

describe("<RealtimeTail> with no events", () => {
  afterEach(() => cleanup());

  test("only `connected` claims a subscription", () => {
    const claims: Record<TailStatus, boolean> = {
      connected: false,
      connecting: false,
      off: false,
      error: false,
    };
    for (const status of ["connected", "connecting", "off", "error"] as TailStatus[]) {
      render(<RealtimeTail events={[]} channel="items:posts" status={status} />);
      claims[status] = !!screen.queryByText(/Subscribed\. Waiting for events/);
      cleanup();
    }
    // The whole defect in one assertion: three of these four used to be true.
    expect(claims).toEqual({
      connected: true,
      connecting: false,
      off: false,
      error: false,
    });
  });

  test("every non-connected state says so in words, not just by omission", () => {
    // An empty pane with no explanation is the other way to be unhelpful here.
    for (const status of ["connecting", "off", "error"] as TailStatus[]) {
      const { container } = render(
        <RealtimeTail events={[]} channel="items:posts" status={status} />,
      );
      const text = container.textContent ?? "";
      expect(text).toMatch(/Subscribing|Not subscribed/);
      cleanup();
    }
  });

  test("the status dot is green only when connected, and red only on a fault", () => {
    // `off` must NOT be red: a preview nobody switched on is not a fault, and
    // painting it as one sends the reader looking for a break that is not there.
    const cls = (status: TailStatus) => {
      const { container } = render(
        <RealtimeTail events={[]} channel="c" status={status} />,
      );
      const out = dot(container)?.className ?? "";
      cleanup();
      return out;
    };
    expect(cls("connected")).toContain("bg-primary");
    expect(cls("error")).toContain("bg-destructive");
    expect(cls("off")).not.toContain("bg-primary");
    expect(cls("off")).not.toContain("bg-destructive");
    expect(cls("connecting")).not.toContain("bg-primary");
    expect(cls("connecting")).not.toContain("bg-destructive");
  });

  test("an actual event still renders, whatever the status says", () => {
    // The status copy is the EMPTY state. A tail holding events must never be
    // replaced by it — that would trade one wrong answer for another.
    render(
      <RealtimeTail
        events={[
          {
            event: "created",
            id: "e1",
            title: "Hello",
            who: "system",
            t: "just now",
            receivedAt: Date.now(),
          },
        ]}
        channel="items:posts"
        status="error"
      />,
    );
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(screen.queryByText(/Not subscribed/)).toBeNull();
  });
});
