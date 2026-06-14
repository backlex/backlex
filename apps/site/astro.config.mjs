import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  site: "https://backlex.com",
  // Emits /sitemap-index.xml + /sitemap-0.xml at build, auto-discovering every
  // page (including the /vs-* comparison pages). robots.txt points crawlers to
  // /sitemap-index.xml.
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
