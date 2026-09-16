import { useLayoutEffect, useRef, useState } from "react";
import { HtmlPreview } from "../../html-preview";

/**
 * A template preview at a real layout size, scaled down to fit when the column
 * is narrower than that — which a desktop email, and every page size, always is
 * here. Shrinking a frame of the real width shows how the template lays out on
 * that device or sheet; squeezing it into the column instead would only ever
 * show the column's width.
 *
 * The sizer carries the scaled box, so nothing wider than the column reaches the
 * layout and a phone viewport never scrolls sideways.
 *
 * Shared by the email- and document-template editors; the email page had it
 * first.
 */
export function ScaledPreview({
  html,
  width,
  height,
  complete,
  title,
  testId,
  device,
  caption,
}: {
  html: string;
  width: number;
  height: number;
  /** A body that brings its own `<html>`; a fragment is wrapped. */
  complete: boolean;
  title: string;
  testId?: string;
  /** Written as `data-device`, so a test can ask which layout is showing. */
  device?: string;
  /** Printed under the frame; defaults to the width and the scale. */
  caption?: string;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    const measure = () => setAvailable(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // `available` is 0 until measured (and always, without layout): show 1:1.
  const scale = available > 0 && available < width ? available / width : 1;
  return (
    <div ref={outer} className="w-full min-w-0">
      <div
        className="mx-auto overflow-hidden rounded-surface bg-white shadow-[0_1px_4px_oklch(0_0_0/0.06)]"
        style={{ width: Math.floor(width * scale), height: Math.floor(height * scale) }}
      >
        <div
          data-testid={testId}
          data-device={device}
          style={{
            width,
            height,
            transform: scale < 1 ? `scale(${scale})` : undefined,
            transformOrigin: "top left",
          }}
        >
          <HtmlPreview title={title} complete={complete} html={html} className="h-full" />
        </div>
      </div>
      <div className="mt-2 text-center font-mono text-[10.5px] text-muted-foreground">
        {caption ?? `${width}px`}
        {scale < 1 ? ` · ${Math.round(scale * 100)}%` : ""}
      </div>
    </div>
  );
}
