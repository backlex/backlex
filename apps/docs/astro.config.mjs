import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: "Workeros",
      description: "Self-hostable Supabase/Directus alternative — admin, API, runtime.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/workeros/workeros",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/workeros/workeros/edit/main/",
      },
      sidebar: [
        {
          label: "Start",
          items: [
            { slug: "getting-started" },
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
            { slug: "storage" },
            { slug: "realtime" },
            { slug: "advisor" },
          ],
        },
        {
          label: "Auth",
          items: [
            { slug: "sso" },
          ],
        },
        {
          label: "Developer",
          items: [
            { slug: "graphql" },
            { slug: "functions" },
            { slug: "sdk-and-cli" },
            { slug: "admin-i18n" },
            { slug: "locale-timezone" },
          ],
        },
        {
          label: "Internals",
          items: [
            { slug: "design" },
          ],
        },
      ],
    }),
  ],
});
