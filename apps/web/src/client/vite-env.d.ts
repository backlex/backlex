/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Lingui `.po` catalogs are compiled to a message object by `@lingui/vite-plugin`.
declare module "*.po" {
  export const messages: Record<string, string>;
}

// Build-time version metadata injected by Vite `define` (see vite.config.ts).
declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;
declare const __BUILD_DATE__: string;
declare const __WRANGLER_VERSION__: string;
