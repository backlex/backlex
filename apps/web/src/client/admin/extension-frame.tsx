// Sandboxed iframe host for extension-contributed UI (admin panels + item-form
// field editors) plus the postMessage bridge the extension talks over.
//
// Security model: the iframe is sandboxed with `allow-scripts` ONLY — no
// `allow-same-origin` — so the extension document runs under an opaque origin
// and can never read the admin session, cookies, or DOM directly. Everything
// it needs flows through the bridge below, and its API access is capped by the
// manifest's `permissions.api` allow-list (`apiPermits`, the client twin of
// the server-side check in services/extensions.ts).
//
// Bridge protocol (iframe → parent unless noted):
//   {type:"backlex-ext:ready"}                     → parent replies with init
//   {type:"backlex-ext:init", value, field, ctx}   (parent → iframe)
//   {type:"backlex-ext:resize", height}            → set iframe height (40–2000)
//   {type:"backlex-ext:value", value}              → onValueChange (field-editor)
//   {type:"backlex-ext:api", id, method, path, body?}
//     → parent fetches (if permitted) and replies
//   {type:"backlex-ext:api-result", id, ok, status, data}  (parent → iframe)
import { useCallback, useEffect, useRef } from "react";
import { cn } from "@backlex/ui/lib/utils";
import type { ApiExtension } from "./api";

/**
 * Does the manifest's `permissions.api` allow-list permit this call? Client
 * twin of the server's `apiPermits` — entries look like `"GET /api/items/posts"`
 * or `"* /api/items/*"` (`*` method wildcard, trailing `*` path prefix).
 * Paths must live under `/api/` and never contain `..`.
 */
export const apiPermits = (
  patterns: string[] | undefined,
  method: string,
  path: string,
): boolean => {
  if (!patterns || patterns.length === 0) return false;
  if (!path.startsWith("/api/") || path.includes("..")) return false;
  const m = method.toUpperCase();
  return patterns.some((p) => {
    const parts = p.trim().split(/\s+/);
    const pm = parts[0];
    const pp = parts[1];
    if (!pm || !pp || !pp.startsWith("/api/")) return false;
    if (pm !== "*" && pm.toUpperCase() !== m) return false;
    if (pp.endsWith("*")) return path.startsWith(pp.slice(0, -1));
    return path === pp;
  });
};

export interface ExtensionFrameProps {
  extension: ApiExtension;
  /** Entry file path within the extension's assets (from the manifest). */
  entry: string;
  mode: "panel" | "field-editor";
  /** Current field value (field-editor mode). */
  value?: unknown;
  /** The schema field definition (field-editor mode) — plain data only. */
  field?: unknown;
  onValueChange?: (v: unknown) => void;
  className?: string;
}

const MIN_H = 40;
const MAX_H = 2000;

export function ExtensionFrame({
  extension,
  entry,
  mode,
  value,
  field,
  onValueChange,
  className,
}: ExtensionFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // True once the iframe announced `ready` — value-prop changes before that
  // must not post (the extension seeds itself from the ready→init handshake).
  const readyRef = useRef(false);
  // Latest props via refs so the single message listener never needs rebinding.
  const valueRef = useRef(value);
  valueRef.current = value;
  const fieldRef = useRef(field);
  fieldRef.current = field;
  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;
  const extRef = useRef(extension);
  extRef.current = extension;
  // Last value RECEIVED from the iframe — suppresses the init echo that would
  // otherwise bounce every keystroke straight back into the editor.
  const lastFromFrameRef = useRef<unknown>(Symbol("none"));

  const post = useCallback((msg: unknown) => {
    // The sandboxed frame's origin is opaque, so "*" is the only usable target.
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  const postInit = useCallback(() => {
    post({
      type: "backlex-ext:init",
      value: valueRef.current,
      field: fieldRef.current,
      ctx: { mode },
    });
  }, [post, mode]);

  useEffect(() => {
    const handleApi = async (msg: {
      id?: unknown;
      method?: unknown;
      path?: unknown;
      body?: unknown;
    }) => {
      const id = String(msg.id ?? "");
      const method = String(msg.method ?? "GET").toUpperCase();
      const path = String(msg.path ?? "");
      const reply = (ok: boolean, status: number, data: unknown) =>
        post({ type: "backlex-ext:api-result", id, ok, status, data });
      if (!apiPermits(extRef.current.manifest?.permissions?.api, method, path)) {
        reply(false, 403, { error: "not permitted by extension manifest" });
        return;
      }
      try {
        const res = await fetch(path, {
          method,
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: msg.body != null ? JSON.stringify(msg.body) : undefined,
        });
        let data: unknown = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        reply(res.ok, res.status, data);
      } catch (e) {
        reply(false, 0, { error: (e as Error).message });
      }
    };

    const onMessage = (e: MessageEvent) => {
      // Only ever trust messages from OUR iframe's content window.
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const msg = e.data as { type?: unknown } | null;
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
      if (msg.type === "backlex-ext:ready") {
        readyRef.current = true;
        postInit();
      } else if (msg.type === "backlex-ext:resize") {
        // Panels fill the space their className gives them; only the
        // field-editor embed sizes itself to the extension's content.
        if (mode !== "field-editor") return;
        const h = Number((msg as { height?: unknown }).height);
        if (Number.isFinite(h) && iframeRef.current) {
          iframeRef.current.style.height = `${Math.min(MAX_H, Math.max(MIN_H, Math.round(h)))}px`;
        }
      } else if (msg.type === "backlex-ext:value") {
        if (mode !== "field-editor") return;
        const v = (msg as { value?: unknown }).value;
        lastFromFrameRef.current = v;
        onValueChangeRef.current?.(v);
      } else if (msg.type === "backlex-ext:api") {
        void handleApi(msg as { id?: unknown; method?: unknown; path?: unknown; body?: unknown });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [mode, post, postInit]);

  // Outside value changes re-seed the extension. Skip the echo of a value the
  // iframe itself just sent — re-initing on its own keystrokes would fight the
  // extension's local editor state.
  useEffect(() => {
    if (!readyRef.current) return;
    if (Object.is(value, lastFromFrameRef.current)) return;
    postInit();
  }, [value, postInit]);

  return (
    <iframe
      ref={iframeRef}
      // No allow-same-origin: opaque origin, no access to the admin session.
      sandbox="allow-scripts"
      src={`/api/extensions/${encodeURIComponent(extension.name)}/assets/${entry.replace(/^\/+/, "")}`}
      title={`${extension.name}:${entry}`}
      className={cn(
        "w-full rounded-control border border-border bg-card",
        mode === "panel" && "min-h-[420px] flex-1",
        className,
      )}
      style={mode === "field-editor" ? { height: 120 } : undefined}
    />
  );
}
