import { z } from "@hono/zod-openapi";
import { ACCENT_PATTERN } from "@backlex/core/appearance";

/**
 * The request/response shape of a template's appearance — the settings a form
 * stores, validated with the same vocabulary `@backlex/core/appearance`
 * renders from. One schema for email and document templates so a value one
 * accepts cannot be refused by the other.
 */
export const AppearanceSchema = z
  .object({
    theme: z.enum(["light", "dark"]).optional(),
    accent: z.string().regex(ACCENT_PATTERN, "#rrggbb").optional(),
    font: z.enum(["sans", "lexend", "mono", "system"]).optional(),
    shell: z.boolean().optional(),
  })
  .openapi("TemplateAppearance", {
    description:
      "Theme, accent and font. A fragment body is rendered inside a document built from these; set `shell: false` to send the bare fragment instead, and a body that already starts with `<html>` is never wrapped. The same values also reach the body as `{{ theme.mode }}`, `{{ theme.accent }}`, `{{ theme.accentInk }}`, `{{ theme.bg }}`, `{{ theme.card }}`, `{{ theme.text }}`, `{{ theme.muted }}`, `{{ theme.faint }}`, `{{ theme.border }}`, `{{ theme.font }}` and `{{ theme.fontsHref }}`. Null clears it; an unset template renders against the light defaults.",
  });
