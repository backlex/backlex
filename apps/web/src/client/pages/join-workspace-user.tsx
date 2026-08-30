// Public end-user invitation page — `/t/:slug/join/:token`.
//
// This is the third of the three invitation lifecycles and the last one to get
// a page a person can actually use. Until now the invitation email told its
// recipient to "POST /api/t/<slug>/auth/invite/accept with { token, password }",
// which is an instruction only somebody holding an HTTP client can act on — and
// the people an operator invites here are customers, staff and suppliers, not
// API consumers. The whole admin-driven half of the end-user lifecycle was
// therefore reachable only by the operator testing it themselves.
//
// How this invitation differs from its two siblings, because the difference is
// what decides the page's shape:
//
//   - `/invite` (platform) creates a CONTROL-plane account and lands the
//     invitee in the admin.
//   - `/t/:slug/join-org/:token` binds an app-plane account that must ALREADY
//     exist to an organization.
//   - this one is in between: `POST /api/app-users/invite` has already written
//     a pending `app_users` row with no credential, and accepting is what sets
//     that credential and flips the row to `active`. The invitee has an
//     identity here without ever having chosen a password.
//
// So the primary flow is "choose a password", not "sign in" — but an invitee
// who already has a password in this workspace has to be handled too, and the
// two are told apart by the invitee, not guessed at by the page. See `Mode`.
//
// Two things below are deliberate rather than stylistic, and both match
// `join-org.tsx` and the other public pages (signing, approvals, hosted forms):
//
// - The page is self-styled with a scoped `<style>` block instead of the admin
//   design system. Whoever opens this link is a customer's end-user, not an
//   operator of this instance; loading the admin theme at them is both a
//   payload they have no use for and a claim about whose product this is.
// - It deliberately does NOT use `AuthShell`. That shell footers every screen
//   with `/sign-in`, `/sign-up` and `/magic-link`, which are the CONTROL plane
//   — the backlex dashboard, not the workspace this invitation is for. Offering
//   them here would point the invitee at the wrong identity entirely, which is
//   the exact confusion this phase exists to remove.
import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { api, API_BASE } from "@/lib/api";

const CSS = `
.bxw { --bg:#f4f4f7; --card:#fff; --text:#16151f; --muted:#5f5c72; --line:#e2e0ea;
  --accent:#4c39d4; --accent-fg:#fff; --danger:#b3261e; --ok:#15803d; --pad:#fbfbfd;
  min-height:100dvh; background:var(--bg); color:var(--text);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; padding:16px; }
@media (prefers-color-scheme: dark){ .bxw{ --bg:#0b0a12; --card:#141222; --text:#eceaf7;
  --muted:#a09bbd; --line:#282343; --accent:#8b7bff; --accent-fg:#100c22; --danger:#ff8a80;
  --ok:#4ade80; --pad:#1b1830; } }
.bxw-wrap{ max-width:460px; margin:0 auto; display:flex; flex-direction:column; gap:14px; }
/* overflow-wrap is inherited, so one declaration on the card covers every
   string inside it. It is needed because the workspace name is free text an
   operator typed: an unbroken 40-character name in the 20px h1 is wider than
   the card at 390px and scrolls the whole page sideways. */
.bxw-card{ background:var(--card); border:1px solid var(--line); border-radius:14px;
  padding:18px; overflow-wrap:anywhere; }
.bxw h1{ font-size:20px; margin:0 0 4px; font-weight:650; letter-spacing:-.01em; }
.bxw-sub{ color:var(--muted); font-size:13px; margin:0; }
.bxw-note{ border:1px solid var(--line); background:var(--pad); border-radius:10px;
  padding:11px 12px; font-size:13px; margin:14px 0 0; color:var(--muted); }
.bxw-note strong{ color:var(--text); font-weight:600; }
.bxw-mail{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
.bxw-form{ display:flex; flex-direction:column; gap:12px; margin:14px 0 0; }
.bxw-field{ display:flex; flex-direction:column; gap:5px; }
.bxw-label{ font-size:13px; font-weight:550; }
.bxw-hint{ color:var(--muted); font-size:12px; }
.bxw-input{ width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:9px;
  background:var(--pad); color:var(--text); font:inherit; padding:10px 12px; }
.bxw-input:disabled{ opacity:.7; }
/* box-sizing is spelled out for the same reason .bxw-input above spells it
   out. This is the only full-width button on the page, so under the default
   content-box its 14px of side padding plus a 1px border add 30px past the
   card and scroll a 390px viewport sideways. It looks fine today only
   because main.tsx happens to load the admin globals.css, whose Tailwind
   preflight sets box-sizing on everything -- and not depending on that
   stylesheet is this page's whole design premise. */
.bxw-btn{ appearance:none; border:1px solid var(--line); background:transparent; color:var(--text);
  border-radius:9px; padding:10px 14px; font:inherit; font-weight:550; cursor:pointer;
  width:100%; box-sizing:border-box; }
.bxw-btn:disabled{ opacity:.5; cursor:not-allowed; }
.bxw-btn-primary{ background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
.bxw-err{ color:var(--danger); font-size:13px; margin:12px 0 0; }
.bxw-ok{ color:var(--ok); }
.bxw-switch{ color:var(--muted); font-size:13px; margin:12px 0 0; text-align:center; }
.bxw-link{ appearance:none; border:0; background:none; padding:0; font:inherit; color:var(--text);
  text-decoration:underline; text-underline-offset:3px; cursor:pointer; }
.bxw-skel{ background:var(--line); border-radius:8px; animation:bxw-pulse 1.4s ease-in-out infinite; }
@keyframes bxw-pulse{ 0%,100%{opacity:.55} 50%{opacity:.95} }
@media (max-width:640px){ .bxw{ padding:10px; } .bxw-card{ padding:14px; border-radius:12px; } }
`;

