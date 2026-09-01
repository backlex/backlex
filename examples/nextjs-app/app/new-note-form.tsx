"use client";

import { useActionState, useEffect, useRef } from "react";
import { type ActionState, createNoteAction } from "./actions";
import { inputCls, primaryBtnCls } from "./ui";

const initialState: ActionState = {};

/**
 * A Client Component purely so the input can clear itself after a successful
 * submit — the create itself still runs entirely on the server. `useActionState`
 * gives us the pending flag; the page's data comes from `revalidatePath`, not
 * from anything held here.
 */
export function NewNoteForm() {
  const [state, formAction, pending] = useActionState(createNoteAction, initialState);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!pending && !state.error) ref.current?.reset();
  }, [pending, state.error]);

  return (
    <div className="space-y-2">
      <form ref={ref} action={formAction} className="flex gap-2">
        <input className={inputCls} name="title" placeholder="What needs doing?" />
        <button type="submit" className={primaryBtnCls} disabled={pending}>
          {pending ? "…" : "Add"}
        </button>
      </form>
      {state.error && <p className="text-sm text-bad">{state.error}</p>}
    </div>
  );
}
