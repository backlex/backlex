import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/** Load-on-mount with a re-run handle. Returns `data: null` while loading, so a
 *  screen can render its skeleton off that rather than off a boolean. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (updater: (prev: T | null) => T | null) => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setLoading(true);
    setError(null);
    fn()
      .then((r) => {
        if (alive.current) setData(r);
      })
      .catch((e) => {
        if (alive.current) setError(e);
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  const patch = useCallback((updater: (prev: T | null) => T | null) => setData((p) => updater(p)), []);
  return { data, error, loading, reload: () => setNonce((n) => n + 1), setData: patch };
}

type Toast = { id: number; text: string; tone: "ok" | "err" };
const ToastCtx = createContext<(text: string, tone?: "ok" | "err") => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: "ok" | "err" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((p) => [...p, { id, text, tone }]);
    setTimeout(() => setItems((p) => p.filter((t) => t.id !== id)), 5200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-3 bottom-3 z-[60] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-4">
        {items.map((t) => (
          <div
            key={t.id}
            className={
              "pointer-events-auto max-w-md rounded-control border px-3 py-2 text-sm shadow-lg " +
              (t.tone === "ok"
                ? "border-ok/40 bg-ok/15 text-ok"
                : "border-bad/40 bg-bad/15 text-bad")
            }
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** The message a backlex error actually carries — the SDK throws `BacklexError`
 *  with `code` + `details`, and the details are usually the useful half. */
export function errText(e: unknown): string {
  if (!e) return "";
  const anyE = e as { message?: string; code?: string; details?: unknown };
  const detail =
    anyE.details && typeof anyE.details === "object"
      ? Array.isArray(anyE.details)
        ? anyE.details.map((d: unknown) => (d as { message?: string })?.message).filter(Boolean).join("; ")
        : JSON.stringify(anyE.details)
      : "";
  return [anyE.code, anyE.message, detail].filter(Boolean).join(" · ");
}
