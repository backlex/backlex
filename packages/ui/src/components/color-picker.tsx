import * as React from "react"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@backlex/ui/components/popover"
import { cn } from "@backlex/ui/lib/utils"

interface ColorPickerProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  triggerSize?: number
}

interface Hsv {
  h: number
  s: number
  v: number
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n))

const hexToHsv = (hex: string): Hsv => {
  const m = hex.replace("#", "")
  if (m.length !== 6) return { h: 90, s: 0.7, v: 1 }
  const r = parseInt(m.slice(0, 2), 16) / 255
  const g = parseInt(m.slice(2, 4), 16) / 255
  const b = parseInt(m.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : d / max
  return { h, s, v: max }
}

const hsvToHex = ({ h, s, v }: Hsv): string => {
  const c = v * s
  const hh = h / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hh < 1) [r, g, b] = [c, x, 0]
  else if (hh < 2) [r, g, b] = [x, c, 0]
  else if (hh < 3) [r, g, b] = [0, c, x]
  else if (hh < 4) [r, g, b] = [0, x, c]
  else if (hh < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = v - c
  const to = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0")
  return `#${to(r)}${to(g)}${to(b)}`
}

/**
 * Lightweight HSV color picker rendered inside a shadcn Popover.
 * No external dependencies — pure CSS gradients + pointer drag handlers.
 * Emits hex (`#rrggbb`) on every move so the parent can live-preview.
 */
function ColorPicker({
  value,
  onChange,
  disabled,
  className,
  triggerSize = 28,
}: ColorPickerProps) {
  const initialHex = /^#[0-9a-fA-F]{6}$/.test(value.trim())
    ? value.trim()
    : "#84cc16"
  const [hsv, setHsv] = React.useState<Hsv>(() => hexToHsv(initialHex))

  React.useEffect(() => {
    if (/^#[0-9a-fA-F]{6}$/.test(value.trim())) {
      setHsv(hexToHsv(value.trim()))
    }
  }, [value])

  const update = (patch: Partial<Hsv>) => {
    const next = { ...hsv, ...patch }
    setHsv(next)
    onChange(hsvToHex(next))
  }

  const onAreaPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const apply = (clientX: number, clientY: number) => {
      const rect = target.getBoundingClientRect()
      const s = clamp((clientX - rect.left) / rect.width, 0, 1)
      const v = 1 - clamp((clientY - rect.top) / rect.height, 0, 1)
      update({ s, v })
    }
    apply(e.clientX, e.clientY)
    const move = (ev: PointerEvent) => apply(ev.clientX, ev.clientY)
    const up = () => {
      target.removeEventListener("pointermove", move)
      target.removeEventListener("pointerup", up)
      target.removeEventListener("pointercancel", up)
    }
    target.addEventListener("pointermove", move)
    target.addEventListener("pointerup", up)
    target.addEventListener("pointercancel", up)
  }

  const onHuePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const apply = (clientX: number) => {
      const rect = target.getBoundingClientRect()
      const h = clamp((clientX - rect.left) / rect.width, 0, 1) * 360
      update({ h })
    }
    apply(e.clientX)
    const move = (ev: PointerEvent) => apply(ev.clientX)
    const up = () => {
      target.removeEventListener("pointermove", move)
      target.removeEventListener("pointerup", up)
      target.removeEventListener("pointercancel", up)
    }
    target.addEventListener("pointermove", move)
    target.addEventListener("pointerup", up)
    target.addEventListener("pointercancel", up)
  }

  const hueColor = `hsl(${hsv.h} 100% 50%)`
  const swatchBg =
    value && /^(#|rgb|hsl|oklch|oklab|color)/i.test(value.trim())
      ? value
      : "var(--muted)"

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Pick color"
          className={cn(
            "rounded-md border border-input shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          style={{
            background: swatchBg,
            width: triggerSize,
            height: triggerSize,
          }}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto gap-3 rounded-2xl p-3">
        <div
          onPointerDown={onAreaPointer}
          className="relative h-40 w-56 cursor-crosshair touch-none overflow-hidden rounded-lg"
          style={{ background: hueColor }}
        >
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to right, #fff, transparent)",
            }}
          />
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to top, #000, transparent)",
            }}
          />
          <div
            className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
            style={{
              left: `${hsv.s * 100}%`,
              top: `${(1 - hsv.v) * 100}%`,
            }}
          />
        </div>
        <div
          onPointerDown={onHuePointer}
          className="relative h-3 w-56 cursor-pointer touch-none rounded-full"
          style={{
            background:
              "linear-gradient(to right, hsl(0 100% 50%), hsl(60 100% 50%), hsl(120 100% 50%), hsl(180 100% 50%), hsl(240 100% 50%), hsl(300 100% 50%), hsl(360 100% 50%))",
          }}
        >
          <div
            className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
            style={{ left: `${(hsv.h / 360) * 100}%`, background: hueColor }}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { ColorPicker }
