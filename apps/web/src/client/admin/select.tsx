// @ts-nocheck
// Shadcn-style Select with keyboard nav, portaled popover.
import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { I, type IconComponent } from "./icons";
import { Badge } from "./ui";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  badge?: ReactNode;
  icon?: IconComponent | ReactNode;
}

export type SelectOptions = (string | SelectOption)[];

export interface SelectProps {
  value: string | undefined;
  onChange: (v: string) => void;
  options: SelectOptions;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  size?: "sm" | "md";
  disabled?: boolean;
  searchable?: "auto" | true | false;
  searchPlaceholder?: string;
  defaultValue?: string;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  className = "",
  style,
  size = "md",
  disabled,
  searchable = "auto",
  searchPlaceholder = "Search…",
}: SelectProps) {
  const norm: SelectOption[] = (options || []).map((o) =>
    typeof o === "object" ? (o as SelectOption) : { value: String(o), label: String(o) },
  );
  const current = norm.find((o) => o.value === value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, norm.findIndex((o) => o.value === value)));
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0, dir: "down" as "up" | "down" });
  const [q, setQ] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const showSearch = searchable === true || (searchable === "auto" && norm.length >= 6);
  const filtered = q
    ? norm.filter((o) => (o.label + " " + (o.hint || "")).toLowerCase().includes(q.toLowerCase()))
    : norm;

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const popHeight = Math.min(280, filtered.length * 32 + 12 + (showSearch ? 40 : 0));
    const dir = below < popHeight + 12 && r.top > popHeight + 12 ? "up" : "down";
    setPos({
      top: dir === "down" ? r.bottom + 6 : r.top - popHeight - 6,
      left: r.left,
      width: r.width,
      dir,
    });
    setActive(Math.max(0, filtered.findIndex((o) => o.value === value)));
    if (showSearch) setTimeout(() => searchRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
      setQ("");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setQ("");
        triggerRef.current?.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (filtered.length) setActive((a) => (a + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (filtered.length) setActive((a) => (a - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const sel = filtered[active];
        if (sel) {
          onChange(sel.value);
          setOpen(false);
          setQ("");
          triggerRef.current?.focus();
        }
      } else if (e.key === "Home") {
        e.preventDefault();
        setActive(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setActive(filtered.length - 1);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, active, filtered, onChange]);

  const triggerClass = `sn-select-trigger ${size === "sm" ? "sn-sm" : ""} ${className}`.trim();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        style={style}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="sn-select-value">
          {current
            ? current.icon
              ? (
                <span className="sn-select-ic">
                  {typeof current.icon === "function" ? createElement(current.icon as IconComponent, { size: 13 }) : current.icon}
                </span>
              )
              : null
            : null}
          {current ? <span>{current.label}</span> : <span className="sn-select-placeholder">{placeholder}</span>}
        </span>
        <I.ChevronDown size={13} className="sn-select-chevron" />
      </button>
      {open && createPortal(
        <div ref={popRef} className="sn-select-pop" style={{ top: pos.top, left: pos.left, minWidth: pos.width }} role="listbox">
          {showSearch && (
            <div className="sn-select-search">
              <I.Search size={12} />
              <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} />
            </div>
          )}
          <div className="sn-select-list">
            {filtered.length === 0 && <div className="sn-select-empty">No results</div>}
            {filtered.map((o, i) => (
              <div
                key={String(o.value)}
                role="option"
                aria-selected={o.value === value}
                data-active={i === active}
                className="sn-select-item"
                onMouseEnter={() => setActive(i)}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                  setQ("");
                  triggerRef.current?.focus();
                }}
              >
                <span className="sn-select-check">
                  {o.value === value ? <I.Check size={12} /> : null}
                </span>
                <span className="sn-select-item-label">
                  {o.icon && (
                    <span className="sn-select-ic">
                      {typeof o.icon === "function" ? createElement(o.icon as IconComponent, { size: 13 }) : o.icon}
                    </span>
                  )}
                  <span>{o.label}</span>
                  {o.hint && <span className="sn-select-hint font-mono">{o.hint}</span>}
                </span>
                {o.badge && <Badge variant="outline" mono>{o.badge}</Badge>}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
