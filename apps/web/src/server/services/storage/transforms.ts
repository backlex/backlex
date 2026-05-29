import { AppError, type ImageTransform } from "@backlex/core";

// Only the values that work on BOTH transform backends without semantic
// drift: CF Image Resizing supports {cover, contain, scale-down, crop,
// pad}; Bun.Image's `fit` is {fill, inside}. `cover` and `contain` are
// the universally meaningful subset — anything else either errors at
// the edge (CF 9401) or maps to a different operation on Bun.
export const FIT_VALUES = new Set(["cover", "contain"]);
export const FORMAT_VALUES = new Set(["webp", "jpeg", "png", "avif"]);

export interface ParsedTransform {
  transform: ImageTransform;
  focal?: { x: number; y: number };
  /** True when any transform-related query parameter was provided. */
  any: boolean;
}

/**
 * Validate the transform query string. Anything malformed throws VALIDATION
 * — silently dropping bad params would let `?width=abc` silently serve the
 * original at full quality, masking client bugs.
 */
export const parseTransform = (q: Record<string, string | undefined>): ParsedTransform => {
  const out: ImageTransform = {};
  let any = false;
  let focal: { x: number; y: number } | undefined;

  const intInRange = (raw: string, name: string, min: number, max: number): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
      throw new AppError("VALIDATION", `${name} must be an integer between ${min} and ${max}`);
    }
    return n;
  };

  if (q.width !== undefined) { out.width = intInRange(q.width, "width", 1, 4096); any = true; }
  if (q.height !== undefined) { out.height = intInRange(q.height, "height", 1, 4096); any = true; }
  if (q.quality !== undefined) { out.quality = intInRange(q.quality, "quality", 1, 100); any = true; }
  if (q.fit !== undefined) {
    if (!FIT_VALUES.has(q.fit)) {
      throw new AppError("VALIDATION", `fit must be one of: ${[...FIT_VALUES].join(", ")}`);
    }
    out.fit = q.fit as ImageTransform["fit"];
    any = true;
  }
  if (q.format !== undefined) {
    if (!FORMAT_VALUES.has(q.format)) {
      throw new AppError("VALIDATION", `format must be one of: ${[...FORMAT_VALUES].join(", ")}`);
    }
    out.format = q.format as ImageTransform["format"];
    any = true;
  }
  if (q.focal !== undefined) {
    const m = q.focal.match(/^(\d{1,3}),(\d{1,3})$/);
    if (!m) throw new AppError("VALIDATION", `focal must be "x,y" with values 0–100`);
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (x < 0 || x > 100 || y < 0 || y > 100) {
      throw new AppError("VALIDATION", `focal x,y must be 0–100`);
    }
    focal = { x, y };
    any = true;
  }
  return { transform: out, focal, any };
};

export const isImageContentType = (ct: string | null | undefined): boolean =>
  Boolean(ct && ct.startsWith("image/"));

/** Stable ETag derived from the physical key + transform query — different
 *  transforms get distinct cache entries automatically. */
export const computeEtag = async (physical: string, queryString: string): Promise<string> => {
  const data = new TextEncoder().encode(`${physical}::${queryString}`);
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 12; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return `W/"${hex}"`;
};

/** Serialize a transform back to the canonical query string so the ETag is
 *  stable regardless of param order. */
export const canonicalizeTransformQuery = (t: ImageTransform, focal?: { x: number; y: number }): string => {
  const parts: string[] = [];
  if (t.width !== undefined) parts.push(`width=${t.width}`);
  if (t.height !== undefined) parts.push(`height=${t.height}`);
  if (t.format !== undefined) parts.push(`format=${t.format}`);
  if (t.quality !== undefined) parts.push(`quality=${t.quality}`);
  if (t.fit !== undefined) parts.push(`fit=${t.fit}`);
  if (focal) parts.push(`focal=${focal.x},${focal.y}`);
  return parts.join("&");
};

export const TRANSFORM_CACHE_HEADERS: Record<string, string> = {
  // Transforms are content-addressed by query, so we can cache aggressively.
  "cache-control": "public, max-age=31536000, immutable",
};
