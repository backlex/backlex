# @backlex/auth-ui

workeros auth screens — i18n-free, router-agnostic React components for sign-in / sign-up / forgot / reset-password / magic-link. Built on `@backlex/ui` (shadcn / Tailwind v4). Source-consumed; no build step.

## Install

```bash
bun add @backlex/auth-ui @backlex/ui
# or
npm i @backlex/auth-ui @backlex/ui
```

Peer deps: `react@^19`, `react-dom@^19`, and `@backlex/ui` ≥ 0.1.0.

## Usage

Each page expects:

- `copy` — already-translated strings (so the package stays Lingui-free)
- `authClient` — a [better-auth](https://better-auth.com)-shaped client (`signIn.email`, `signUp.email`, `forgetPassword`, …)
- `navigate(to, opts?)` / `searchParam(key)` — your router's primitives
- `Link` — a router-agnostic `<Link to=… />` component
- `branding` — `{ name, logoUrl?, signInHeadline?, signInTagline? }`
- `socialButtons` — render-prop slot for provider buttons (the consumer owns the surface API)

```tsx
import "@backlex/ui/globals.css";
import "@backlex/auth-ui/auth-shell.css";
import { SignInPage } from "@backlex/auth-ui";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

export const SignIn = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  return (
    <SignInPage
      authClient={auth}
      navigate={(to, opts) => navigate(to, opts)}
      searchParam={(k) => params.get(k)}
      Link={({ to, ...rest }) => <Link to={to} {...rest} />}
      branding={{ name: "acme", logoUrl: "/logo.svg" }}
      shellCopy={{
        headline: <>Sign in to <em>acme</em>.</>,
        lede: "Welcome back.",
        signInLabel: "Sign in",
        signUpLabel: "Sign up",
        magicLinkLabel: "Magic link",
        claimInstanceLabel: "Claim instance",
        toggleTheme: "Toggle theme",
      }}
      copy={{
        title: "Welcome back",
        description: "Sign in with your email and password.",
        orWithEmail: "or with email",
        missingFields: "Enter your email and password.",
        signInFailed: "Sign-in failed",
        emailLabel: "Email",
        emailPlaceholder: "you@example.com",
        passwordLabel: "Password",
        showPassword: "Show password",
        hidePassword: "Hide password",
        forgot: "Forgot?",
        submit: "Sign in",
        submitBusy: "Signing in…",
        magicLinkCta: "Send a magic link instead",
        passkeyCta: "Sign in with passkey",
        passkeyBusy: "Signing in…",
        passkeyNotEnabled: "Passkey plugin not enabled",
        passkeyFailed: "Passkey sign-in failed",
        footPrefix: "Don't have an account?",
        footLabel: "Sign up",
      }}
    />
  );
};
```

## Subpath exports

| Export | Purpose |
|---|---|
| `@backlex/auth-ui` | Barrel — re-exports every page + shell component |
| `@backlex/auth-ui/auth-shell.css` | Animated brand-panel beams (import once at bootstrap) |
| `@backlex/auth-ui/pages/*` | `sign-in`, `sign-up`, `forgot`, `reset-password`, `magic-link` |
| `@backlex/auth-ui/components/auth-shell` | `AuthShell`, `AuthCard`, `AuthCardHeader`, `AuthDivider`, … |

## Conventions

- The package is **i18n-free** — pass already-translated strings via `copy`. The OSS workeros admin wraps each call site in `useLingui()` to translate at render time; cloud / external consumers can pass plain literals.
- The package is **router-free** — `navigate` and `Link` are injected. Use `react-router-dom`, Next.js, TanStack Router, or roll your own.
- The package is **branding-aware** — pass `branding={{ name, logoUrl, signInHeadline?, signInTagline? }}`; the shell renders an initial-letter chip when no logo is set.
- The visual structure (Tailwind classes, layout, animations) is identical across consumers — the same auth screen renders in OSS and cloud.

## License

MIT — part of the [workeros](https://github.com/furkankinyas/workeros) project.
