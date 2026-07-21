import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";

// The canonical Backlex docs live at the repo root in `/docs`, NOT in
// `apps/docs/src/content/docs/`. We point the loader at the repo-root folder
// so the markdown stays version-controlled in one place and the docs site
// only renders.
export const collections = {
  docs: defineCollection({
    loader: glob({ base: "../../docs", pattern: "**/*.md" }),
    schema: docsSchema(),
  }),
  // UI string overrides (e.g. search label → "Search docs"), matching the design.
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
