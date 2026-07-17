/**
 * SDK React binding — `useLiveQuery` (packages/client/src/react.ts).
 *
 * Drives the hook through a REAL `createClient` with the network layer mocked
 * at both seams the SDK touches:
 *   - `fetch` (the initial `list()` load) via the client's `fetch` option;
 *   - `EventSource` (the SSE subscription) via a global stub the tests can
 *     emit synthetic `message` events on.
 *
 * Pins: initial loading state, success data, error surfacing, live
 * created/updated/deleted events mutating the rendered rows without a refetch,
 * unmount cleanup (EventSource closed), and the deep-equal-opts guard (an
 * equal-but-new opts object must NOT tear down the subscription).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { createClient, type BacklexClient, type LiveQueryOptions } from "../../../../packages/client/src/index";
import { useLiveQuery } from "../../../../packages/client/src/react";
import { renderWithProviders } from "./render";

// ── EventSource stub ────────────────────────────────────────────────────────

type Listener = (ev: unknown) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string, _init?: unknown) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  close(): void {
    this.closed = true;
  }
  /** Test hook: deliver a synthetic SSE event to the SDK's listeners. */
  emit(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

/** Emit a realtime item event the way the server would (JSON on `message`). */
const emitItem = (
  es: FakeEventSource,
  event: "created" | "updated" | "deleted",
  data: Record<string, unknown>,
): void => es.emit("message", { data: JSON.stringify({ event, data }) });

// ── fetch mock (client-scoped — never touches global fetch) ─────────────────

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeClient = (
  handler: (url: string) => Response | Promise<Response>,
): BacklexClient =>
  createClient({
    url: "http://api.test",
    tracing: false,
    fetch: (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return handler(url);
    }) as typeof fetch,
  });

// ── Probe component ─────────────────────────────────────────────────────────

interface Row extends Record<string, unknown> {
  id: string;
  title: string;
}

function Probe(props: { client: BacklexClient; slug?: string; opts?: LiveQueryOptions }) {
  const { data, loading, error } = useLiveQuery<Row>(
    props.client,
    props.slug ?? "todos",
    props.opts ?? {},
  );
  return (
    <div>
      <span data-testid="loading">{loading ? "loading" : "ready"}</span>
      <span data-testid="error">
        {error instanceof Error ? error.message : error ? String(error) : ""}
      </span>
      <ul data-testid="rows">
        {data.map((r) => (
          <li key={r.id}>{r.title}</li>
        ))}
      </ul>
    </div>
  );
}

const ready = () =>
  waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("ready"));

// ── Suite ───────────────────────────────────────────────────────────────────

