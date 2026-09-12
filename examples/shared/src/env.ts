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
  {
    key: "VITE_DEMO_EMAIL",
    required: false,
    value: import.meta.env.VITE_DEMO_EMAIL,
    example: "(empty) · demo@example.com",
    description:
      "Local convenience: set this AND VITE_DEMO_PASSWORD and the sign-in form opens already filled in, so trying the demo costs one click instead of retyping credentials you published yourself.",
  },
  {
    key: "VITE_DEMO_PASSWORD",
    required: false,
    value: import.meta.env.VITE_DEMO_PASSWORD,
    example: "(empty) · the demo account's own password",
    description:
      "The password half of the pre-fill above. Both must be set or neither applies — a half-filled form that fails to submit is worse than an empty one.",
  },
];

/** Required vars that are not set — an empty array means env is good to go. */
export const missingRequired = (): EnvSpec[] => ENV.filter((e) => e.required && !e.value);

/** The configured workspace slug (empty string when unset). */
export const WORKSPACE: string = import.meta.env.VITE_BACKLEX_WORKSPACE ?? "";

/** API origin — empty string means same-origin (dev proxy). */
export const API_URL: string = import.meta.env.VITE_BACKLEX_URL ?? "";

/**
 * Credentials the sign-in form opens pre-filled with — `null` unless BOTH
 * vars are set.
 *
 * This is the example-sized version of what the product itself does in demo
 * mode (`docs/demo-mode.md`), and it is deliberately the weaker version. There
 * the SERVER decides: `DEMO_MODE=1` makes `GET /api/auth/providers` publish the
 * shared playground credentials, and the sign-in screen offers one-click entry
 * only because the backend said so. An example has no backend of its own to
 * ask, so the decision moves into its `.env` — which is why the gate is "both
 * vars are set" and not a build-mode check. Unset is the default, so a build
 * that did not ask for this carries no credential at all.
 *
 * Do not copy this into an app that is not a demo. The reason the product keeps
 * the same switch on the SERVER is that only the server knows whether an
 * instance is a playground or somebody's real data.
 */
export const DEMO: { email: string; password: string } | null =
  import.meta.env.VITE_DEMO_EMAIL && import.meta.env.VITE_DEMO_PASSWORD
    ? {
        email: import.meta.env.VITE_DEMO_EMAIL,
        password: import.meta.env.VITE_DEMO_PASSWORD,
      }
    : null;