/**
 * Exactly what `GET /api/t/:slug/auth/invite/:token` answers with.
 *
 * `workspaceName` and `email` are nullable because the endpoint returns ONE
 * shape for every unusable token — unknown, expired, spent, or attached to a
 * suspended account all answer `valid: false` with both fields null, so the
 * endpoint cannot be walked to find out which invitations or which addresses
 * exist. That is why this page has no "expired" state: it is not told.
 */
interface InviteMeta {
  valid: boolean;
  workspaceName: string | null;
  email: string | null;
}

/** The resolved invitation, once `valid` has been checked — the same data with
 *  the nullability discharged, so the render paths don't re-test it. */
interface UsableInvite {
  workspaceName: string;
  email: string;
}

/**
 * The bound on the one operator-authored string this page renders.
 *
 * `tenants.name` is free text a workspace admin typed, and this page is
 * unauthenticated, sits on this instance's own domain, and already shows a
 * password box. Left unbounded, the name is a paragraph slot: "URGENT — your
 * account is locked, call 1-800-…" painted as the h1 of a credential form is a
 * phishing page that backlex itself served. React escapes markup but not prose,
 * and prose is the attack.
 *
 * So the line is drawn at "a workspace may identify ITSELF and may say nothing
 * else". 60 characters is generous for a name and far too short for an
 * instruction. The clamp is applied ONCE, where the value enters state, rather
 * than at each render site — a later render path cannot forget a bound that was
 * enforced before the string was stored.
 *
 * Nothing else here is workspace-authored: `email` is the address the link was
 * mailed to, and the resolve endpoint answers no invitation message, note or
 * description this page could be talked into displaying. Mirrors `orgLabel` in
 * `join-org.tsx`, the sibling page with the identical exposure.
 */
const WORKSPACE_NAME_MAX = 60;
const workspaceLabel = (name: string): string =>
  name.length > WORKSPACE_NAME_MAX ? `${name.slice(0, WORKSPACE_NAME_MAX - 1)}…` : name;

type State =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "ready"; meta: UsableInvite }
  | { kind: "done"; meta: UsableInvite };

/**
 * Which password the invitee is being asked for.
 *
 * The invitation always points at an `app_users` row, but that row may or may
 * not already carry a credential, and only the person reading the mail knows
 * which. Guessing would be wrong in both directions — and the page cannot ask
 * the server "does this person already have a password here?" without turning
 * the resolve endpoint into the account oracle it was written not to be.
 *
 *   - `create`   — the ordinary case. No credential yet; pick one.
 *   - `existing` — they already sign in to this workspace. Their current
 *                  password is verified against the workspace's own auth
 *                  surface FIRST, and only then is the invitation accepted.
 *
 * The verify-first step in `existing` is the entire reason the mode exists.
 * `POST .../auth/invite/accept` writes whatever password it is handed onto the
 * credential, so a returning invitee who mistyped would silently have had their
 * working password replaced by the typo — a lockout delivered by the page whose
 * whole job is to let them in. Signing in first turns that into "that password
 * didn't match", and leaves the account untouched.
 */
type Mode = "create" | "existing";

const Skeleton = () => (
  <div className="bxw-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <div className="bxw-skel" style={{ height: 22, width: "62%" }} />
    <div className="bxw-skel" style={{ height: 14, width: "42%" }} />
    <div className="bxw-skel" style={{ height: 58, width: "100%" }} />
    <div className="bxw-skel" style={{ height: 40, width: "100%" }} />
  </div>
);

