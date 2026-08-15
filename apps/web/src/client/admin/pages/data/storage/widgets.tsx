// Storage leaf components: tiles, glyphs, the file-detail panel/modal,
// folder picker, pagination footer. Split out of admin/storage.tsx.
// Storage page — preview, batch upload progress, ACL, file detail modal
import { Fragment, useEffect, useState, type CSSProperties } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../../icons";
import { Badge, Button, IconButton, Switch } from "../../../ui";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@backlex/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@backlex/ui/components/popover";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { Button as ShadButton } from "@backlex/ui/components/button";
import { CheckIcon, ChevronsUpDownIcon, LinkIcon } from "lucide-react";
import { cn } from "@backlex/ui/lib/utils";
import { api } from "@/lib/api";
import { Skeleton } from "@backlex/ui/components/skeleton";

import {
  FileMetadata,
  SEG_BTN_BASE,
  SEG_BTN_OFF,
  SEG_BTN_ON,
  SIZE_CHIP_BASE,
  SIZE_CHIP_OFF,
  SIZE_CHIP_ON,
  StoredFile,
} from "./shared";

export function thumbnailUrl(f: StoredFile, displayPx: number): string {
  const base = `/api/storage/${encodeURI(f.key)}`;
  if (f.acl !== "public") return base;
  // 2× DPR floor at 80px so even a 20px chip fetches sharp pixels on retina.
  const w = Math.max(80, Math.round(displayPx * 2));
  return `${base}?width=${w}&format=webp&quality=70&fit=cover`;
}

export function FileGlyph({ f, size = 64 }: { f: StoredFile; size?: number }) {
  const isImg = Boolean(f.type && f.type.startsWith("image/"));
  const [imgFailed, setImgFailed] = useState(false);
  if (isImg && !imgFailed) {
    return (
      <img
        src={thumbnailUrl(f, typeof size === "number" ? size : 64)}
        alt=""
        loading="lazy"
        onError={() => setImgFailed(true)}
        style={{
          width: size,
          height: size,
          objectFit: "cover",
          borderRadius: "var(--radius-md)",
          flexShrink: 0,
          display: "block",
          background: "var(--muted)",
        }}
      />
    );
  }
  if (isImg) {
    const hue = f.hue ?? 200;
    const px = typeof size === "number" ? size : 64;
    return (
      <div style={{ width: size, height: size, borderRadius: "var(--radius-md)", background: `linear-gradient(135deg, oklch(0.78 0.16 ${hue}) 0%, oklch(0.55 0.18 ${(hue + 60) % 360}) 100%)`, position: "relative", overflow: "hidden", flexShrink: 0 }}>
        <div style={{ position: "absolute", bottom: -px * 0.2, left: -px * 0.1, width: px * 0.6, height: px * 0.6, borderRadius: "50%", background: `oklch(0.92 0.12 ${(hue + 30) % 360} / 0.6)` }} />
        <div style={{ position: "absolute", top: px * 0.15, right: px * 0.15, width: px * 0.18, height: px * 0.18, borderRadius: "50%", background: "oklch(1 0 0 / 0.7)" }} />
      </div>
    );
  }
  const ext = (f.type || "").split("/")[1] || "file";
  const colorMap: Record<string, number> = { csv: 145, pdf: 22, markdown: 280, json: 50, plain: 200 };
  const hue = colorMap[ext] || 200;
  return (
    <div style={{ width: size, height: size, borderRadius: "var(--radius-md)", background: `oklch(0.96 0.02 ${hue})`, border: `1px solid oklch(0.85 0.05 ${hue})`, display: "grid", placeItems: "center", flexShrink: 0, fontFamily: "Geist Mono, monospace", fontSize: typeof size === "number" ? Math.max(8, size * 0.18) : 12, fontWeight: 600, color: `oklch(0.4 0.1 ${hue})`, textTransform: "uppercase" }}>
      {ext.slice(0, 4)}
    </div>
  );
}

