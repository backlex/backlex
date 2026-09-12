/**
 * Sign-in pre-fill for `bun run dev`, and for nothing else.
 *
 * Typing the local admin's credentials into the sign-in form is the single most
 * repeated action in local development, and the credentials are already public
 * — `apps/web/.dev.vars.example` and CLAUDE.md both publish them. So the value
 * of hiding them is zero and the cost of retyping them is paid every session.
 *
 * Two independent guards keep this out of production, and they are independent
 * on purpose — either one alone would do, and neither is trusted alone:
 *
 *  1. `import.meta.env.DEV` is replaced with the literal `false` by Vite in
 *     every build, so the whole expression folds to `null` and the strings are
 *     dropped by the minifier. Not hidden — absent.
 *  2. The values come from `.env.development.local`, which Vite loads ONLY in
 *     `development` mode, and which is gitignored. A clone of this repo has no
 *     such file, so a developer who does not opt in gets the empty form.
 *
 * This is deliberately NOT the playground affordance. Demo mode publishes its
 * credentials from the SERVER (`surface.demo` → the "Enter the playground"
 * button, see docs/demo-mode.md) because only a server knows whether an
 * instance is a shared playground or somebody's real data. A client constant
 * cannot know that, which is why this one refuses to exist outside dev.
 *
 * Opt in with `apps/web/.env.development.local` — copy
 * `.env.development.local.example`.
 */
export const DEV_SIGN_IN: { email: string; password: string } | null =
  import.meta.env.DEV &&
  import.meta.env.VITE_DEV_EMAIL &&
  import.meta.env.VITE_DEV_PASSWORD
    ? {
        email: import.meta.env.VITE_DEV_EMAIL,
        password: import.meta.env.VITE_DEV_PASSWORD,
      }
    : null;