describe("useLiveQuery", () => {
  const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;

  beforeEach(() => {
    FakeEventSource.instances.length = 0;
    (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
  });
  afterEach(() => {
    cleanup();
    (globalThis as { EventSource: unknown }).EventSource = realEventSource;
  });

  test("starts loading with no rows, then renders the initial list()", async () => {
    let resolveList!: (r: Response) => void;
    const urls: string[] = [];
    const client = makeClient((url) => {
      urls.push(url);
      return new Promise<Response>((res) => {
        resolveList = res;
      });
    });

    renderWithProviders(<Probe client={client} />);

    // Before the list() resolves: loading, empty, no error.
    expect(screen.getByTestId("loading").textContent).toBe("loading");
    expect(screen.getByTestId("rows").children.length).toBe(0);
    expect(screen.getByTestId("error").textContent).toBe("");
    expect(urls[0]).toBe("http://api.test/api/items/todos");

    await act(async () => {
      resolveList(json({ data: [{ id: "1", title: "First" }], limit: 50, offset: 0 }));
    });

    await ready();
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByTestId("error").textContent).toBe("");
  });

  test("a failing initial load surfaces the error and clears loading", async () => {
    const client = makeClient(() =>
      json({ error: { code: "FORBIDDEN", message: "nope" } }, 403),
    );

    renderWithProviders(<Probe client={client} />);

    // BacklexError carries the server's message.
    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("nope"));
    expect(screen.getByTestId("loading").textContent).toBe("ready");
    expect(screen.getByTestId("rows").children.length).toBe(0);
  });

  test("SSE created/updated/deleted events mutate the rendered rows with no refetch", async () => {
    let listCalls = 0;
    const client = makeClient(() => {
      listCalls++;
      return json({ data: [{ id: "1", title: "First" }], limit: 50, offset: 0 });
    });

    renderWithProviders(<Probe client={client} />);
    await ready();
    expect(screen.getByText("First")).toBeTruthy();

    const es = FakeEventSource.instances[0];
    expect(es).toBeDefined();
    expect(es!.url).toContain("/api/realtime/items:todos/subscribe");

    // created → appended.
    act(() => emitItem(es!, "created", { id: "2", title: "Second" }));
    await waitFor(() => expect(screen.getByText("Second")).toBeTruthy());

    // updated → replaced in place.
    act(() => emitItem(es!, "updated", { id: "1", title: "First (edited)" }));
    await waitFor(() => expect(screen.getByText("First (edited)")).toBeTruthy());
    expect(screen.queryByText("First")).toBeNull();

    // deleted → removed.
    act(() => emitItem(es!, "deleted", { id: "2", title: "Second" }));
    await waitFor(() => expect(screen.queryByText("Second")).toBeNull());
    expect(screen.getByText("First (edited)")).toBeTruthy();

    // The whole sequence rode the incremental path: exactly one list() fetch.
    expect(listCalls).toBe(1);
  });

  test("unmount closes the EventSource and late events are inert", async () => {
    const client = makeClient(() =>
      json({ data: [{ id: "1", title: "First" }], limit: 50, offset: 0 }),
    );

    const { unmount } = renderWithProviders(<Probe client={client} />);
    await ready();

    const es = FakeEventSource.instances[0];
    expect(es).toBeDefined();
    expect(es!.closed).toBe(false);

    unmount();
    expect(es!.closed).toBe(true);

    // An event arriving after unmount must not throw or update anything.
    emitItem(es!, "created", { id: "9", title: "Ghost" });
  });

  test("changing the query clears the previous rows while the new result loads", async () => {
    // Regression: the old hook kept the previous subscription's `data` during
    // the transition, rendering one query's rows as another query's result.
    let deferList: ((r: Response) => void) | null = null;
    const client = makeClient((url) => {
      if (url.includes("done")) {
        // Second query (changed filter): hold the response open.
        return new Promise<Response>((res) => {
          deferList = res;
        });
      }
      return json({ data: [{ id: "1", title: "First" }], limit: 50, offset: 0 });
    });

    const { rerender } = renderWithProviders(<Probe client={client} opts={{}} />);
    await ready();
    expect(screen.getByText("First")).toBeTruthy();

    rerender(
      <Probe client={client} opts={{ filter: { done: { _eq: true } } }} />,
    );

    // Mid-transition: loading again AND the old rows are gone.
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("loading"));
    expect(screen.getByTestId("rows").children.length).toBe(0);

    await act(async () => {
      deferList!(json({ data: [{ id: "2", title: "Second" }], limit: 50, offset: 0 }));
    });
    await ready();
    expect(screen.getByText("Second")).toBeTruthy();
    expect(screen.queryByText("First")).toBeNull();
  });

  test("a deep-equal (new-reference) opts object does not resubscribe; a changed one does", async () => {
    const client = makeClient(() => json({ data: [], limit: 10, offset: 0 }));

    const { rerender } = renderWithProviders(
      <Probe client={client} opts={{ limit: 10 }} />,
    );
    await ready();
    expect(FakeEventSource.instances.length).toBe(1);

    // Same content, new object reference → the JSON key is unchanged, so the
    // effect must NOT tear down and rebuild the subscription.
    rerender(<Probe client={client} opts={{ limit: 10 }} />);
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]!.closed).toBe(false);

    // Actually different opts → old subscription closed, new one opened.
    rerender(<Probe client={client} opts={{ limit: 20 }} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances[1]!.closed).toBe(false);
  });
});
