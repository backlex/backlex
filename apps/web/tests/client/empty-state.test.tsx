import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { EmptyState } from "../../src/client/components/empty-state";

// Smoke test for the render harness itself (no providers / i18n needed):
// EmptyState is a pure presentational component, so it's the canary that the
// happy-dom preload + Testing Library wiring actually work.
describe("<EmptyState>", () => {
  afterEach(() => cleanup());

  test("renders the title", () => {
    render(<EmptyState title="No collections yet" />);
    expect(screen.getByText("No collections yet")).toBeTruthy();
  });

  test("renders the description when provided", () => {
    render(
      <EmptyState title="Nothing here" description="Create your first record" />,
    );
    expect(screen.getByText("Create your first record")).toBeTruthy();
  });

  test("omits the description node when not provided", () => {
    render(<EmptyState title="Bare" />);
    expect(screen.getByText("Bare")).toBeTruthy();
    expect(screen.queryByText("Create your first record")).toBeNull();
  });

  // The page-level sizes bring their own card chrome; `sm` deliberately does
  // not, which is why a page-level empty state must never use it.
  test("draws card chrome at the page-level sizes but not at sm", () => {
    const { container: lg } = render(<EmptyState title="Framed" />);
    expect(lg.querySelector('[data-slot="card"]')).toBeTruthy();
    cleanup();
    const { container: sm } = render(<EmptyState title="Inline" size="sm" />);
    expect(sm.querySelector('[data-slot="card"]')).toBeNull();
  });

  test("renders an action node", () => {
    render(
      <EmptyState title="Empty" action={<button type="button">New</button>} />,
    );
    expect(screen.getByRole("button", { name: "New" })).toBeTruthy();
  });
});
