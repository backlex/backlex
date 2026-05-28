/**
 * @workeros/auth-ui — i18n-free, router-agnostic auth screens.
 *
 * The package ships the JSX + shadcn wiring for sign-in, sign-up, forgot,
 * reset-password, and magic-link. Consumers pass:
 *   - `copy` — already-translated strings (Lingui in OSS admin, plain in cloud)
 *   - `authClient` — better-auth-shaped client
 *   - `navigate` / `searchParam` / `Link` — router-agnostic wiring
 *   - `branding` — workspace logo + name (+ optional sign-in headline override)
 *   - `socialButtons` — render-prop slot for provider buttons
 *
 * No Lingui, no React Router, no `@/lib/*` imports — only `@workeros/ui`.
 *
 * Don't forget to import `@workeros/auth-ui/auth-shell.css` once at bootstrap
 * for the animated brand-panel beams.
 */

export type {
  AuthMode,
  AuthBranding,
  AuthResult,
  AuthClient,
  LinkComponent,
  Notifier,
  AuthWiring,
  AuthShellCopy,
  AuthSurfaceFlags,
} from "./types";

export {
  AuthShell,
  AuthCard,
  AuthCardHeader,
  AuthDivider,
  AuthCallout,
  AuthError,
  AuthFootLink,
  AuthSubmit,
  AuthOutline,
} from "./components/auth-shell";
export type { AuthShellProps } from "./components/auth-shell";

export { SignInPage } from "./pages/sign-in";
export type { SignInCopy, SignInPageProps } from "./pages/sign-in";

export { SignUpPage } from "./pages/sign-up";
export type { SignUpCopy, SignUpPageProps } from "./pages/sign-up";

export { ForgotPage } from "./pages/forgot";
export type { ForgotCopy, ForgotPageProps } from "./pages/forgot";

export { ResetPasswordPage } from "./pages/reset-password";
export type {
  ResetPasswordCopy,
  ResetPasswordPageProps,
} from "./pages/reset-password";

export { MagicLinkPage } from "./pages/magic-link";
export type { MagicLinkCopy, MagicLinkPageProps } from "./pages/magic-link";
