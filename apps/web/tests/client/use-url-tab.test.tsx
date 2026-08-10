import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { useLocation } from "react-router";
import { useUrlTab } from "../../src/client/admin/use-url-tab";
import { renderWithProviders } from "./render";

// The shared tab-in-the-path hook every tabbed admin page reads its open panel
// from. Driven through a probe component so the assertions are about what a
// page sees, not about the hook's internals.
//
// Every test here mounts a probe at its own route, and `screen` queries the
// whole document — so without an explicit teardown the second mount finds two
// of everything. Auto-cleanup is not something to rely on under `bun test`:
// this file passed locally without it and failed in CI, which is the same
// teardown every other render spec in this folder writes out by hand.

afterEach(() => cleanup());

const TABS = ["items", "kpis", "schema", "settings"] as const;

function Probe({ depth = 1 }: { depth?: number }) {
  const [tab, setTab] = useUrlTab(TABS, "items", depth);
  const loc = useLocation();
  return (
    <div>
      <output data-testid="tab">{tab}</output>
      <output data-testid="path">{loc.pathname}</output>
      {TABS.map((t) => (
        <button key={t} type="button" onClick={() => setTab(t)}>
          go-{t}
        </button>
      ))}
    </div>
  );
}

const at = (route: string, depth?: number) =>
  renderWithProviders(<Probe depth={depth} />, { route });

const tabIs = () => screen.getByTestId("tab").textContent;
const pathIs = () => screen.getByTestId("path").textContent;

describe("reading the tab out of the path", () => {
  test("the segment names the tab", () => {
    at("/collections/schema");
    expect(tabIs()).toBe("schema");
  });

  test("no segment means the fallback, and the URL is left alone", () => {
    at("/collections");
    expect(tabIs()).toBe("items");
    // Not rewritten to /collections/items — see the note in the hook.
    expect(pathIs()).toBe("/collections");
  });

  test("a tab nobody has heard of reads as the fallback rather than nothing", () => {
    at("/collections/not-a-tab");
    expect(tabIs()).toBe("items");
  });

  test("a percent-encoded segment is decoded before it is matched", () => {
    at("/collections/%73chema");
    expect(tabIs()).toBe("schema");
  });

  test("at depth 2 the record comes first", () => {
    at("/collections/posts/kpis", 2);
    expect(tabIs()).toBe("kpis");
  });

  test("at depth 2 a record with no tab still opens", () => {
    at("/collections/posts", 2);
    expect(tabIs()).toBe("items");
  });
});

describe("switching tabs", () => {
  test("writes the tab into the path", () => {
    at("/collections");
    fireEvent.click(screen.getByText("go-schema"));
    expect(pathIs()).toBe("/collections/schema");
    expect(tabIs()).toBe("schema");
  });

  test("replaces the tab already there rather than appending", () => {
    at("/collections/schema");
    fireEvent.click(screen.getByText("go-kpis"));
    expect(pathIs()).toBe("/collections/kpis");
  });

  test("keeps the record when the tab sits under one", () => {
    at("/collections/posts/schema", 2);
    fireEvent.click(screen.getByText("go-settings"));
    expect(pathIs()).toBe("/collections/posts/settings");
  });

  test("leaving a record's sub-route drops it — a tab click leaves the item", () => {
    at("/collections/posts/items/abc-123", 2);
    expect(tabIs()).toBe("items");
    fireEvent.click(screen.getByText("go-schema"));
    expect(pathIs()).toBe("/collections/posts/schema");
  });

  test("does nothing when the segments the tab hangs off are not there", () => {
    at("/collections", 2);
    fireEvent.click(screen.getByText("go-schema"));
    expect(pathIs()).toBe("/collections");
  });

  test("clicking the open tab costs nothing", () => {
    at("/collections/schema");
    fireEvent.click(screen.getByText("go-schema"));
    expect(pathIs()).toBe("/collections/schema");
  });
});
