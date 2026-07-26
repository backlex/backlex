"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { anonymousClient, backlexForRequest, errorMessage, type Note } from "@/lib/backlex";
import { clearSessionToken, writeSessionToken } from "@/lib/session";

export type ActionState = { error?: string };

/**
 * Sign in (or up) and persist the returned workspace session token as an
 * httpOnly cookie.
 *
 * This is the piece the client-rendered examples can't do: `signIn` hands back a
 * token, and here it goes somewhere the browser will replay on every navigation
 * but page scripts can never read.
 */
export async function signInAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const mode = String(formData.get("mode") ?? "sign-in");
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Email and password are required." };

  try {
    const backlex = anonymousClient();
    const res =
      mode === "sign-up"
        ? await backlex.auth.signUp({
            email,
            password,
            name: String(formData.get("name") ?? "").trim() || undefined,
          })
        : await backlex.auth.signIn({ email, password });

    if (!res.token) {
      return { error: "Signed in, but no session token was returned." };
    }
    await writeSessionToken(res.token);
  } catch (err) {
    return { error: errorMessage(err) };
  }

  // `redirect` throws a control-flow signal, so it must sit outside the
  // try/catch — inside, the catch would swallow it and the redirect would
  // silently never happen.
  redirect("/");
}

export async function signOutAction(): Promise<void> {
  try {
    const backlex = await backlexForRequest();
    await backlex.auth.signOut();
  } catch {
    // A already-expired session still needs the cookie gone locally.
  }
  await clearSessionToken();
  redirect("/sign-in");
}

/**
 * Writes go through Server Actions, and `revalidatePath` re-runs the page's
 * Server Component with fresh data. That replaces the client-side refetch the
 * SPA examples do by hand — and, unlike them, the updated HTML is what ships.
 */
export async function createNoteAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return {};

  try {
    const backlex = await backlexForRequest();
    await backlex.from<Note>("notes").create({ title, done: false });
  } catch (err) {
    return { error: errorMessage(err) };
  }
  revalidatePath("/");
  return {};
}

export async function toggleNoteAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const done = formData.get("done") === "true";
  if (!id) return;
  const backlex = await backlexForRequest();
  await backlex.from<Note>("notes").update(id, { done: !done });
  revalidatePath("/");
}

export async function deleteNoteAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const backlex = await backlexForRequest();
  await backlex.from<Note>("notes").delete(id);
  revalidatePath("/");
}
