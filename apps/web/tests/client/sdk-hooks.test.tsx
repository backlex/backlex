/**
 * The rest of the React surface (packages/client/src/react.ts): `useList`,
 * `useAggregate`, `useItemMutation` / `useOptimistic`, `useUpload`, and the
 * two things `useLiveQuery` grew — `refetch` and opt-in `keepPreviousData`.
 *
 * The optimistic tests are the point of the file. This repository's own rule
 * is that a mutation shows immediately and reconciles afterwards, never
 * `await mutate(); await refetch()`. Getting that wrong is not visible in a
 * unit test of the client — it is visible as a row that blinks back to its old
 * value for as long as the round trip takes, so it is pinned here instead.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { createClient, type BacklexClient } from "../../../../packages/client/src/index";
import {
  useAggregate,
  useItemMutation,
  useList,
  useLiveQuery,
  useUpload,
} from "../../../../packages/client/src/react";
import { renderWithProviders } from "./render";
import { resetSse, sseResponse } from "./fake-sse";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Row extends Record<string, unknown> {
  id: string;
  title: string;
}

const makeClient = (
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): BacklexClient =>
  createClient({
    url: "http://api.test",
    tracing: false,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/realtime/items-config")) return json({ transport: "sse" });
      // The realtime subscription is a streaming GET now, not an EventSource.
      const sse = sseResponse(url, init);
      if (sse) return sse;
      return handler(url, init);
    }) as typeof fetch,
  });

afterEach(cleanup);

// ── useList ─────────────────────────────────────────────────────────────────

describe("useList", () => {
  function Probe({ client, limit }: { client: BacklexClient; limit?: number }) {
    const { data, loading, error, total } = useList<Row>(client, "todos", { limit });
    return (
      <div>
        <span data-testid="loading">{loading ? "loading" : "ready"}</span>
        <span data-testid="total">{total === null ? "-" : String(total)}</span>
        <span data-testid="error">{error ? "error" : ""}</span>
        <ul data-testid="rows">
          {data.map((r) => (
            <li key={r.id}>{r.title}</li>
          ))}
        </ul>
      </div>
    );
  }

  test("loads once and reports the total when the server sends one", async () => {
    const client = makeClient(() =>
      json({ data: [{ id: "1", title: "First" }], total: 7, limit: 50, offset: 0 }),
    );
    renderWithProviders(<Probe client={client} />);

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("ready"));
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByTestId("total").textContent).toBe("7");
  });

  test("a slow first answer cannot overwrite a fast second one", async () => {
    // The silent race: change a filter twice and the FIRST request can resolve
    // last, leaving the screen showing a result nobody asked for.
    let releaseSlow!: (r: Response) => void;
    const client = makeClient((url) => {
      if (url.includes("limit=1")) {
        return new Promise<Response>((res) => {
          releaseSlow = res;
        });
      }
      return json({ data: [{ id: "2", title: "Second" }], limit: 2, offset: 0 });
    });

    const { rerender } = renderWithProviders(<Probe client={client} limit={1} />);
    rerender(<Probe client={client} limit={2} />);
    await waitFor(() => expect(screen.getByText("Second")).toBeTruthy());

    await act(async () => {
      releaseSlow(json({ data: [{ id: "1", title: "Stale" }], limit: 1, offset: 0 }));
    });

    expect(screen.queryByText("Stale")).toBeNull();
    expect(screen.getByText("Second")).toBeTruthy();
  });

  test("`enabled: false` asks for nothing at all", async () => {
    let calls = 0;
    const client = makeClient(() => {
      calls++;
      return json({ data: [], limit: 50, offset: 0 });
    });

    function Gated() {
      const { loading } = useList<Row>(client, "todos", {}, { enabled: false });
      return <span data-testid="loading">{loading ? "loading" : "ready"}</span>;
    }
    renderWithProviders(<Gated />);

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("ready"));
    expect(calls).toBe(0);
  });

  test("a failed load surfaces the error instead of rendering half a list", async () => {
    const client = makeClient(() => json({ error: { code: "VALIDATION" } }, 422));
    renderWithProviders(<Probe client={client} />);

    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("error"));
    expect(screen.getByTestId("rows").children.length).toBe(0);
  });
});

// ── useAggregate ────────────────────────────────────────────────────────────

describe("useAggregate", () => {
  test("runs one aggregate and renders its rows", async () => {
    const client = makeClient(() => json({ data: [{ status: "open", count: 3 }] }));

    function Probe() {
      const { data, loading } = useAggregate(client, "todos", {
        fn: "count",
        groupBy: ["status"],
      } as never);
      return (
        <div>
          <span data-testid="loading">{loading ? "loading" : "ready"}</span>
          <span data-testid="count">{String(data[0]?.count ?? "")}</span>
        </div>
      );
    }
    renderWithProviders(<Probe />);

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("ready"));
    expect(screen.getByTestId("count").textContent).toBe("3");
  });
});

// ── Optimistic writes ───────────────────────────────────────────────────────

describe("useItemMutation", () => {
  /** A list plus its mutations, which is how the two hooks are meant to pair. */
  function Board({
    client,
    onReady,
  }: {
    client: BacklexClient;
    onReady?: (m: ReturnType<typeof useItemMutation<Row>>) => void;
  }) {
    const list = useList<Row>(client, "todos", {});
    const m = useItemMutation<Row>(client, "todos");
    onReady?.(m);
    return (
      <div>
        <span data-testid="pending">{m.pending ? "pending" : "idle"}</span>
        <span data-testid="error">{m.error ? "error" : ""}</span>
        <ul data-testid="rows">
          {m.overlay(list.data).map((r) => (
            <li key={r.id}>{r.title}</li>
          ))}
        </ul>
      </div>
    );
  }

  test("a create is on screen before the server has answered", async () => {
    let releaseCreate!: (r: Response) => void;
    const client = makeClient((_url, init) => {
      if (init?.method === "POST") {
        return new Promise<Response>((res) => {
          releaseCreate = res;
        });
      }
      return json({ data: [{ id: "1", title: "Existing" }], limit: 50, offset: 0 });
    });

    let m!: ReturnType<typeof useItemMutation<Row>>;
    renderWithProviders(<Board client={client} onReady={(x) => (m = x)} />);
    await waitFor(() => expect(screen.getByText("Existing")).toBeTruthy());

    act(() => {
      void m.create({ title: "Brand new" }).catch(() => {});
    });

    // The whole point: visible while the request is still in flight.
    await waitFor(() => expect(screen.getByText("Brand new")).toBeTruthy());
    expect(screen.getByTestId("pending").textContent).toBe("pending");

    await act(async () => {
      releaseCreate(json({ data: { id: "2", title: "Brand new" } }));
    });
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("idle"));
    // Still exactly one — the placeholder handed over to the real row rather
    // than being drawn beside it.
    expect(screen.getAllByText("Brand new").length).toBe(1);
  });

  test("a confirmed update does NOT flash back to the old value", async () => {
    // The regression that made this hook keep its overlay until the source
    // array agrees: dropping it when the response lands re-renders the stored
    // row, which is still the old one until a refetch.
    const client = makeClient((_url, init) => {
      if (init?.method === "PATCH") return json({ data: { id: "1", title: "Renamed" } });
      return json({ data: [{ id: "1", title: "Original" }], limit: 50, offset: 0 });
    });

    let m!: ReturnType<typeof useItemMutation<Row>>;
    renderWithProviders(<Board client={client} onReady={(x) => (m = x)} />);
    await waitFor(() => expect(screen.getByText("Original")).toBeTruthy());

    await act(async () => {
      await m.update("1", { title: "Renamed" });
    });

    expect(screen.getByText("Renamed")).toBeTruthy();
    expect(screen.queryByText("Original")).toBeNull();
  });

  test("a failed write rolls back, and the error never renders beside the change", async () => {
    const client = makeClient((_url, init) => {
      if (init?.method === "PATCH") return json({ error: { code: "VALIDATION" } }, 422);
      return json({ data: [{ id: "1", title: "Original" }], limit: 50, offset: 0 });
    });

    let m!: ReturnType<typeof useItemMutation<Row>>;
    renderWithProviders(<Board client={client} onReady={(x) => (m = x)} />);
    await waitFor(() => expect(screen.getByText("Original")).toBeTruthy());

    await act(async () => {
      await m.update("1", { title: "Renamed" }).catch(() => {});
    });

    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("error"));
    // Rolled back: the row a reader sees and the message they see agree.
    expect(screen.getByText("Original")).toBeTruthy();
    expect(screen.queryByText("Renamed")).toBeNull();
  });

  test("a delete disappears immediately and comes back if the server refuses", async () => {
    const client = makeClient((_url, init) => {
      if (init?.method === "DELETE") return json({ error: { code: "FORBIDDEN" } }, 403);
      return json({ data: [{ id: "1", title: "Doomed" }], limit: 50, offset: 0 });
    });

    let m!: ReturnType<typeof useItemMutation<Row>>;
    renderWithProviders(<Board client={client} onReady={(x) => (m = x)} />);
    await waitFor(() => expect(screen.getByText("Doomed")).toBeTruthy());

    await act(async () => {
      await m.remove("1").catch(() => {});
    });

    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("error"));
    expect(screen.getByText("Doomed")).toBeTruthy();
  });
});

