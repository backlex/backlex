import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  site: "https://backlex.com",
  // No-trailing-slash canonical URLs site-wide (/pricing, /vs-supabase, …).
  // `format: "file"` emits `pricing.html` instead of `pricing/index.html`, so
  // Cloudflare's default `auto-trailing-slash` serves the no-slash path with a
  // 200 and 307-redirects the slashed variant to it. `trailingSlash: "never"`
  // keeps the sitemap URLs and the canonical <link> (Astro.url) slash-free to
  // match. The Starlight docs are a separate build overlaid at /docs and keep
  // their own directory-format, trailing-slash convention.
  trailingSlash: "never",
  build: { format: "file" },
  // Emits /sitemap-index.xml + /sitemap-0.xml at build, auto-discovering every
  // page (including the /vs-* comparison pages). robots.txt points crawlers to
  // /sitemap-index.xml.
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
