// Declarative spec of the env vars this example reads. The in-app setup check
// (SetupCheck.tsx) renders this so a newcomer sees exactly what to set and why,
// instead of a cryptic crash. Keep this list in sync with .env.example.
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

/** Required vars that are not set — empty array means env is good to go. */
export const missingRequired = (): EnvSpec[] => ENV.filter((e) => e.required && !e.value);

/** The configured workspace slug (empty string when unset). */
export const WORKSPACE: string = import.meta.env.VITE_BACKLEX_WORKSPACE ?? "";

/** API origin — empty string means same-origin (dev proxy). */
export const API_URL: string = import.meta.env.VITE_BACKLEX_URL ?? "";