// ── useLiveQuery additions ──────────────────────────────────────────────────

describe("useLiveQuery — refetch and keepPreviousData", () => {
  beforeEach(resetSse);

  function Probe({
    client,
    limit,
    keep,
    onReady,
  }: {
    client: BacklexClient;
    limit?: number;
    keep?: boolean;
    onReady?: (r: ReturnType<typeof useLiveQuery<Row>>) => void;
  }) {
    const r = useLiveQuery<Row>(client, "todos", { limit }, { keepPreviousData: keep });
    onReady?.(r);
    return (
      <div>
        <span data-testid="refreshing">{r.refreshing ? "refreshing" : ""}</span>
        <ul data-testid="rows">
          {r.data.map((row) => (
            <li key={row.id}>{row.title}</li>
          ))}
        </ul>
      </div>
    );
  }

  test("`keepPreviousData` holds the old rows and says it is refreshing", async () => {
    let releaseSecond!: (r: Response) => void;
    const client = makeClient((url) => {
      if (url.includes("limit=2")) {
        return new Promise<Response>((res) => {
          releaseSecond = res;
        });
      }
      return json({ data: [{ id: "1", title: "First" }], limit: 1, offset: 0 });
    });

    const { rerender } = renderWithProviders(<Probe client={client} limit={1} keep />);
    await waitFor(() => expect(screen.getByText("First")).toBeTruthy());

    rerender(<Probe client={client} limit={2} keep />);

    // Opt-in behaviour: the previous query's rows are still on screen, and the
    // hook says so rather than pretending the data is current.
    await waitFor(() => expect(screen.getByTestId("refreshing").textContent).toBe("refreshing"));
    expect(screen.getByText("First")).toBeTruthy();

    await act(async () => {
      releaseSecond(json({ data: [{ id: "2", title: "Second" }], limit: 2, offset: 0 }));
    });
    await waitFor(() => expect(screen.getByText("Second")).toBeTruthy());
    expect(screen.getByTestId("refreshing").textContent).toBe("");
  });

  test("`refetch` re-runs the query", async () => {
    let loads = 0;
    const client = makeClient(() => {
      loads++;
      return json({ data: [{ id: String(loads), title: `Load ${loads}` }], limit: 50, offset: 0 });
    });

    let r!: ReturnType<typeof useLiveQuery<Row>>;
    renderWithProviders(<Probe client={client} onReady={(x) => (r = x)} />);
    await waitFor(() => expect(screen.getByText("Load 1")).toBeTruthy());

    act(() => r.refetch());
    await waitFor(() => expect(screen.getByText("Load 2")).toBeTruthy());
  });
});

// ── useUpload ───────────────────────────────────────────────────────────────

describe("useUpload", () => {
  test("a failed upload surfaces the error and stops claiming to be uploading", async () => {
    const client = makeClient(() => json({ error: { code: "INTERNAL" } }, 500));

    let hook!: ReturnType<typeof useUpload>;
    function Probe() {
      hook = useUpload(client);
      return (
        <div>
          <span data-testid="uploading">{hook.uploading ? "uploading" : "idle"}</span>
          <span data-testid="error">{hook.error ? "error" : ""}</span>
        </div>
      );
    }
    renderWithProviders(<Probe />);

    await act(async () => {
      await hook
        .upload({ key: "a.txt", data: new Blob(["hi"]), contentType: "text/plain" })
        .catch(() => {});
    });

    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("error"));
    // The flag every hand-rolled uploader gets wrong: a failure has to clear
    // it, or the button stays disabled until the page is reloaded.
    expect(screen.getByTestId("uploading").textContent).toBe("idle");
  });
});
