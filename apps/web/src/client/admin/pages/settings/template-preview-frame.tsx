import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { HtmlPreview } from "../../html-preview";
import { I } from "../../icons";
import { IconButton } from "../../ui";

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
 * Fitting is not READING, though, and that is what {@link PreviewExpandDialog}
 * is for. Measured on the live admin at a 1600px viewport: the page capped its
 * content at 1180px and split what was left in two, so the column offered 378px
 * and a 720px email came out at 53% — 13px body text drawn at under 7px. The
 * column is wider now, and the dialog shows the frame at 1:1 whatever the
 * column does.
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

/**
 * The same frame at 1:1, in a dialog as wide as the window allows.
 *
 * Why a dialog rather than a zoom control in the column: at 100% a 794px A4
 * sheet does not fit a 618px column on any monitor, so an in-column zoom buys
 * legibility by trading away the whole right-hand edge of the layout — the part
 * an author is usually checking. The dialog has the room to show both.
 *
 * The frame still cannot size itself — `sandbox=""` means no scripts, so the
 * document cannot report its height — so the height is passed in exactly as the
 * column version passes it, and the sheet scrolls inside the dialog body.
 */
export function PreviewExpandDialog({
  open,
  onOpenChange,
  html,
  width,
  height,
  complete,
  title,
  caption,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  html: string;
  width: number;
  height: number;
  complete: boolean;
  title: string;
  caption?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(96vw,calc(var(--preview-w)+4rem))] gap-0 p-0 sm:max-w-none"
        style={{ "--preview-w": `${width}px` } as CSSProperties}
      >
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        {/* `DialogBody`, not a hand-capped ScrollArea: the height a frame needs
            is whatever the header and footer leave, and this dialog's frame is
            560px or 1123px depending on the sheet — a rem budget guessed here
            would be wrong for one of them. DialogContent's grid measures it. */}
        <DialogBody type="auto" className="bg-[oklch(0.97_0.005_130)]">
          {/* `w-max min-w-full` is what makes the centring conditional. A plain
              `justify-center` in a scroll container centres content that is
              WIDER than the box too, which starts the view in the middle of the
              frame with its left edge off-screen behind the scroll origin —
              measured at 390px, where a 720px email opened mid-sentence. Sized
              to content with a full-width floor, the row only centres when
              there is slack. */}
          <div className="flex w-max min-w-full justify-center p-4">
            <div
              className="shrink-0 overflow-hidden rounded-surface bg-white shadow-[0_1px_4px_oklch(0_0_0/0.06)]"
              style={{ width, height }}
            >
              <HtmlPreview title={title} complete={complete} html={html} className="h-full" />
            </div>
          </div>
        </DialogBody>
        {/* The third in-flow child DialogContent's grid expects. It is the
            footer track, so it keeps its height while the body shrinks. */}
        <div className="border-t border-border px-4 py-2 text-center font-mono text-[10.5px] text-muted-foreground">
          {caption ?? `${width}px`} · 100%
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The button that opens it, for a preview card's header. */
export function PreviewExpandButton({ onClick }: { onClick: () => void }) {
  const { t } = useLingui();
  return (
    <IconButton
      icon={I.Maximize2}
      title={t`Expand preview`}
      onClick={onClick}
      data-testid="preview-expand"
    />
  );
}
