// Public organization-invitation page — `/t/:slug/join-org/:token`.
//
// This is what the invitation email links to. It used to link to nothing: the
// mail told the recipient to "sign in to your account, then POST
// /api/t/<slug>/orgs/invites/accept with {token}", which is an instruction only
// somebody holding this repository can act on.
//
// The org invite differs from the other two invitation lifecycles in the one
// way that decides this page's shape: accepting it requires an app-plane
// account that ALREADY EXISTS. The platform invite (`/invite`) creates the
// account it invites; the workspace end-user invite provisions a pending row
// and its accept call sets the password. An org invitation does neither — it
// binds an `app_users` row to an `app_org_members` row, and `acceptOrgInvite`
// refuses unless the caller's own email matches the invited address.
//
// So the page must work for a visitor with no session, which is the common
// case — the link arrived by mail, on whatever device happened to open it. It
// renders two states over the same resolved invitation:
//
//   - signed in as the invited address: one button, accept;
//   - signed out (or signed in as somebody else): sign in or create the
//     account against the WORKSPACE's own auth surface, and accept in the same
//     submit so the invitee never has to find their way back here.
//
// A page that handled only the first state would recreate the dead end it
// exists to remove.
//
// Two things here are deliberate rather than stylistic, and both match the
// public signing / approval / form pages:
//
// - The page is self-styled with a `<style>` block rather than the admin design
//   system. The person accepting is a customer's end-user, not an operator of
//   this instance; they should not be loading the admin theme, and a fixed
//   light/dark pair is stable regardless of what the workspace runs.
// - It deliberately does NOT use `AuthShell`. That shell footers every screen
//   with links to `/sign-in`, `/sign-up` and `/magic-link`, which are the
//   CONTROL plane — the backlex dashboard, not the workspace this invitation is
//   for. Offering them here would point the invitee at the wrong identity.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { api, API_BASE } from "@/lib/api";

const CSS = `
.bxj { --bg:#f4f4f7; --card:#fff; --text:#16151f; --muted:#5f5c72; --line:#e2e0ea;
  --accent:#4c39d4; --accent-fg:#fff; --danger:#b3261e; --ok:#15803d; --pad:#fbfbfd;
  min-height:100dvh; background:var(--bg); color:var(--text);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; padding:16px; }
@media (prefers-color-scheme: dark){ .bxj{ --bg:#0b0a12; --card:#141222; --text:#eceaf7;
  --muted:#a09bbd; --line:#282343; --accent:#8b7bff; --accent-fg:#100c22; --danger:#ff8a80;
  --ok:#4ade80; --pad:#1b1830; } }
.bxj-wrap{ max-width:460px; margin:0 auto; display:flex; flex-direction:column; gap:14px; }
/* overflow-wrap is inherited, so one declaration on the card covers every
   string inside it. Load-bearing at 390px: the org name is free text somebody
   typed, and an unbroken 40-character word in a 20px heading is wider than the
   card. Without this the whole PAGE scrolls sideways, not just the heading. */
.bxj-card{ background:var(--card); border:1px solid var(--line); border-radius:14px;
  padding:18px; overflow-wrap:anywhere; }
.bxj h1{ font-size:20px; margin:0 0 4px; font-weight:650; letter-spacing:-.01em; }
.bxj-sub{ color:var(--muted); font-size:13px; margin:0; }
.bxj-note{ border:1px solid var(--line); background:var(--pad); border-radius:10px;
  padding:11px 12px; font-size:13px; margin:14px 0 0; color:var(--muted); }
.bxj-note strong{ color:var(--text); font-weight:600; }
.bxj-mail{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
.bxj-form{ display:flex; flex-direction:column; gap:12px; margin:14px 0 0; }
.bxj-field{ display:flex; flex-direction:column; gap:5px; }
.bxj-label{ font-size:13px; font-weight:550; }
.bxj-input{ width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:9px;
  background:var(--pad); color:var(--text); font:inherit; padding:10px 12px; }
.bxj-input:disabled{ opacity:.7; }
/* box-sizing is spelled out for the same reason .bxj-input spells it out, and
   it matters MORE here: this is the only full-width button on any of the public
   pages, so width:100% under the default content-box adds 28px of padding and
   2px of border on top of the card's inner width and pushes the page sideways
   at 390px. It happens to be saved today by the Tailwind preflight that
   globals.css loads — but this block is deliberately self-sufficient (the whole
   point of not using the admin design system here), so it must not depend on
   that reset being present. */
.bxj-btn{ appearance:none; border:1px solid var(--line); background:transparent; color:var(--text);
  border-radius:9px; padding:10px 14px; font:inherit; font-weight:550; cursor:pointer;
  width:100%; box-sizing:border-box; }
.bxj-btn:disabled{ opacity:.5; cursor:not-allowed; }
.bxj-btn-primary{ background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
.bxj-err{ color:var(--danger); font-size:13px; margin:12px 0 0; }
.bxj-ok{ color:var(--ok); }
.bxj-switch{ color:var(--muted); font-size:13px; margin:12px 0 0; text-align:center; }
.bxj-link{ appearance:none; border:0; background:none; padding:0; font:inherit; color:var(--text);
  text-decoration:underline; text-underline-offset:3px; cursor:pointer; }
.bxj-skel{ background:var(--line); border-radius:8px; animation:bxj-pulse 1.4s ease-in-out infinite; }
@keyframes bxj-pulse{ 0%,100%{opacity:.55} 50%{opacity:.95} }
@media (max-width:640px){ .bxj{ padding:10px; } .bxj-card{ padding:14px; border-radius:12px; } }
`;

