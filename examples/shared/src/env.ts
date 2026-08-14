/**
 * The environment every example reads, described once.
 *
 * Each app used to carry its own byte-identical copy of this. Keeping it here
 * is not only about duplication: the setup check renders this list, so a
 * newcomer sees exactly which variable to set and why. Four copies meant four
 * chances for that explanation to drift from what the app actually reads.
 *
 * `import.meta.env.VITE_*` is statically replaced by Vite at build time in
 * every file it processes, including a source-consumed workspace package like
 * this one — so reading them here behaves exactly as it did in each app.
 */
export interface EnvSpec {
  key: string;
  required: boolean;
  value: string | undefined;
  example: string;
  description: string;
}

export const ENV: EnvSpec[] = [
  {
    key: "VITE_BACKLEX_WORKSPACE",
    required: true,
    value: import.meta.env.VITE_BACKLEX_WORKSPACE,
    example: "default",
    description:
      "Slug of the backlex workspace (tenant) end-users sign into. Create one in the admin UI → Workspaces.",
  },
  {
    key: "VITE_BACKLEX_URL",
    required: false,
    value: import.meta.env.VITE_BACKLEX_URL,
    example: "(empty in local dev) · https://api.your.app",
    description:
      "API origin. Leave empty to use the same-origin Vite dev proxy; set it for a cross-origin production build.",
  },
  {
    key: "VITE_BACKLEX_PROXY_TARGET",
    required: false,
    value: import.meta.env.VITE_BACKLEX_PROXY_TARGET,
    example: "http://localhost:5173",
    description:
      "Where the dev proxy forwards /api/* (used only when VITE_BACKLEX_URL is empty).",
  },
];

/** Required vars that are not set — an empty array means env is good to go. */
export const missingRequired = (): EnvSpec[] => ENV.filter((e) => e.required && !e.value);

/** The configured workspace slug (empty string when unset). */
export const WORKSPACE: string = import.meta.env.VITE_BACKLEX_WORKSPACE ?? "";

/** API origin — empty string means same-origin (dev proxy). */
export const API_URL: string = import.meta.env.VITE_BACKLEX_URL ?? "";
