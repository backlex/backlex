/**
 * An `EventSource` a test can deliver events on.
 *
 * The SDK's realtime layer opens a real `EventSource`, which neither Bun nor
 * happy-dom provides — so any test that renders `useLiveQuery` has to stand one
 * up. Shared rather than copied because the tests that need it assert quite
 * different things (the reactive rows, the hook lifecycle, keep-previous-data),
 * and three copies of a stub drift in exactly the way that makes one of them
 * quietly stop delivering events.
 */

type Listener = (ev: unknown) => void;

export class FakeEventSource {
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
export const emitItem = (
  es: FakeEventSource,
  event: "created" | "updated" | "deleted",
  data: Record<string, unknown>,
): void => es.emit("message", { data: JSON.stringify({ event, data }) });

/**
 * Install the stub and hand back the restore function. Call from `beforeEach`
 * and restore in `afterEach` — leaving it installed would replace the global
 * for the backend specs sharing this `bun test` process.
 */
export const installEventSource = (): (() => void) => {
  const real = (globalThis as { EventSource?: unknown }).EventSource;
  FakeEventSource.instances.length = 0;
  (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
  return () => {
    (globalThis as { EventSource: unknown }).EventSource = real;
  };
};
