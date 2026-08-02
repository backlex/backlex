import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";
import rehypeTableWrapper from "./src/plugins/rehype-table-wrapper.mjs";

// https://astro.build/config
export default defineConfig({
  site: "https://backlex.com",
  base: "/docs",
  markdown: {
    rehypePlugins: [rehypeTableWrapper],
  },
  integrations: [
    starlight({
      title: "Backlex",
      description: "Self-hostable Supabase/Directus alternative — admin, API, runtime.",
      // Emits /docs/llms.txt (curated index) + /docs/llms-full.txt (all docs as
      // one markdown file) so coding agents / LLMs can ingest the docs cleanly.
      plugins: [
        starlightLlmsTxt({
          projectName: "backlex",
          description:
            "Open-source (Apache-2.0), edge-native backend platform and self-hostable alternative to Supabase, Firebase, and Directus. Dynamic schema over PostgreSQL or SQLite/D1, a permissions DSL, REST + GraphQL, realtime, edge functions, vector search, and a built-in MCP server for AI agents — running on Cloudflare Workers, Vercel, Netlify, or your own server.",
        }),
      ],
      favicon: "/favicon.svg",
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        alt: "Backlex",
      },
      customCss: ["./src/styles/custom.css"],
      components: {
        PageTitle: "./src/components/PageTitle.astro",
        // Cosmic brand mark (orbiting planet) replacing the static logo.
        SiteTitle: "./src/components/SiteTitle.astro",
        // Design nav layout: planet + search box + "GitHub ↗".
        Header: "./src/components/Header.astro",
        // Override Head to inject Astro's ClientRouter — Starlight has no
        // built-in view transitions, so this adds smooth cross-page morphs.
        Head: "./src/components/Head.astro",
        // Override Search to re-init Pagefind after view-transition navigations.
        // Starlight only mounts PagefindUI on DOMContentLoaded, which never
        // re-fires under <ClientRouter />, so search opened empty after any
        // client-side navigation. See Search.astro for the full rationale.
        Search: "./src/components/Search.astro",
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
            href: "https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;500;600;700&family=Manrope:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
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
            { slug: "templates" },
            { slug: "querying" },
            { slug: "permissions" },
            { slug: "hashed-fields" },
            { slug: "field-conditions" },
            { slug: "field-validation" },
            { slug: "adopting-tables" },
            { slug: "migrating-in" },
            { slug: "schema-versions" },
            { slug: "database-providers" },
            { slug: "sqlite-providers" },
            { slug: "vector-search" },
            { slug: "full-text-search" },
            { slug: "ask-ai" },
            { slug: "ai-providers" },
          ],
        },
        {
          label: "Runtime",
          items: [
            { slug: "deployment" },
            { slug: "testing" },
            { slug: "storage" },
            { slug: "resumable-uploads" },
            { slug: "draft-publish" },
            { slug: "realtime" },
            { slug: "reactive-queries" },
            { slug: "offline-sync" },
            { slug: "push-messaging" },
            { slug: "sms-messaging" },
            { slug: "jobs" },
            { slug: "flows" },
            { slug: "payments" },
            { slug: "documents" },
            { slug: "e-signature" },
            { slug: "approvals" },
            { slug: "booking" },
            { slug: "agents" },
            { slug: "feature-flags" },
            { slug: "embedded-dashboards" },
            { slug: "reports" },
            { slug: "forms" },
            { slug: "backup-restore" },
            { slug: "advisor" },
            { slug: "tracing" },
            { slug: "usage-metering" },
            { slug: "product-analytics" },
            { slug: "audit-logs" },
            { slug: "erasure" },
            { slug: "demo-mode" },
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
            { slug: "webhooks" },
            { slug: "sync-hooks" },
            { slug: "integrations" },
            { slug: "sandbox" },
            { slug: "extensions" },
            { slug: "sdk-and-cli" },
            { slug: "client-sdks" },
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
            { slug: "performance" },
          ],
        },
      ],
    }),
  ],
});
