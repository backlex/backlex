// Shared color swatch picker — one row of preset circles plus a conic-rainbow
// "custom" circle backed by an invisible native color input. Used by the
// settings appearance card, the form-design panel, and collection settings so
// every color choice in the admin looks and behaves the same.
import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";

export type SwatchOption = {
  /** Persisted value — a token name, hex, CSS color function, or "" (default). */
  value: string;
  /** CSS color painted on the circle (may be `var(--primary)` etc.). */
  swatch: string;
  /** Tooltip label; falls back to the value. */
  label?: string;
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FALLBACK_HEX = "#8b6cff";

export function ColorSwatchPicker({
  options,
  value,
  onChange,
  allowCustom = true,
  showValue = false,
  disabled = false,
  className,
}: {
  options: SwatchOption[];
  value: string;
  onChange: (value: string) => void;
  /** Show the rainbow custom circle (native color input, hex only). */
  allowCustom?: boolean;
  /** Render the current value under the row in mono. */
  showValue?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useLingui();
  // Native color inputs fire continuously while dragging — keep the drag in a
  // local draft and debounce the commit so call sites don't get spammed with
  // one PATCH per pointer move.
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const shown = (draft ?? value).trim();
  const norm = (s: string) => s.trim().toLowerCase();
  const active = options.find((o) => norm(o.value) === norm(shown));
  const customActive = allowCustom && shown !== "" && !active;
  const currentCss = customActive ? shown : (active?.swatch ?? (shown || FALLBACK_HEX));

  const commitCustom = (hex: string) => {
    setDraft(hex);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setDraft(null);
      onChange(hex);
    }, 200);
  };

  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        {options.map((o) => {
          const selected = active === o;
          return (
            <button
              key={o.value || "__default"}
              type="button"
              title={o.label ?? o.value}
              aria-label={o.label ?? o.value}
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => {
                setDraft(null);
                window.clearTimeout(timer.current);
                onChange(o.value);
              }}
              className={`size-[26px] rounded-full border-2 transition-shadow ${disabled ? "cursor-default opacity-60" : "cursor-pointer"}`}
              style={{
                background: o.swatch,
                borderColor: selected ? "rgba(255,255,255,0.9)" : "transparent",
                boxShadow: selected ? `0 0 10px ${o.swatch}` : "none",
              }}
            />
          );
        })}
        {allowCustom && (
          <label
            title={t`Custom color`}
            className={`relative grid size-[26px] place-items-center overflow-hidden rounded-full ${disabled ? "cursor-default opacity-60" : "cursor-pointer"}`}
            style={{
              boxShadow: customActive
                ? `0 0 0 2px rgba(255,255,255,0.9), 0 0 10px ${currentCss}`
                : "none",
            }}
          >
            {/* blurred, over-scaled sweep hides the conic seam → seamless ring */}
            <span
              aria-hidden
              className="absolute inset-0 rounded-full"
              style={{
                background:
                  "conic-gradient(from 210deg, #ff6b6b, #ffc46e, #7CE6C0, #6CB8FF, #8B6CFF, #E85CA8, #ff6b6b)",
                filter: "blur(3px)",
                transform: "scale(1.45)",
              }}
            />
            <span
              className="relative size-3 rounded-full border-[1.5px] border-white/80"
              style={{ background: currentCss }}
            />
            <input
              type="color"
              disabled={disabled}
              value={HEX_RE.test(shown) ? shown : FALLBACK_HEX}
              onChange={(e) => commitCustom(e.target.value)}
              className="absolute inset-0 cursor-pointer border-0 p-0 opacity-0 disabled:cursor-default"
            />
          </label>
        )}
      </div>
      {showValue && shown !== "" && (
        <span className="-mt-0.5 font-mono text-[10.5px] text-muted-foreground">{shown}</span>
      )}
    </div>
  );
}