export function ImageMock({ hue = 200, focal, style = {} as CSSProperties }: { hue?: number; focal?: { x: number; y: number }; style?: CSSProperties }) {
  const fx = focal?.x ?? 50;
  const fy = focal?.y ?? 50;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", ...style }}>
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(135deg, oklch(0.82 0.12 ${hue}) 0%, oklch(0.55 0.16 ${(hue + 50) % 360}) 100%)` }} />
      <div style={{ position: "absolute", left: `${fx}%`, top: `${fy}%`, width: "32%", height: "32%", transform: "translate(-50%, -50%)", borderRadius: "50%", background: `radial-gradient(circle, oklch(0.96 0.06 ${(hue + 30) % 360} / 0.85) 0%, oklch(0.96 0.06 ${(hue + 30) % 360} / 0) 70%)` }} />
    </div>
  );
}

export function FileTile({ f, active, onSelect, onCopyUrl }: { f: StoredFile; active: boolean; onSelect: () => void; onCopyUrl: (key: string) => void }) {
  const { t } = useLingui();
  const isImg = Boolean(f.type && f.type.startsWith("image/"));
  const [imgFailed, setImgFailed] = useState(false);
  const sizeStr = f.size > 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(1) + " MB" : (f.size / 1024).toFixed(1) + " KB";
  const displayName = (f.metadata && typeof f.metadata.name === "string" && f.metadata.name.trim()) || (f.key.split("/").pop() ?? f.key);
  return (
    <div
      onClick={onSelect}
      className={`flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-control border transition-[background,border-color] duration-100 ${
        active ? "border-primary bg-[color-mix(in_oklch,var(--primary)_6%,transparent)]" : "border-border bg-card"
      }`}
    >
      <div className="relative aspect-[16/9] bg-muted">
        {isImg && !imgFailed ? (
          <img
            src={thumbnailUrl(f, 320)}
            alt=""
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="absolute inset-0 block size-full object-cover"
          />
        ) : isImg ? (
          <ImageMock hue={f.hue ?? 200} />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <FileGlyph f={f} size={64} />
          </div>
        )}
        {f.acl === "public" && (
          <span
            className="absolute left-1.5 top-1.5 rounded-full bg-[oklch(0.25_0.04_145/0.85)] px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[oklch(0.9_0.18_145)]"
            title="public"
          >
            public
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {displayName}
          </span>
          {/* Copy URL — uses the chain-link icon (the "<>" code glyph was
              misleading). Stops propagation so the detail modal stays
              closed. shadcn Button primitive, no raw <button>. */}
          <ShadButton
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={(e) => { e.stopPropagation(); onCopyUrl(f.key); }}
            title={t`Copy URL`}
            aria-label={t`Copy URL`}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <LinkIcon className="size-3" />
          </ShadButton>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10.5px] tabular-nums text-muted-foreground">{sizeStr}</span>
          <span className="text-[10.5px] text-muted-foreground">·</span>
          <span className="truncate text-[10.5px] text-muted-foreground">
            {(f.type || "").split("/")[1] || "file"}
          </span>
        </div>
      </div>
    </div>
  );
}

export function FileDetailModal({ f, onClose, ...rest }: any) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-[min(720px,92vw)] gap-0 p-0 lg:w-[min(1000px,94vw)] lg:max-w-[1000px]">
        <DialogHeader className="flex items-start gap-3 border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[14.5px] font-semibold tracking-[-0.01em]"><Trans>Edit file</Trans></DialogTitle>
            <DialogDescription className="mt-0.5 truncate font-mono text-xs">{f.key}</DialogDescription>
          </div>
        </DialogHeader>
        {/* Full bleed: FileDetail's preview runs edge to edge and the panels
            under it bring their own padding. */}
        <DialogBody data-full-bleed>
          <FileDetail f={f} {...rest} embedded />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function FileDetail({ f, fmtSize, isImage, w, setW, h, setH, q, setQ, fmt, setFmt, fit, setFit, focal, setFocal, folders, onPatch, onToggleACL, onDelete, onCopy, pushToast, embedded }: any) {
  const { t } = useLingui();
  const fileMeta: FileMetadata = (f.metadata as FileMetadata | null) ?? {};
  // Local edit buffer for the metadata section — flushed to the server via
  // onPatch when the user clicks Save. Re-syncs whenever the underlying
  // file changes (e.g. after a server-confirmed merge).
  const [metaName, setMetaName] = useState<string>(fileMeta.name ?? "");
  const [metaDescription, setMetaDescription] = useState<string>(fileMeta.description ?? "");
  const [metaTags, setMetaTags] = useState<string[]>(fileMeta.tags ?? []);
  const [metaTagDraft, setMetaTagDraft] = useState<string>("");
  const [metaAuthor, setMetaAuthor] = useState<string>(fileMeta.author ?? "");
  const [metaLocation, setMetaLocation] = useState<string>(fileMeta.location ?? "");
  const [metaSaving, setMetaSaving] = useState<boolean>(false);
  useEffect(() => {
    setMetaName(fileMeta.name ?? "");
    setMetaDescription(fileMeta.description ?? "");
    setMetaTags(fileMeta.tags ?? []);
    setMetaTagDraft("");
    setMetaAuthor(fileMeta.author ?? "");
    setMetaLocation(fileMeta.location ?? "");
    // f.key is the row identity; we only resync when the *file* changes,
    // not on every metadata update from the optimistic patch (otherwise
    // typing into the description would get wiped by our own save).
  }, [f.key]);
  const metaDirty =
    (fileMeta.name ?? "") !== metaName ||
    (fileMeta.description ?? "") !== metaDescription ||
    JSON.stringify(fileMeta.tags ?? []) !== JSON.stringify(metaTags) ||
    (fileMeta.author ?? "") !== metaAuthor ||
    (fileMeta.location ?? "") !== metaLocation;

  const saveMeta = async () => {
    if (!onPatch || metaSaving) return;
    setMetaSaving(true);
    // null sentinel = remove the key on the server; empty string also clears.
    const patch: Record<string, unknown> = {
      name: metaName.trim() || null,
      description: metaDescription.trim() || null,
      tags: metaTags.length ? metaTags : null,
      author: metaAuthor.trim() || null,
      location: metaLocation.trim() || null,
    };
    const ok = await onPatch({ metadata: patch });
    setMetaSaving(false);
    if (ok) pushToast?.(t`Metadata saved.`);
  };

  const commitTagDraft = () => {
    const v = metaTagDraft.trim();
    if (!v) return;
    if (metaTags.includes(v)) { setMetaTagDraft(""); return; }
    setMetaTags([...metaTags, v]);
    setMetaTagDraft("");
  };

  const moveToFolder = async (folderId: string | null) => {
    if (!onPatch) return;
    const ok = await onPatch({ folderId });
    if (ok) pushToast?.(folderId ? t`Moved.` : t`Moved to root.`);
  };

  const url = `/api/storage/${encodeURI(f.key)}`;
  const params = isImage
    ? `?width=${w}${h != null ? `&height=${h}` : ""}&format=${fmt}&quality=${q}&fit=${fit}&focal=${focal.x},${focal.y}`
    : "";
  const transformedUrl = url + params;
  // Copying / signing produces URLs that travel outside the admin tab —
  // a chat message, an <img> on another site, a curl invocation. Relative
  // paths are fine for in-page <img>/HEAD/anchor download (browser resolves
  // them against the page origin) but useless once detached.
  const toAbsolute = (rel: string): string =>
    rel.startsWith("http") ? rel : window.location.origin + rel;

  // Probe the transform URL with a debounced HEAD. The response tells us
  // three things in one round-trip:
  //   - content-length → real transformed size for the readout
  //   - 422 → the runtime can't transform this file (private + Workers
  //     without an internal-fetch fallback). We swap <img src> back to
  //     the un-transformed URL so the preview keeps working and surface
  //     the server's hint in place of the size readout.
  //   - other non-2xx → silently drop the size; img onError handles it.
  //
  // Both fetches go through `cache: "no-store"` because the transformed
  // response carries `Cache-Control: immutable` for a year — the right
  // call for byte-addressed transforms, but wrong for this freshness
  // probe. Without it, toggling a file from public → private wouldn't
  // surface the new 422 until the year-long cache entry expired.
  const [transformedSize, setTransformedSize] = useState<number | null>(null);
  const [transformedLoading, setTransformedLoading] = useState(false);
  const [transformError, setTransformError] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) { setTransformedSize(null); setTransformError(null); return; }
    setTransformedLoading(true);
    const ctrl = new AbortController();
    // NOT `t` — that is the lingui translate function this callback uses on
    // the 422 branch, and shadowing it turned the fallback message into a call
    // on the timer handle (`TypeError: t is not a function`) exactly when a
    // runtime could not transform the file.
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(transformedUrl, { method: "HEAD", credentials: "include", cache: "no-store", signal: ctrl.signal });
        if (res.status === 422) {
          let msg = t`Transforms unavailable for this file on this runtime.`;
          try {
            const r2 = await fetch(transformedUrl, { credentials: "include", cache: "no-store", signal: ctrl.signal });
            const j = await r2.json().catch(() => null);
            if (j?.error?.message) msg = j.error.message;
          } catch {}
          setTransformError(msg);
          setTransformedSize(null);
          return;
        }
        setTransformError(null);
        if (!res.ok) { setTransformedSize(null); return; }
        const len = res.headers.get("content-length");
        setTransformedSize(len ? Number(len) : null);
      } catch {
        // AbortError on re-trigger is expected; everything else just clears.
      } finally {
        setTransformedLoading(false);
      }
    }, 300);
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [transformedUrl, isImage]);
  // When the runtime can't transform, the preview falls back to the raw
  // object so the user still sees their image.
  const effectiveSrc = transformError ? url : transformedUrl;

  const aspect = (isImage && f.w && f.h) ? f.h / f.w : 0.6;
  // When the user pins height, the label shows it verbatim; otherwise we
  // derive from the source aspect so the slider readout still makes sense.
  const previewH = h != null ? h : ((isImage && f.w) ? Math.round(w * aspect) : null);

  const Wrapper: any = embedded ? Fragment : "div";
  const wrapperProps: any = embedded ? {} : { className: "flex flex-col overflow-hidden rounded-surface border border-border bg-card text-card-foreground" };

  /** Hit POST /api/storage/_sign/<key> and return the relative signed URL.
   *  Prefix form (not `<key>/sign` suffix) — see the routing note in
   *  `routes/storage.ts` for why. */
  const signOnce = async (ttlSeconds: number): Promise<string> => {
    const res = await api<{ url: string }>(
      `/api/storage/_sign/${encodeURI(f.key)}`,
      { method: "POST", body: JSON.stringify({ ttlSeconds }) },
    );
    return res.url;
  };

  /** Append transform params to a signed URL — the server validates the
   *  token first then runs the transform path, so this stays one request.
   *  Skipped when the runtime can't transform this file (Workers + private
   *  + no internal-fetch fallback), in which case we sign the raw object. */
  const withTransformParams = (signed: string): string => {
    if (!params || transformError) return signed;
    return signed + (signed.includes("?") ? "&" : "?") + params.slice(1);
  };

  const onDownload = async () => {
    try {
      const href = f.acl === "public"
        ? effectiveSrc
        : withTransformParams(await signOnce(60));
      const a = document.createElement("a");
      a.href = href;
      a.download = f.key.split("/").pop() || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  const onSignUrl = async () => {
    try {
      const signed = await signOnce(3600);
      onCopy(toAbsolute(withTransformParams(signed)));
      pushToast?.(t`Signed URL copied (1h).`);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  return (
    <Wrapper {...wrapperProps}>
      {!embedded && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <span className="text-[13px] font-medium"><Trans>File detail</Trans></span>
          <div className="flex-1" />
          <IconButton icon={I.Trash} title={t`Delete`} onClick={onDelete} />
        </div>
      )}

      {/* Desktop: two columns — visual+transform | info+form. Mobile: stacked. */}
      <div className="grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* LEFT — preview (the focal-point picker) + transform controls */}
      <div className="flex min-w-0 flex-col">
      <div
        className="relative grid aspect-[16/9] place-items-center overflow-hidden"
        onClick={(e) => {
          if (!isImage) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * 100;
          const y = ((e.clientY - r.top) / r.height) * 100;
          setFocal({ x: Math.round(x), y: Math.round(y) });
        }}
        style={{ background: "repeating-conic-gradient(var(--muted) 0% 25%, var(--background) 0% 50%) 50% / 16px 16px", cursor: isImage ? "crosshair" : "default" }}
      >
        {isImage ? (
          <>
            <img
              key={effectiveSrc}
              src={effectiveSrc}
              alt=""
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              className="absolute inset-0 block size-full bg-muted"
              style={{ objectFit: fit === "contain" ? "contain" : "cover" }}
            />
            {/* Focal-point picker lives here now — click anywhere or snap to a third. */}
            <div className="pointer-events-none absolute inset-0 [background-image:linear-gradient(to_right,oklch(1_0_0/0.22)_1px,transparent_1px),linear-gradient(to_bottom,oklch(1_0_0/0.22)_1px,transparent_1px)] [background-size:33.33%_33.33%]">
              {[0, 1, 2].map((row) => (
                [0, 1, 2].map((col) => {
                  const x = col * 50; const y = row * 50;
                  return <button key={`${row}-${col}`} type="button" className={cn("pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border-[1.5px] p-0", focal.x === x && focal.y === y ? "border-white bg-[oklch(0.55_0.22_22)]" : "border-[oklch(0_0_0/0.4)] bg-[oklch(1_0_0/0.6)] hover:bg-white")} style={{ left: `${x}%`, top: `${y}%` }} onClick={(e: any) => { e.stopPropagation(); setFocal({ x, y }); }} title={`${x},${y}`} />;
                })
              ))}
            </div>
            <div
              className="pointer-events-none absolute grid size-[18px] place-items-center rounded-full border-2 border-[oklch(0.55_0.22_22)] bg-white shadow-[0_2px_6px_oklch(0_0_0/0.4)]"
              style={{ left: `calc(${focal.x}% - 1px)`, top: `calc(${focal.y}% - 1px)` }}
            >
              <span className="size-1 rounded-full bg-[oklch(0.55_0.22_22)]" />
            </div>
            <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-[oklch(0_0_0/0.6)] px-2 py-[3px] font-mono text-[10.5px] tracking-[0.04em] text-white">{fmt} · {w}{previewH ? `×${previewH}` : ""}</div>
          </>
        ) : (
          <div className="relative flex flex-col items-center gap-1.5 text-muted-foreground">
            <FileGlyph f={f} size={64} />
            <span className="font-mono text-[11.5px]">{f.type}</span>
          </div>
        )}
      </div>

      {isImage && (
        <>
          <div className="flex flex-col gap-3 border-t border-border p-3.5">
            <div className="flex items-center gap-2">
              <I.Sliders size={13} />
              <span className="text-xs font-medium uppercase tracking-[0.06em]"><Trans>Transform</Trans></span>
              <div className="flex-1" />
              <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-muted-foreground hover:text-foreground hover:underline" onClick={() => { setW(f.w || 1600); setH(null); setQ(80); setFmt("webp"); setFit("cover"); setFocal({ x: 50, y: 50 }); }}><Trans>Reset</Trans></button>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
                <Trans>Width</Trans>
                <span className="tabular-nums text-muted-foreground">{w}px {f.w && <span className="opacity-60">· {Math.round((w / f.w) * 100)}%</span>}</span>
              </label>
              <div className="flex items-center gap-2">
                <input type="range" min={120} max={Math.max(1600, f.w || 1600)} step={20} value={w} onChange={(e) => setW(Number(e.target.value))} className="flex-1" />
              </div>
              <div className="mt-1.5 flex gap-1">
                {[256, 512, 800, 1200, 1600].map((preset) => (
                  <button key={preset} className={cn(SIZE_CHIP_BASE, (w === preset) ? SIZE_CHIP_ON : SIZE_CHIP_OFF)} onClick={() => setW(preset)}>{preset}</button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
                <Trans>Height</Trans>
                <span className="tabular-nums text-muted-foreground">
                  {h != null ? `${h}px` : t`auto`}
                </span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={120}
                  max={Math.max(1600, f.h || 1600)}
                  step={20}
                  value={h ?? Math.round(w * aspect)}
                  onChange={(e) => setH(Number(e.target.value))}
                  className="flex-1"
                  disabled={h == null}
                  aria-disabled={h == null}
                />
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <button className={cn(SIZE_CHIP_BASE, (h == null) ? SIZE_CHIP_ON : SIZE_CHIP_OFF)} onClick={() => setH(null)} title={t`Derive from width × source aspect`}><Trans>auto</Trans></button>
                <button className={cn(SIZE_CHIP_BASE, (h === w) ? SIZE_CHIP_ON : SIZE_CHIP_OFF)} onClick={() => setH(w)} title={t`1:1 square`}>1:1</button>
                <button className={cn(SIZE_CHIP_BASE, (h === Math.round(w * 9 / 16)) ? SIZE_CHIP_ON : SIZE_CHIP_OFF)} onClick={() => setH(Math.round(w * 9 / 16))} title={t`16:9 widescreen`}>16:9</button>
                <button className={cn(SIZE_CHIP_BASE, (h === Math.round(w * 5 / 4)) ? SIZE_CHIP_ON : SIZE_CHIP_OFF)} onClick={() => setH(Math.round(w * 5 / 4))} title={t`4:5 portrait`}>4:5</button>
                <button className={cn(SIZE_CHIP_BASE, (h === Math.round(w * 2 / 3)) ? SIZE_CHIP_ON : SIZE_CHIP_OFF)} onClick={() => setH(Math.round(w * 2 / 3))} title={t`3:2 standard`}>3:2</button>
              </div>
              <span className="text-[11.5px] text-muted-foreground">
                {h == null
                  ? <Trans>Auto = preserve source aspect. Pin height to crop to a different aspect (uses Focal point + fit=cover).</Trans>
                  : <Trans>Aspect-cropping active. Focal point picks which area is kept.</Trans>}
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Quality</Trans> <span className="tabular-nums text-muted-foreground">{q}</span></label>
              <input type="range" min={10} max={100} step={5} value={q} onChange={(e) => setQ(Number(e.target.value))} className="w-full" />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Format</Trans></label>
              <div className="inline-flex w-full divide-x divide-border overflow-hidden rounded-control border border-border bg-card">
                {[
                  { v: "webp", save: "−45%" },
                  { v: "avif", save: "−60%" },
                  { v: "jpeg", save: "0%" },
                  { v: "png", save: "+lossless" },
                ].map((o) => (
                  <button key={o.v} type="button" className={cn(SEG_BTN_BASE, fmt === o.v ? SEG_BTN_ON : SEG_BTN_OFF)} onClick={() => setFmt(o.v)}>
                    <span className="font-mono">{o.v}</span>
                    <span className="ml-1 text-[10px] opacity-70">{o.save}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Fit</Trans></label>
              <div className="inline-flex w-full divide-x divide-border overflow-hidden rounded-control border border-border bg-card">
                {["cover", "contain"].map((o) => (
                  <button key={o} type="button" className={cn(SEG_BTN_BASE, fit === o ? SEG_BTN_ON : SEG_BTN_OFF)} onClick={() => setFit(o)}><span className="font-mono">{o}</span></button>
                ))}
              </div>
            </div>

            <span className="text-[11.5px] text-muted-foreground"><Trans>Click the preview to set the crop pivot — <span className="font-mono">focal {focal.x},{focal.y}</span> — applied when <span className="font-mono">fit=cover</span>.</Trans></span>
          </div>

          <div className="px-3.5 pb-3.5">
          {transformError ? (
            <div
              className="flex items-start gap-2 rounded-control border border-border bg-[color-mix(in_oklch,var(--muted)_25%,var(--card))] px-3 py-2.5 text-xs"
              role="alert"
            >
              <I.Shield size={14} className="mt-0.5 shrink-0 text-[oklch(0.65_0.16_50)]" />
              <div className="min-w-0">
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Transform unavailable</Trans></div>
                <div className="text-xs leading-[1.4]">{transformError}</div>
                <div className="mt-1 text-[11.5px] text-muted-foreground">
                  <Trans>Showing the original above. Toggle <span className="font-mono">Public</span> to enable edge resizing for this file.</Trans>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2.5 rounded-control border border-border bg-[color-mix(in_oklch,var(--muted)_25%,var(--card))] px-3 py-2.5 text-xs">
              <div>
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Original</Trans></div>
                <div className="tabular-nums">{fmtSize(f.size)}</div>
              </div>
              <I.ChevronRight size={14} className="text-muted-foreground" />
              <div>
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Transformed</Trans></div>
                <div className="font-medium tabular-nums" style={{ color: transformedSize != null ? "oklch(0.55 0.16 145)" : "var(--muted-foreground)" }}>
                  {transformedLoading ? "…" : transformedSize != null ? fmtSize(transformedSize) : "—"}
                </div>
              </div>
              <div className="flex-1" />
              {transformedSize != null && (
                <Badge variant="outline" mono><Trans>{Math.round((1 - transformedSize / f.size) * 100)}% smaller</Trans></Badge>
              )}
            </div>
          )}
          </div>
        </>
      )}
      </div>

      {/* RIGHT — file info + metadata + actions */}
      <div className="flex min-w-0 flex-col gap-3 border-t border-border p-3.5 text-[12.5px] lg:border-l lg:border-t-0">
        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Key</Trans></span>
          <span className="break-all font-mono text-xs">{f.key}</span>
        </div>

        <div className="whitespace-pre-wrap break-words rounded-control bg-[oklch(from_var(--primary)_0.18_0.01_h)] p-2.5 font-mono text-[11px] leading-normal text-[oklch(from_var(--primary)_0.95_0.02_h)]">
          <span className="text-[oklch(0.78_0.18_95)]">GET</span> <span className="text-foreground">{url}</span>{params && <span className="text-muted-foreground">{params}</span>}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" icon={I.Code} onClick={() => onCopy(toAbsolute(effectiveSrc))}><Trans>Copy URL</Trans></Button>
          {f.acl === "private" && <Button size="sm" variant="outline" icon={I.Shield} onClick={onSignUrl}><Trans>Sign URL</Trans></Button>}
          <Button size="sm" variant="outline" icon={I.Download} onClick={onDownload}><Trans>Download</Trans></Button>
        </div>

        <div className="grid grid-cols-3 gap-2.5 border-t border-border pt-3">
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Size</Trans></div>
            <div className="font-medium tabular-nums">{fmtSize(f.size)}</div>
          </div>
          {isImage && f.w && (
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Dim</Trans></div>
              <div className="font-mono text-[11.5px] tabular-nums">{f.w}×{f.h}</div>
            </div>
          )}
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Updated</Trans></div>
            <div className="font-mono text-[11.5px]">{f.updated}</div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <div>
            <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
              {f.acl === "public" ? <I.Eye size={12} /> : <I.Shield size={12} />}
              {f.acl === "public" ? <Trans>Public</Trans> : <Trans>Private</Trans>}
            </div>
            <div className="text-[11.5px] text-muted-foreground">{f.acl === "public" ? <Trans>Anyone with the URL can fetch this file.</Trans> : <Trans>Requires a signed URL or auth cookie.</Trans>}</div>
          </div>
          <Switch checked={f.acl === "public"} onChange={onToggleACL} />
        </div>

        {/* Folder — DB-only move; key on disk is unchanged. */}
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
            <span className="flex items-center gap-1.5">
              <I.Folder size={12} /> <Trans>Folder</Trans>
            </span>
          </label>
          <FolderPicker
            folders={folders ?? []}
            value={f.folderId ?? null}
            onChange={(id) => moveToFolder(id)}
          />
          <span className="text-[11.5px] text-muted-foreground"><Trans>Logical grouping in the DB. The object's storage key doesn't change.</Trans></span>
        </div>

        {/* Metadata — free-form bag stored in files.metadata jsonb. */}
        <div className="flex flex-col gap-2.5 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <I.Hash size={13} />
            <span className="text-xs font-medium uppercase tracking-[0.06em]"><Trans>Metadata</Trans></span>
            <div className="flex-1" />
            {metaDirty && <Badge variant="outline" mono><Trans>unsaved</Trans></Badge>}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Name</Trans></label>
            <Input
              value={metaName}
              onChange={(e) => setMetaName(e.target.value)}
              placeholder={f.key.split("/").pop()}
            />
            <span className="text-[11.5px] text-muted-foreground"><Trans>Display label. The storage key stays <span className="font-mono">{f.key}</span>.</Trans></span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Description</Trans></label>
            <Textarea
              value={metaDescription}
              onChange={(e) => setMetaDescription(e.target.value)}
              placeholder={t`What this file is about…`}
              rows={3}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Tags</Trans></label>
            <div className="mb-1.5 flex flex-wrap gap-1">
              {metaTags.map((tag) => (
                <span key={tag} className="inline-flex h-7 items-center gap-1 rounded-control border border-border bg-card px-[11px] text-[12.5px] text-foreground">
                  <span className="font-mono">{tag}</span>
                  <ShadButton
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setMetaTags(metaTags.filter((t) => t !== tag))}
                    title={t`Remove tag`}
                    aria-label={t`Remove tag ${tag}`}
                    className="size-4 text-muted-foreground hover:text-foreground"
                  >
                    <I.X size={10} />
                  </ShadButton>
                </span>
              ))}
              {metaTags.length === 0 && <span className="text-[11.5px] text-muted-foreground"><Trans>No tags yet.</Trans></span>}
            </div>
            <Input
              value={metaTagDraft}
              onChange={(e) => setMetaTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commitTagDraft(); }
                if (e.key === "Backspace" && metaTagDraft === "" && metaTags.length > 0) {
                  setMetaTags(metaTags.slice(0, -1));
                }
              }}
              onBlur={commitTagDraft}
              placeholder={t`Add a tag and press Enter…`}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Author</Trans></label>
            <Input
              value={metaAuthor}
              onChange={(e) => setMetaAuthor(e.target.value)}
              placeholder={t`Photographer, designer, source…`}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Location</Trans></label>
            <Input
              value={metaLocation}
              onChange={(e) => setMetaLocation(e.target.value)}
              placeholder={t`Istanbul, Turkey`}
            />
          </div>

          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setMetaName(fileMeta.name ?? "");
                setMetaDescription(fileMeta.description ?? "");
                setMetaTags(fileMeta.tags ?? []);
                setMetaTagDraft("");
                setMetaAuthor(fileMeta.author ?? "");
                setMetaLocation(fileMeta.location ?? "");
              }}
              disabled={!metaDirty || metaSaving}
            >
              <Trans>Discard</Trans>
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={saveMeta}
              disabled={!metaDirty || metaSaving}
            >
              {metaSaving ? <Trans>Saving…</Trans> : <Trans>Save metadata</Trans>}
            </Button>
          </div>
        </div>
      </div>
      </div>
    </Wrapper>
  );
}


/**
 * Searchable folder picker — shadcn Popover + Command pattern. Filters the
 * local list as the user types (no remote call; folders are already loaded
 * for the sidebar). Selecting an item fires `onChange` and closes the
 * popover. Sentinel "" value means "no folder" (root).
 */
export function FolderPicker({ folders, value, onChange }: { folders: { id: string; name: string }[]; value: string | null; onChange: (id: string | null) => void }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const current = folders.find((f) => f.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ShadButton
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {current ? current.name : <Trans>— None (root) —</Trans>}
          </span>
          <ChevronsUpDownIcon className="ml-2 size-4 shrink-0 opacity-50" />
        </ShadButton>
      </PopoverTrigger>
      <PopoverContent
        // .dialog-backdrop sits at z-index: 70 (legacy admin.css). Popover's
        // default `z-50` would render the combobox content behind it — the
        // trigger looks broken because nothing visible happens on click. Pin
        // above the backdrop and any other modal scrim.
        className="z-[100] w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command>
          <CommandInput placeholder={t`Search folders…`} />
          <CommandList>
            <CommandEmpty><Trans>No folders match.</Trans></CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__root__ none root"
                onSelect={() => { onChange(null); setOpen(false); }}
              >
                <CheckIcon className={cn("mr-2 size-4", value == null ? "opacity-100" : "opacity-0")} />
                <span className="text-muted-foreground"><Trans>— None (root) —</Trans></span>
              </CommandItem>
              {folders.map((fl) => (
                <CommandItem
                  key={fl.id}
                  value={fl.name}
                  onSelect={() => { onChange(fl.id); setOpen(false); }}
                >
                  <CheckIcon className={cn("mr-2 size-4", value === fl.id ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{fl.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}


/**
 * Pagination footer for the grid + list views. Renders nothing when there
 * is just one page worth of results; otherwise shows "Showing X of Y" plus
 * a Load more button. Single-button is intentional — we paginate forward
 * only, infinite-scroll style.
 */
export function PaginationFooter({ loaded, total, loading, onLoadMore }: { loaded: number; total: number; loading: boolean; onLoadMore: () => void }) {
  const hasMore = loaded < total;
  if (total === 0) return null;
  if (!hasMore && !loading) return null;
  return (
    <div className="flex items-center justify-center gap-3 border-t border-border px-3.5 py-3 text-xs">
      <span className="tabular-nums text-muted-foreground"><Trans>Showing {loaded} of {total}</Trans></span>
      {hasMore && (
        <Button size="sm" variant="outline" onClick={onLoadMore} disabled={loading}>
          {loading ? <Skeleton className="h-3.5 w-16" /> : <Trans>Load more</Trans>}
        </Button>
      )}
    </div>
  );
}