/**
 * Sign in against the WORKSPACE's own better-auth surface.
 *
 * Not `@/lib/auth`: that client is hard-wired to `/api/auth`, the control
 * plane, and would check the password against a backlex dashboard account —
 * a different identity in a different table. The workspace's instance lives
 * under `/api/t/<slug>/auth`.
 *
 * Used only to VERIFY the password in `existing` mode; the session it issues is
 * incidental, because the invitation token — not a cookie — is what authorises
 * the accept call that follows.
 */
const workspaceSignIn = async (
  slug: string,
  email: string,
  password: string,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const res = await fetch(`${API_BASE}/api/t/${encodeURIComponent(slug)}/auth/sign-in/email`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.ok) return { ok: true };
  // better-auth answers `{ message }`; the error middleware in front of it
  // answers `{ error: { message } }`. Read both, so a refusal the workspace has
  // a real reason for ("Account is locked") reaches the invitee instead of a
  // bare status code.
  const payload = (await res.json().catch(() => null)) as
    | { message?: string; error?: { message?: string } | string }
    | null;
  const fromError =
    typeof payload?.error === "object" ? payload.error?.message : payload?.error;
  return { ok: false, message: String(payload?.message ?? fromError ?? "") };
};

export const JoinWorkspaceUser = () => {
  const { t } = useLingui();
  const { slug = "", token = "" } = useParams();

  const [state, setState] = useState<State>({ kind: "loading" });
  const [mode, setMode] = useState<Mode>("create");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!slug || !token) {
      setState({ kind: "invalid" });
      return;
    }
    void (async () => {
      try {
        const r = await api<{ data: InviteMeta }>(
          `/api/t/${encodeURIComponent(slug)}/auth/invite/${encodeURIComponent(token)}`,
        );
        if (cancelled) return;
        const m = r.data;
        // `valid` is authoritative, but the two strings are still checked: a
        // truthy `valid` with a null email would render a form that posts an
        // empty address, and trusting the flag alone is how that ships.
        if (!m?.valid || !m.email || !m.workspaceName) {
          setState({ kind: "invalid" });
          return;
        }
        setState({
          kind: "ready",
          // Clamped here, at the one boundary the value crosses into state.
          meta: { workspaceName: workspaceLabel(m.workspaceName), email: m.email },
        });
      } catch {
        if (cancelled) return;
        // An unknown workspace slug 404s here, and a network failure lands here
        // too. Both say the same thing, which is honest: there is nothing this
        // page can offer until the link resolves.
        setState({ kind: "invalid" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (state.kind !== "ready") return;
    const meta = state.meta;
    // Refused before the round-trip so the message lands next to the box that
    // has to change, rather than as a 422 from the server. Only `create` is
    // gated: an existing password predates this rule and may be shorter, and
    // rejecting it here would lock somebody out of accepting over a policy
    // their account was never asked to meet.
    if (mode === "create" && password.length < 8) {
      setError(t`Password must be at least 8 characters.`);
      return;
    }
    if (!password) {
      setError(t`Enter your password to continue.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "existing") {
        const signedIn = await workspaceSignIn(slug, meta.email, password);
        if (!signedIn.ok) {
          setError(
            signedIn.message ||
              t`That password didn't match the account for this address.`,
          );
          return;
        }
      }
      // One call finishes it either way: it sets the credential, marks the
      // address verified (the link arrived at that mailbox), flips the row to
      // active and consumes the token so the link cannot be replayed.
      //
      // The response carries an access/refresh pair. It is deliberately dropped
      // rather than shown or stored: this page is not the workspace's app, it
      // has nowhere to send a bearer token, and printing a live credential into
      // a DOM that a shared or borrowed device keeps in history is a worse
      // outcome than one extra sign-in.
      await api(`/api/t/${encodeURIComponent(slug)}/auth/invite/accept`, {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      setState({ kind: "done", meta });
    } catch (err) {
      setError((err as Error).message || t`Could not accept the invitation.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bxw">
      <style>{CSS}</style>
      <div className="bxw-wrap">
        {state.kind === "loading" && <Skeleton />}

        {state.kind === "invalid" && (
          <div className="bxw-card">
            <h1>
              <Trans>This invitation link is not valid</Trans>
            </h1>
            {/* Every failure reads the same because the server reports them the
                same — see `InviteMeta`. Expiry is named as a possible cause so
                the sentence stays actionable without the page having been told
                which cause actually applies. */}
            <p className="bxw-sub">
              <Trans>
                It may have expired, already been used, or been withdrawn. Invitations are
                valid for 7 days — ask whoever invited you to send a new one.
              </Trans>
            </p>
          </div>
        )}

        {state.kind === "done" && (
          <div className="bxw-card">
            <h1 className="bxw-ok">
              <Trans>Your account is ready</Trans>
            </h1>
            <p className="bxw-sub">
              <Trans>
                You can now sign in to {state.meta.workspaceName} with your email address and
                the password you just set.
              </Trans>
            </p>
            <p className="bxw-note">
              <Trans>
                Set up as <strong className="bxw-mail">{state.meta.email}</strong>. This
                invitation link has been used and will not work again.
              </Trans>
            </p>
          </div>
        )}

        {state.kind === "ready" && (
          <div className="bxw-card">
            {/* `workspaceName` is the ONLY operator-authored string on this
                page, and it is here because an invitee has to be able to tell
                an expected invitation from a stray one. React escapes it as
                text; nothing renders it as HTML, a URL or a link. The resolve
                endpoint carries the matching argument for why there is no
                free-text invitation message to render alongside it. */}
            <h1>
              <Trans>Join {state.meta.workspaceName}</Trans>
            </h1>
            <p className="bxw-sub">
              {mode === "create" ? (
                <Trans>Choose a password to finish setting up your account.</Trans>
              ) : (
                <Trans>Confirm your existing password to accept this invitation.</Trans>
              )}
            </p>
            <p className="bxw-note">
              <Trans>
                Invitation sent to <strong className="bxw-mail">{state.meta.email}</strong>.
              </Trans>
            </p>
            <form className="bxw-form" onSubmit={submit}>
              <div className="bxw-field">
                <label className="bxw-label" htmlFor="join-ws-email">
                  <Trans>Email</Trans>
                </label>
                {/* Locked: the account this invitation provisions is bound to
                    the invited address, and the server reads that address from
                    the token rather than from this form. An editable box would
                    only offer a way to be confused about which account is
                    being set up. */}
                <input
                  id="join-ws-email"
                  className="bxw-input"
                  type="email"
                  value={state.meta.email}
                  readOnly
                  disabled
                />
              </div>
              <div className="bxw-field">
                <label className="bxw-label" htmlFor="join-ws-password">
                  {mode === "create" ? (
                    <Trans>Choose a password</Trans>
                  ) : (
                    <Trans>Your existing password</Trans>
                  )}
                </label>
                <input
                  id="join-ws-password"
                  className="bxw-input"
                  type="password"
                  autoComplete={mode === "create" ? "new-password" : "current-password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "create" ? t`At least 8 characters` : undefined}
                />
                {mode === "existing" && (
                  <span className="bxw-hint">
                    <Trans>Checked before anything changes — a wrong one changes nothing.</Trans>
                  </span>
                )}
              </div>
              <button type="submit" className="bxw-btn bxw-btn-primary" disabled={busy}>
                {busy ? (
                  <Trans>Setting up…</Trans>
                ) : mode === "create" ? (
                  <Trans>Create account</Trans>
                ) : (
                  <Trans>Accept invitation</Trans>
                )}
              </button>
            </form>
            {error && <p className="bxw-err">{error}</p>}
            {/* Both modes are always offered rather than detected. Asking the
                server which one applies would mean an unauthenticated endpoint
                answering "does this address already have a password here?",
                which is the account oracle the resolve route exists to avoid. */}
            <p className="bxw-switch">
              {mode === "create" ? (
                <>
                  <Trans>Already sign in to this workspace?</Trans>{" "}
                  <button
                    type="button"
                    className="bxw-link"
                    onClick={() => {
                      setMode("existing");
                      setPassword("");
                      setError(null);
                    }}
                  >
                    <Trans>Use your existing password</Trans>
                  </button>
                </>
              ) : (
                <>
                  <Trans>Never signed in here before?</Trans>{" "}
                  <button
                    type="button"
                    className="bxw-link"
                    onClick={() => {
                      setMode("create");
                      setPassword("");
                      setError(null);
                    }}
                  >
                    <Trans>Choose a new password</Trans>
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

// Exported BOTH ways on purpose. `App.tsx` — owned by another agent on this
// branch — currently lazy-imports the NAMED binding
// (`import(...).then((m) => ({ default: m.JoinWorkspaceUser }))`), while the
// route was specified to this page as a default export. A module satisfying
// only one of those renders `undefined` as an element and takes the whole route
// down with "Element type is invalid", so this satisfies both and stays correct
// whichever way that import settles.
export default JoinWorkspaceUser;
