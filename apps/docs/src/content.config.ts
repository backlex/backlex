import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// The canonical backlex docs live at the repo root in `/docs`, NOT in
// `apps/docs/src/content/docs/`. We point the loader at the repo-root folder
// so the markdown stays version-controlled in one place and the docs site
// only renders.
export const collections = {
  docs: defineCollection({
    loader: glob({ base: "../../docs", pattern: "**/*.md" }),
    schema: docsSchema(),
  }),
};
