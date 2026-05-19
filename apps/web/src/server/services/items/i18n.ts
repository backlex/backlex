import { AppError } from "@workeros/core";
import type { FieldDef } from "@workeros/db";

/**
 * Project i18n_text fields down to a single locale's string for response.
 * When `locale === "*"` (or null) the full `{en, tr, …}` map is returned
 * unchanged — useful for admin UIs that want to render every locale.
 *
 * Fallback chain: requested locale → workspace default → first non-empty
 * map entry. The third step is deterministic only because map keys are
 * iterated in insertion order, but it's strictly a last-resort.
 */
export const localizeRow = (
  row: Record<string, unknown>,
  fields: FieldDef[],
  locale: string | null,
  defaultLocale: string | null,
): Record<string, unknown> => {
  if (!locale || locale === "*") return row;
  for (const f of fields) {
    if (f.type !== "i18n_text") continue;
    const v = row[f.name];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const map = v as Record<string, unknown>;
      const picked =
        map[locale] ??
        (defaultLocale ? map[defaultLocale] : undefined) ??
        Object.values(map)[0] ??
        null;
      row[f.name] = picked;
    }
  }
  return row;
};

/**
 * Merge incoming i18n_text patch values into the existing JSON map so a
 * client that writes only one locale doesn't blow away the others.
 *
 * - Patch is a plain object → spread into existing (per-locale upsert).
 * - Patch is a string AND `?locale=xx` query is set → treat as `{xx: value}`
 *   and merge into existing. The handler converts the patch in-place.
 * - Patch is `null` → clears the field entirely (caller's choice).
 * - Anything else throws — strings without a locale param aren't a valid
 *   shape for a JSON column.
 */
export const mergeI18nPatch = (
  patch: Record<string, unknown>,
  existing: Record<string, unknown>,
  fields: FieldDef[],
  writeLocale: string | null,
): void => {
  for (const f of fields) {
    if (f.type !== "i18n_text") continue;
    if (!(f.name in patch)) continue;
    const incoming = patch[f.name];
    if (incoming === null) continue;

    const current = existing[f.name];
    const base =
      current && typeof current === "object" && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {};

    if (typeof incoming === "string") {
      if (!writeLocale || writeLocale === "*") {
        throw new AppError(
          "VALIDATION",
          `Field "${f.name}" is i18n_text — send {locale: value} or use ?locale=xx`,
        );
      }
      base[writeLocale] = incoming;
      patch[f.name] = base;
      continue;
    }

    if (typeof incoming === "object" && !Array.isArray(incoming)) {
      patch[f.name] = { ...base, ...(incoming as Record<string, unknown>) };
      continue;
    }

    throw new AppError(
      "VALIDATION",
      `Field "${f.name}" must be an object or string for i18n_text`,
    );
  }
};
