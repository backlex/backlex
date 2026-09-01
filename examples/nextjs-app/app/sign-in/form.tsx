"use client";

import { useActionState, useState } from "react";
import { type ActionState, signInAction } from "../actions";
import { Centered, ErrorLine, Field, inputCls, primaryBtnCls } from "../ui";

const initialState: ActionState = {};

/**
 * The only Client Component in the app, and it holds no data — just the
 * sign-in/sign-up toggle. `useActionState` wires the form straight to a Server
 * Action, so the credentials post to the server and the resulting session token
 * is written to an httpOnly cookie there. No token ever touches client state.
 */
export function SignInForm() {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [state, formAction, pending] = useActionState(signInAction, initialState);

  return (
    <Centered>
      <form
        action={formAction}
        className="w-full max-w-sm space-y-4 rounded-surface border border-line bg-panel p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold">
          {mode === "sign-up" ? "Create account" : "Sign in"}
        </h1>
        <input type="hidden" name="mode" value={mode} />

        {mode === "sign-up" && (
          <Field label="Name">
            <input className={inputCls} name="name" placeholder="Ada Lovelace" />
          </Field>
        )}
        <Field label="Email">
          <input
            className={inputCls}
            name="email"
            type="email"
            required
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Password">
          <input
            className={inputCls}
            name="password"
            type="password"
            required
            minLength={8}
            placeholder="••••••••"
          />
        </Field>

        {state.error && <ErrorLine msg={state.error} />}

        <button type="submit" className={primaryBtnCls + " w-full"} disabled={pending}>
          {pending ? "…" : mode === "sign-up" ? "Sign up" : "Sign in"}
        </button>
        <button
          type="button"
          className="w-full text-center text-sm text-ink-muted hover:text-ink"
          onClick={() => setMode(mode === "sign-up" ? "sign-in" : "sign-up")}
        >
          {mode === "sign-up"
            ? "Already have an account? Sign in"
            : "Need an account? Sign up"}
        </button>
      </form>
    </Centered>
  );
}
