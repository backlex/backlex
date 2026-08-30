// The router is also the app's largest code-splitting boundary, and the reason
// is in the public pages' own file headers: "nobody booking a haircut should be
// loading the admin bundle's theme". They are self-styled precisely so a
// stranger opening a link from an email gets a page and not an admin console —
// but while every route element was a static import, opening `/f/<token>`
// downloaded the entire admin anyway, theme and all. Every route below is
// therefore `lazy()`, which splits the two audiences apart at the one place
// they are already separated conceptually.
//
// The admin is the interesting case, because a naive lazy boundary would make
// it SLOWER: `<AuthGate>` spends a network round-trip deciding whether there is
// a session, and a chunk that only starts downloading once that resolves is a
// second round-trip stacked on the first. `warmAdminApp()` starts the download
// when the catch-all route matches — before the gate has an answer — so the two
// happen at once and the split costs the signed-in operator nothing.
import { lazy, Suspense } from "react";
import { Route, Routes, useNavigate } from "react-router";
import { I18nProvider } from "@lingui/react";
import { Toaster } from "@backlex/ui/components/sonner";
import { i18n } from "@/admin/i18n";
import { AuthGate } from "@/components/auth-gate";
import { BootScreen } from "@/components/boot-screen";
import { auth } from "@/lib/auth";

const AdminApp = lazy(() =>
  import("@/admin/app").then((m) => ({ default: m.AdminApp })),
);
const Forgot = lazy(() => import("@/pages/forgot").then((m) => ({ default: m.Forgot })));
const ResetPassword = lazy(() =>
  import("@/pages/reset-password").then((m) => ({ default: m.ResetPassword })),
);
const MagicLink = lazy(() =>
  import("@/pages/magic-link").then((m) => ({ default: m.MagicLink })),
);
const SharedRecord = lazy(() =>
  import("@/pages/shared-record").then((m) => ({ default: m.SharedRecord })),
);
const EmbedDashboard = lazy(() =>
  import("@/pages/embed-dashboard").then((m) => ({ default: m.EmbedDashboard })),
);
const PublicForm = lazy(() =>
  import("@/pages/public-form").then((m) => ({ default: m.PublicForm })),
);
const Book = lazy(() => import("@/pages/book").then((m) => ({ default: m.Book })));
const ManageBooking = lazy(() =>
  import("@/pages/book").then((m) => ({ default: m.ManageBooking })),
);
const ApproveRequest = lazy(() =>
  import("@/pages/approve-request").then((m) => ({ default: m.ApproveRequest })),
);
const SignDocument = lazy(() =>
  import("@/pages/sign-document").then((m) => ({ default: m.SignDocument })),
);
const SignIn = lazy(() => import("@/pages/sign-in").then((m) => ({ default: m.SignIn })));
const SignUp = lazy(() => import("@/pages/sign-up").then((m) => ({ default: m.SignUp })));
const Invite = lazy(() => import("@/pages/invite").then((m) => ({ default: m.Invite })));
const JoinWorkspaceUser = lazy(() =>
  import("@/pages/join-workspace-user").then((m) => ({
    default: m.JoinWorkspaceUser,
  })),
);
const JoinOrg = lazy(() => import("@/pages/join-org").then((m) => ({ default: m.JoinOrg })));
const OAuthConsent = lazy(() =>
  import("@/pages/oauth-consent").then((m) => ({ default: m.OAuthConsent })),
);

/**
 * Start downloading the admin chunk the moment the catch-all route matches, so
 * it arrives alongside — not after — `<AuthGate>`'s session round-trip.
 *
 * Called from render rather than an effect on purpose: an effect fires after
 * paint, which is exactly the delay this exists to avoid. `import()` is
 * idempotent (the module cache returns the in-flight promise), and the flag
 * keeps StrictMode's double render to one call.
 *
 * The honest cost: a signed-OUT visitor who lands on an admin path pays for a
 * chunk they are about to be redirected away from. That is accepted rather than
 * fixed, because the alternatives are worse — the session cookie is httpOnly so
 * nothing here can read it, and guessing from a localStorage breadcrumb trades
 * a wasted download for stale state. It is also not a regression: before the
 * split, that same visitor downloaded the admin *and* every public page.
 */
let adminWarmed = false;
const warmAdminApp = (): void => {
  if (adminWarmed) return;
  adminWarmed = true;
  void import("@/admin/app");
};

