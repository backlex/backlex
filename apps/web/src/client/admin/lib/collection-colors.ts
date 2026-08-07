/**
 * Preset accent colors for collections. Stored as a token name (`"violet"`)
 * so both themes resolve to a legible tone; a custom `#rrggbb` hex is allowed
 * as an escape hatch (the user owns its contrast). `resolveCollectionColor`
 * maps whatever the row stores to a usable CSS color.
 */
export const COLLECTION_COLORS: { token: string; hex: string }[] = [
  { token: "violet", hex: "#6C5CE7" },
  { token: "indigo", hex: "#4F46E5" },
  { token: "blue", hex: "#2563EB" },
  { token: "sky", hex: "#0284C7" },
  { token: "cyan", hex: "#0891B2" },
  { token: "teal", hex: "#0D9488" },
  { token: "green", hex: "#16A34A" },
  { token: "lime", hex: "#65A30D" },
  { token: "amber", hex: "#D97706" },
  { token: "orange", hex: "#EA580C" },
  { token: "rose", hex: "#E11D48" },
  { token: "pink", hex: "#DB2777" },
  { token: "fuchsia", hex: "#C026D3" },
  { token: "slate", hex: "#64748B" },
];

export const DEFAULT_COLLECTION_COLOR = "#6C5CE7";

const BY_TOKEN = new Map(COLLECTION_COLORS.map((c) => [c.token, c.hex]));

/** Token name or `#rrggbb` → CSS color. Null/unknown falls back to violet. */
export function resolveCollectionColor(color?: string | null): string {
  if (!color) return DEFAULT_COLLECTION_COLOR;
  if (color.startsWith("#")) return color;
  return BY_TOKEN.get(color) ?? DEFAULT_COLLECTION_COLOR;
}
