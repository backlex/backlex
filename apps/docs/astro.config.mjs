import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  site: "https://backlex.com",
  base: "/docs",
  integrations: [
    starlight({
      title: "Backlex",
      description: "Self-hostable Supabase/Directus alternative — admin, API, runtime.",
      favicon: "/favicon.svg",
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        alt: "Backlex",
      },
      customCss: ["./src/styles/custom.css"],
      components: {
        PageTitle: "./src/components/PageTitle.astro",
      },
      head: [
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" },
        },
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.gstatic.com",
            crossorigin: true,
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap",
          },
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/backlex/backlex",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/backlex/backlex/edit/main/",
      },
      sidebar: [
        {
          label: "Start",
          items: [
            { label: "Getting started", link: "/" },
            { slug: "architecture" },
          ],
        },
        {
          label: "Data",
          items: [
            { slug: "querying" },
            { slug: "permissions" },
            { slug: "adopting-tables" },
          ],
        },
        {
          label: "Runtime",
          items: [
            { slug: "deployment" },
            { slug: "testing" },
            { slug: "storage" },
            { slug: "realtime" },
            { slug: "advisor" },
          ],
        },
        {
          label: "Auth",
          items: [
            { slug: "auth-planes" },
            { slug: "sso" },
            { slug: "api-keys-and-email" },
          ],
        },
        {
          label: "Developer",
          items: [
            { slug: "graphql" },
            { slug: "sandbox" },
            { slug: "sdk-and-cli" },
            { slug: "mcp" },
            { slug: "admin-i18n" },
            { slug: "locale-timezone" },
          ],
        },
        {
          label: "Internals",
          items: [
            { slug: "design" },
            { slug: "service-map" },
          ],
        },
      ],
    }),
  ],
});