/**
 * The admin catch-all. `<AuthGate>` renders nothing until it knows the session
 * state, so on the fast path the chunk is already resolved by the time the gate
 * lets us through and the fallback below never paints. When the chunk IS the
 * slower of the two, the branded boot screen is the honest thing to show — it
 * is the same screen the gate itself shows for a slow session check, so a slow
 * boot looks like one thing rather than two.
 */
const AdminRoute = ({ onSignOut }: { onSignOut: () => void }) => {
  warmAdminApp();
  return (
    <AuthGate>
      <Suspense fallback={<BootScreen variant="connecting" />}>
        <AdminApp onSignOut={onSignOut} />
      </Suspense>
    </AuthGate>
  );
};

export const App = () => {
  const navigate = useNavigate();
  const onSignOut = async () => {
    try {
      await auth.signOut();
    } catch {
      // ignore
    }
    navigate("/sign-in", { replace: true });
  };
  return (
    <I18nProvider i18n={i18n}>
      {/* `null` is the deliberate fallback for the public routes. Each of these
          pages paints its own skeleton in its own palette, and that palette
          lives in the chunk being fetched — so anything shown here would have
          to come from the admin design system, which is the exact thing these
          pages exist not to load. The blank is also strictly shorter than
          before: the same bytes used to be part of a much larger bundle. */}
      <Suspense fallback={null}>
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/sign-up" element={<SignUp />} />
          <Route path="/magic-link" element={<MagicLink />} />
          <Route path="/forgot" element={<Forgot />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          {/* Public invite-acceptance — outside AuthGate; the invitee has no
              account yet. Resolves the token, then signs up + binds membership. */}
          <Route path="/invite" element={<Invite />} />
          {/* The workspace plane's two accept pages, registered here for the
              same reason `/invite` is: everything below `/*` renders inside
              `<AuthGate>`, which redirects a visitor with no session to
              /sign-in. An invitee is *by definition* that visitor — the
              end-user invite creates the account and the org invite may be the
              first time the person has heard of this workspace — so a gated
              accept page would bounce exactly the people it exists for. Being
              listed above the catch-all is the whole mechanism; there is no
              opt-out wrapper to add.

              They must also be matched by PATTERN rather than by a valid
              token: `/t/:slug/join/:token` claims every shape of that URL, so a
              stale or already-used link still reaches the page and gets told
              what went wrong. Were it to fall through to `/*` instead, the
              admin's not-found copy would tell the invitee the page does not
              exist, which is both untrue and unactionable. */}
          <Route path="/t/:slug/join/:token" element={<JoinWorkspaceUser />} />
          <Route path="/t/:slug/join-org/:token" element={<JoinOrg />} />
          {/* MCP OAuth consent — outside AuthGate so it renders the auth shell;
              the flow only lands here with a live session (authorize redirects
              unauthenticated users to /sign-in first). */}
          <Route path="/oauth/consent" element={<OAuthConsent />} />
          {/* Public record-share view — outside AuthGate, no session needed. */}
          <Route path="/s/:token" element={<SharedRecord />} />
          {/* Public BI dashboard embed — outside AuthGate; iframe-friendly. */}
          <Route path="/embed/d/:token" element={<EmbedDashboard />} />
          {/* Public form — outside AuthGate; /embed variant is iframe-friendly. */}
          <Route path="/f/:token" element={<PublicForm />} />
          <Route path="/embed/f/:token" element={<PublicForm embed />} />
          {/* Public signing page — outside AuthGate; the signer has no account
              and the link token is the whole grant. */}
          <Route path="/sign/:token" element={<SignDocument />} />
          {/* Public approval page — outside AuthGate for the same reason: the
              approver has no account and the link token is the whole grant. */}
          <Route path="/approve/:token" element={<ApproveRequest />} />
          {/* Public booking — outside AuthGate for the same reason: the page
              token is the grant to see a calendar, and the manage token the
              grant to change one appointment.

              The manage page lives at `/b/`, NOT at `/booking/`, even though
              `booking` is the admin nav id it would otherwise pair with. The
              admin router reads `segs[1]` as a sub-route (as `collections` and
              `flows` already do), so a future `/booking/<id>` detail view would
              be swallowed by this route instead. A short prefix is also kinder
              in an email. */}
          <Route path="/book/:token" element={<Book />} />
          <Route path="/b/:token" element={<ManageBooking />} />
          <Route path="/*" element={<AdminRoute onSignOut={onSignOut} />} />
        </Routes>
      </Suspense>
      <Toaster richColors closeButton position="top-right" />
    </I18nProvider>
  );
};
