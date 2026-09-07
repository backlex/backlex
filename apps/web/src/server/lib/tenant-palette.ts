/**
 * The colours a workspace tile may be born with — ONE list, because there were
 * two and they disagreed.
 *
 * `routes/tenants.ts` (workspace create) already used theme tokens.
 * `services/seed.ts` (`ensureDefaultTenant`, the default workspace every
 * provisioned instance gets) used raw `oklch(…)` literals — the exact shape
 * `20260520190000_workspace_theme_colors` exists to REPLACE:
 *
 *   UPDATE tenants SET color = <random var(--…)>
 *   WHERE color IS NULL OR color NOT LIKE 'var(--%'
 *
 * So every newly provisioned default workspace was born holding a value that
 * migration is designed to overwrite, which makes its stated premise —
 * "pre-theme rows hold static oklch() literals", i.e. a historical population —
 * false. The population was being regenerated on every provision.
 *
 * Measured on the live D1s 2026-09-07 (backlex/backlex#329): four of five
 * tenant databases held `oklch(0.7 0.16 28)`, the seeder's value for the slug
 * `default`; only `playground` held a `var(--…)` token. The issue expected that
 * count to be zero and to close as contained-and-harmless. It was not zero —
 * but not for the reason the issue supposed, and nobody had set a custom brand
 * colour.
 *
 * A token rather than a literal is also the answer that survives a theme
 * change: `var(--chart-2)` follows the workspace's palette, an `oklch()` does
 * not.
 */
export const TENANT_TILE_PALETTE = [
  "var(--primary)",
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/**
 * A stable colour for a slug — the same workspace always gets the same tile.
 *
 * Used by the seeder, where a random pick would give the default workspace a
 * different colour on every fresh provision of the same instance. The create
 * path picks at random instead, deliberately: a person naming a new workspace
 * has no expectation about its colour, and two workspaces created in a row
 * looking different is the point.
 */
export const tenantColorFor = (slug: string): string =>
  TENANT_TILE_PALETTE[
    Math.abs([...slug].reduce((a, c) => a + c.charCodeAt(0), 0)) % TENANT_TILE_PALETTE.length
  ] as string;

/**
 * Would `20260520190000_workspace_theme_colors` overwrite this value?
 *
 * The predicate is the migration's own `WHERE`, restated so a test can ask the
 * question of anything that writes the column. Nothing this codebase writes
 * should answer `true`.
 */
export const wouldBeReseededByThemeMigration = (color: string | null | undefined): boolean =>
  color == null || !color.startsWith("var(--");
