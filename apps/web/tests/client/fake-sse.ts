/**
 * An SSE subscription a test can deliver events on.
 *
 * This used to stub the `EventSource` global, because that is what the SDK's
 * realtime layer opened and neither Bun nor happy-dom provides one. The SDK now
 * reads the stream over `fetch` instead — `EventSource` cannot set headers, so
 * a client holding an API key or a workspace token could never authenticate a
 * subscription, and the global does not exist off-browser at all. So the stub
 * moved with it: it answers the subscribe request with a stream the test
 * controls, which means these tests now exercise the transport that ships
 * rather than one that only existed in the test process.
 *
 * Shared rather than copied because the tests that need it assert quite
 * different things (the reactive rows, the hook lifecycle, keep-previous-data),
 * and three copies of a stub drift in exactly the way that makes one of them
 * quietly stop delivering events.
 */

/** The SSE path the SDK subscribes on. */
export const SUBSCRIBE_PATH = "/subscribe";

export class FakeSse {
  static instances: FakeSse[] = [];
  readonly url: string;
  readonly headers: Record<string, string>;
  closed = false;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly encoder = new TextEncoder();

  constructor(url: string, init?: RequestInit) {
    this.url = url;
    this.headers = (init?.headers ?? {}) as Record<string, string>;
    FakeSse.instances.push(this);
    // Unsubscribing aborts the request — that is what "closed" means now.
    init?.signal?.addEventListener("abort", () => {
      this.closed = true;
      try {
        this.controller?.close();
      } catch {
        // already closed
      }
    });
  }

  /** The streaming response the SDK will read. */
  response(): Response {
    const body = new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        this.controller = ctrl;
        // The server opens with `ready`; the SDK must ignore it.
        ctrl.enqueue(this.encoder.encode("event: ready\ndata: ok\n\n"));
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  /** Test hook: push one SSE frame at the SDK. */
  emit(type: string, data: string): void {
    if (this.closed || !this.controller) return;
    this.controller.enqueue(this.encoder.encode(`event: ${type}\ndata: ${data}\n\n`));
  }
}

/** Emit a realtime item event the way the server would (JSON on `message`). */
export const emitItem = (
  es: FakeSse,
  event: "created" | "updated" | "deleted",
  data: Record<string, unknown>,
): void => es.emit("message", JSON.stringify({ event, data }));

/**
 * Answer a subscribe request with a controllable stream, or `null` when the
 * url is not one. Put this at the top of a test's fetch handler.
 */
export const sseResponse = (url: string, init?: RequestInit): Response | null =>
  url.includes(SUBSCRIBE_PATH) ? new FakeSse(url, init).response() : null;

/** Reset between tests. */
export const resetSse = (): void => {
  FakeSse.instances.length = 0;
};
