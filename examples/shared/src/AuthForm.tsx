import { type FormEvent, type ReactNode, useState } from "react";
import { BacklexError, type BacklexClient } from "backlex";
import { Button, Field, inputCls } from "./ui";

/** The signed-in end user, as every example renders them. */
export interface ExampleUser {
  id: string;
  email: string;
  name?: string | null;
}

/**
 * Sign in or sign up against a workspace's own auth surface.
 *
 * There is no `persistToken()` call here, and that is the point of the whole
 * file existing once instead of four times: the client is created with
 * `persist: true`, so `core.setToken` writes the session through on every
 * capture path there is. The four copies of this form each remembered to call
 * a persist helper after sign-in; remembering it after sign-OUT is the half
 * that gets forgotten, and the symptom is a session that comes back after the
 * user ends it.
 */
export function AuthForm({
  client,
  onAuthed,
}: {
  client: BacklexClient;
  onAuthed?: (user: ExampleUser) => void;
}) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === "sign-up"
          ? await client.auth.signUp({ email, password, name })
          : await client.auth.signIn({ email, password });
      // The session is already stored and already published to every
      // `useSession()` on the page — this callback is only for an app that
      // wants the user object directly.
      onAuthed?.(res.user as ExampleUser);
    } catch (err) {
      setError(err instanceof BacklexError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Centered>
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-surface border border-line bg-panel p-6"
      >
        <h1 className="text-lg font-semibold tracking-tight">
          {mode === "sign-up" ? "Create account" : "Sign in"}
        </h1>
        {mode === "sign-up" && (
          <Field label="Name">
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
            />
          </Field>
        )}
        <Field label="Email">
          <input
            className={inputCls}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Password">
          <input
            className={inputCls}
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
        <Button type="submit" variant="primary" disabled={busy} className="w-full py-2">
          {busy ? (mode === "sign-up" ? "Creating account…" : "Signing in…") : mode === "sign-up" ? "Sign up" : "Sign in"}
        </Button>
        <button
          type="button"
          className="w-full text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
          onClick={() => {
            setMode(mode === "sign-up" ? "sign-in" : "sign-up");
            setError(null);
          }}
        >
          {mode === "sign-up" ? "I already have an account" : "Create an account"}
        </button>
      </form>
    </Centered>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center bg-surface p-6 text-ink">{children}</div>;
}