/** The narrow view the public resolve endpoint answers with. */
interface InviteMeta {
  orgName: string;
  email: string;
  role: "owner" | "admin" | "member";
  expired: boolean;
}

/**
 * Where the line is drawn on what a workspace may PAINT on this page.
 *
 * This screen is unauthenticated, reachable by anyone holding a link, and looks
 * official — which is exactly the surface a phishing message wants. So the rule
 * is that it renders only what the workspace legitimately owns, and only in a
 * shape that stays a label:
 *
 * - `role` never reaches the DOM as stored text; it is one of three enum values
 *   put through {@link roleLabel} and rendered as a translated phrase.
 * - `email` is not workspace-authored at all: it is the address the invitation
 *   was addressed to, which the person reading the page already knows.
 * - `orgName` IS free text an org owner typed, so it is the one field that
 *   needs a bound. React escapes it (nothing here is ever
 *   `dangerouslySetInnerHTML`), which stops markup but not prose — and prose is
 *   the attack. A name is a LABEL; the moment it can hold sentences it can hold
 *   "your account is locked, call 1-800-…", printed on a page the invitee has
 *   every reason to trust. Sixty characters is longer than any real company
 *   name and far too short for an instruction.
 *
 * Nothing else is available to render, deliberately: the resolve endpoint
 * answers these three fields and no more (see `OrgInvitePreview` in
 * services/app-orgs.ts), so there is no invitation "message", org description
 * or inviter-supplied note this page could be talked into displaying.
 */
const ORG_NAME_MAX = 60;
const orgLabel = (name: string): string =>
  name.length > ORG_NAME_MAX ? `${name.slice(0, ORG_NAME_MAX - 1)}…` : name;

/** The workspace session this browser holds, if any. */
interface AppSession {
  email: string;
}

type State =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "expired"; meta: InviteMeta }
  | { kind: "ready"; meta: InviteMeta; session: AppSession | null }
  | { kind: "joined"; meta: InviteMeta };

/** Sign in with the password you have, or create the account you don't. */
type Mode = "sign-in" | "sign-up";

const Skeleton = () => (
  <div className="bxj-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <div className="bxj-skel" style={{ height: 22, width: "62%" }} />
    <div className="bxj-skel" style={{ height: 14, width: "42%" }} />
    <div className="bxj-skel" style={{ height: 58, width: "100%" }} />
    <div className="bxj-skel" style={{ height: 40, width: "100%" }} />
  </div>
);

