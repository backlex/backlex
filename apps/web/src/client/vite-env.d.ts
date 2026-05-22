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
