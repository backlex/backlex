import { type FormEvent, type ReactNode, useState } from "react";
import { BacklexError, type BacklexClient } from "backlex";

/** The signed-in end user, as every example renders them. */
export interface ExampleUser {
  id: string;
  email: string;
  name?: string | null;
}

const inputCls =
  "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900";
const primaryBtnCls =
  "w-full rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50";

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
        className="w-full max-w-sm space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold">
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
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={busy} className={primaryBtnCls}>
          {busy ? "…" : mode === "sign-up" ? "Sign up" : "Sign in"}
        </button>
        <button
          type="button"
          className="w-full text-sm text-neutral-500 underline"
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
  return (
    <div className="flex min-h-dvh items-center justify-center bg-neutral-50 p-6 text-neutral-900">
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-neutral-700">{label}</span>
      {children}
    </label>
  );
}