/**
 * Call the WORKSPACE's own better-auth surface.
 *
 * Not `@/lib/auth`: that client is hard-wired to `/api/auth`, the control
 * plane, and would sign the invitee into the backlex dashboard — which is not
 * the identity an org membership binds to. The workspace's instance lives under
 * `/api/t/<slug>/auth` and issues its own `wo_<slug>.session_token` cookie,
 * which is what authenticates the accept call below.
 */
const authCall = async (
  slug: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const res = await fetch(`${API_BASE}/api/t/${encodeURIComponent(slug)}/auth/${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return { ok: true };
  // better-auth answers `{ message }`; the error middleware in front of it
  // answers `{ error: { message } }`. Read both, so the invitee sees the real
  // reason ("Sign-up is disabled") instead of a status code.
  const payload = (await res.json().catch(() => null)) as
    | { message?: string; error?: { message?: string } | string }
    | null;
  const fromError =
    typeof payload?.error === "object" ? payload.error?.message : payload?.error;
  return { ok: false, message: String(payload?.message ?? fromError ?? "") };
};

export const JoinOrg = () => {
  const { t } = useLingui();
  const { slug = "", token = "" } = useParams();

  const [state, setState] = useState<State>({ kind: "loading" });
  const [mode, setMode] = useState<Mode>("sign-in");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The app-plane session for THIS workspace, or null. Never throws: having no
   *  session is the expected answer here, not a failure. */
  const readSession = useCallback(async (): Promise<AppSession | null> => {
    try {
      const res = await fetch(
        `${API_BASE}/api/t/${encodeURIComponent(slug)}/auth/get-session`,
        { credentials: "include", headers: { "content-type": "application/json" } },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { user?: { email?: string } } | null;
      const email = body?.user?.email;
      return typeof email === "string" ? { email } : null;
    } catch {
      return null;
    }
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    if (!slug || !token) {
      setState({ kind: "invalid" });
      return;
    }
    void (async () => {
      try {
        const [invite, session] = await Promise.all([
          api<{ data: InviteMeta }>(
            `/api/t/${encodeURIComponent(slug)}/orgs/invites/${encodeURIComponent(token)}`,
          ),
          readSession(),
        ]);
        if (cancelled) return;
        // Clamp at the BOUNDARY, once, rather than at each of the four places
        // the name is rendered — a render path added later can't forget a rule
        // that was already applied before the value entered state.
        const meta: InviteMeta = {
          ...invite.data,
          orgName: orgLabel(invite.data.orgName),
        };
        setState(
          meta.expired
            ? { kind: "expired", meta }
            : { kind: "ready", meta, session },
        );
      } catch {
        if (cancelled) return;
        // Unknown, revoked and already-accepted tokens are all a 404 here, and
        // all read the same to the person holding the link. A network failure
        // lands here too and says the same thing, which is honest: there is
        // nothing this page can offer until the link resolves.
        setState({ kind: "invalid" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, token, readSession]);

  /** Bind the membership. The session — just acquired, or already held — is
   *  what authenticates it, and the server re-checks the email either way. */
  const accept = async (meta: InviteMeta): Promise<void> => {
    await api(`/api/t/${encodeURIComponent(slug)}/orgs/invites/accept`, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    setState({ kind: "joined", meta });
  };

  const acceptSignedIn = async () => {
    if (state.kind !== "ready") return;
    setBusy(true);
    setError(null);
    try {
      await accept(state.meta);
    } catch (e) {
      setError((e as Error).message || t`Could not accept the invitation.`);
    } finally {
      setBusy(false);
    }
  };

  /** Acquire a workspace session, then accept — one submit, not two errands. */
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (state.kind !== "ready") return;
    const meta = state.meta;
    // Refused before the round-trip so the message lands next to the box that
    // has to change, rather than as a 422 from better-auth.
    if (password.length < 8) {
      setError(t`Password must be at least 8 characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === "sign-up"
          ? await authCall(slug, "sign-up/email", {
              email: meta.email,
              password,
              name: name.trim() || meta.email.split("@")[0] || "member",
            })
          : await authCall(slug, "sign-in/email", { email: meta.email, password });
      if (!res.ok) {
        setError(
          res.message ||
            (mode === "sign-up" ? t`Could not create the account.` : t`Sign-in failed.`),
        );
        return;
      }
      // Sign-up auto-signs-in (better-auth `autoSignIn` is on for every tenant
      // instance), so both branches land here holding the cookie accept needs.
      await accept(meta);
    } catch (err) {
      setError((err as Error).message || t`Could not accept the invitation.`);
    } finally {
      setBusy(false);
    }
  };

  /** Drop the workspace session so a different account can accept. */
  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await authCall(slug, "sign-out", {});
    } finally {
      setBusy(false);
    }
    if (state.kind === "ready") setState({ ...state, session: null });
  };

  // The membership role, spelled out. `owner` / `admin` / `member` are stored
  // values, not sentences somebody outside this codebase should have to read.
  const roleLabel = (role: InviteMeta["role"]): string =>
    role === "owner" ? t`an owner` : role === "admin" ? t`an administrator` : t`a member`;

  const invitedNote = (meta: InviteMeta) => {
    const role = roleLabel(meta.role);
    return (
      <p className="bxj-note">
        <Trans>
          Sent to <strong className="bxj-mail">{meta.email}</strong>, to join as {role}.
        </Trans>
      </p>
    );
  };

  const signedIn =
    state.kind === "ready" && state.session
      ? state.session.email.toLowerCase() === state.meta.email.toLowerCase()
      : false;

  return (
    <div className="bxj">
      <style>{CSS}</style>
      <div className="bxj-wrap">
        {state.kind === "loading" && <Skeleton />}

        {state.kind === "invalid" && (
          <div className="bxj-card">
            <h1>
              <Trans>This invitation link is not valid</Trans>
            </h1>
            <p className="bxj-sub">
              <Trans>
                It may have been withdrawn, or already used. Ask whoever invited you to send a
                new one.
              </Trans>
            </p>
          </div>
        )}

        {state.kind === "expired" && (
          <div className="bxj-card">
            <h1>
              <Trans>This invitation has expired</Trans>
            </h1>
            <p className="bxj-sub">
              <Trans>
                Invitations to {state.meta.orgName} are valid for 7 days. Ask for a new one.
              </Trans>
            </p>
          </div>
        )}

        {state.kind === "joined" && (
          <div className="bxj-card">
            <h1 className="bxj-ok">
              <Trans>You're in</Trans>
            </h1>
            <p className="bxj-sub">
              <Trans>
                You joined {state.meta.orgName}. Head back to the app you were invited from —
                you'll see it there now.
              </Trans>
            </p>
          </div>
        )}

        {/* Signed in as the invited address: one button, nothing to type. */}
        {state.kind === "ready" && signedIn && (
          <div className="bxj-card">
            <h1>
              <Trans>Join {state.meta.orgName}</Trans>
            </h1>
            <p className="bxj-sub">
              <Trans>You're signed in, and this invitation is addressed to you.</Trans>
            </p>
            {invitedNote(state.meta)}
            {error && <p className="bxj-err">{error}</p>}
            <div style={{ marginTop: 14 }}>
              <button
                type="button"
                className="bxj-btn bxj-btn-primary"
                disabled={busy}
                onClick={acceptSignedIn}
              >
                {busy ? <Trans>Joining…</Trans> : <Trans>Accept invitation</Trans>}
              </button>
            </div>
          </div>
        )}

        {/* Signed in as SOMEBODY ELSE. Accepting would fail the server's email
            check, so say why and offer the one move that fixes it. */}
        {state.kind === "ready" && state.session && !signedIn && (
          <div className="bxj-card">
            <h1>
              <Trans>Wrong account</Trans>
            </h1>
            <p className="bxj-sub">
              <Trans>
                This invitation was sent to a different address than the one you're signed in
                with.
              </Trans>
            </p>
            <p className="bxj-note">
              <Trans>
                Invited: <strong className="bxj-mail">{state.meta.email}</strong>. Signed in as{" "}
                <strong className="bxj-mail">{state.session.email}</strong>.
              </Trans>
            </p>
            {error && <p className="bxj-err">{error}</p>}
            <div style={{ marginTop: 14 }}>
              <button type="button" className="bxj-btn" disabled={busy} onClick={signOut}>
                {busy ? (
                  <Trans>Signing out…</Trans>
                ) : (
                  <Trans>Sign out and use another account</Trans>
                )}
              </button>
            </div>
          </div>
        )}

        {/* No session — the case the old email had no answer for. */}
        {state.kind === "ready" && !state.session && (
          <div className="bxj-card">
            <h1>
              <Trans>Join {state.meta.orgName}</Trans>
            </h1>
            <p className="bxj-sub">
              {mode === "sign-up" ? (
                <Trans>Create your account to accept this invitation.</Trans>
              ) : (
                <Trans>Sign in to accept this invitation.</Trans>
              )}
            </p>
            {invitedNote(state.meta)}
            <form className="bxj-form" onSubmit={submit}>
              <div className="bxj-field">
                <label className="bxj-label" htmlFor="join-org-email">
                  <Trans>Email</Trans>
                </label>
                {/* Locked: the membership binds to the invited address and the
                    server refuses any other, so an editable box here would only
                    offer a way to fail. */}
                <input
                  id="join-org-email"
                  className="bxj-input"
                  type="email"
                  value={state.meta.email}
                  readOnly
                  disabled
                />
              </div>
              {mode === "sign-up" && (
                <div className="bxj-field">
                  <label className="bxj-label" htmlFor="join-org-name">
                    <Trans>Display name (optional)</Trans>
                  </label>
                  <input
                    id="join-org-name"
                    className="bxj-input"
                    type="text"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
              )}
              <div className="bxj-field">
                <label className="bxj-label" htmlFor="join-org-password">
                  <Trans>Password</Trans>
                </label>
                <input
                  id="join-org-password"
                  className="bxj-input"
                  type="password"
                  autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "sign-up" ? t`At least 8 characters` : undefined}
                />
              </div>
              <button type="submit" className="bxj-btn bxj-btn-primary" disabled={busy}>
                {busy ? (
                  <Trans>Joining…</Trans>
                ) : mode === "sign-up" ? (
                  <Trans>Create account and join</Trans>
                ) : (
                  <Trans>Sign in and join</Trans>
                )}
              </button>
            </form>
            {error && <p className="bxj-err">{error}</p>}
            {/* Both modes are always offered. Whether a workspace admits new
                accounts is the server's call (`policy.openSignup`, plus any
                `before-user-created` hook) and it answers with a reason, so
                hiding the option here would be a guess that can be wrong in
                both directions. */}
            <p className="bxj-switch">
              {mode === "sign-in" ? (
                <>
                  <Trans>No account yet?</Trans>{" "}
                  <button
                    type="button"
                    className="bxj-link"
                    onClick={() => {
                      setMode("sign-up");
                      setError(null);
                    }}
                  >
                    <Trans>Create one</Trans>
                  </button>
                </>
              ) : (
                <>
                  <Trans>Already have an account?</Trans>{" "}
                  <button
                    type="button"
                    className="bxj-link"
                    onClick={() => {
                      setMode("sign-in");
                      setError(null);
                    }}
                  >
                    <Trans>Sign in instead</Trans>
                  </button>
                </>
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

// Exported both ways on purpose. `App.tsx` lazy-loads this page and maps the
// named export onto `default` itself; a plain `import("@/pages/join-org")` —
// the shape most other lazy routes in that file use — needs the default
// instead. Offering only one of the two makes the registration style
// load-bearing, and a mismatch there fails at RUNTIME as a blank page rather
// than at build time.
export default JoinOrg;
