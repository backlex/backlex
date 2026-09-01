/**
 * The shell: an auth gate on the control plane, a nav rail, and a hash router.
 */
import { useEffect, useState, type FormEvent } from "react";
import { backlex } from "./lib/backlex";
import { ToastHost, errText } from "./lib/hooks";
import { segments, useRoute } from "./lib/router";
import { AuthGateSkeleton, Button, cx, Field, Icon, inputCls, type IconName } from "@backlex-examples/shared";
import { Dashboard } from "./pages/Dashboard";
import { Products } from "./pages/Products";
import { ProductDetail } from "./pages/ProductDetail";
import { Orders } from "./pages/Orders";
import { OrderDetail } from "./pages/OrderDetail";
import { Customers } from "./pages/Customers";
import { Inventory } from "./pages/Inventory";
import { Discounts } from "./pages/Discounts";
import { Pricing } from "./pages/Pricing";

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: "/", label: "Dashboard", icon: "dashboard" },
  { to: "/products", label: "Products", icon: "products" },
  { to: "/orders", label: "Orders", icon: "orders" },
  { to: "/customers", label: "Customers", icon: "customers" },
  { to: "/inventory", label: "Inventory", icon: "inventory" },
  { to: "/pricing", label: "Pricing", icon: "pricing" },
  { to: "/discounts", label: "Discounts", icon: "discounts" },
];

/** The shop's own mark — drawn, so it tints and scales with the shell. */
function Brand({ className }: { className?: string }) {
  return (
    <span className={cx("flex items-center gap-2 text-sm font-semibold tracking-tight", className)}>
      <span className="grid size-7 shrink-0 place-items-center rounded-control bg-brand text-on-brand">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M4 15V5l12 10V5" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      Storefront
    </span>
  );
}

type Me = { id: string; email: string; name?: string | null } | null;

export function App() {
  const [me, setMe] = useState<Me>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    backlex.auth
      .getSession()
      .then((r) => setMe((r.user as Me) ?? null))
      .catch(() => setMe(null))
      .finally(() => setChecked(true));
  }, []);

  if (!checked) {
    // A lone 8×40 bar floating in the middle of a black page is not a loading
    // state, it is a glitch. The gate resolves to the sign-in card far more
    // often than not, so take that shape.
    return <AuthGateSkeleton />;
  }
  if (!me) return <SignIn onDone={setMe} />;
  return (
    <ToastHost>
      <Shell me={me} onSignOut={() => setMe(null)} />
    </ToastHost>
  );
}

function SignIn({ onDone }: { onDone: (u: Me) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await backlex.auth.signIn({ email, password });
      onDone(r.user as Me);
    } catch (e2) {
      setErr(errText(e2) || "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-surface border border-line bg-panel p-6">
        <div>
          <h1 className="text-lg font-semibold">Storefront admin</h1>
          <p className="mt-1 text-sm text-ink-dim">Signs into the backlex control plane, not the shop's customer pool.</p>
        </div>
        <Field label="Email">
          <input
            className={inputCls}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="username"
          />
        </Field>
        <Field label="Password">
          <input
            className={inputCls}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
        {err ? <p className="rounded-control border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{err}</p> : null}
        <Button type="submit" variant="primary" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}

function Shell({ me, onSignOut }: { me: NonNullable<Me>; onSignOut: () => void }) {
  const [path, go] = useRoute();
  const [navOpen, setNavOpen] = useState(false);
  const seg = segments(path);
  const root = seg[0] ?? "";

  useEffect(() => {
    setNavOpen(false);
  }, [path]);

  let page = <Dashboard go={go} />;
  if (root === "products") page = seg[1] ? <ProductDetail id={seg[1]} go={go} /> : <Products go={go} />;
  else if (root === "orders") page = seg[1] ? <OrderDetail id={seg[1]} go={go} /> : <Orders go={go} />;
  else if (root === "customers") page = <Customers go={go} />;
  else if (root === "inventory") page = <Inventory />;
  else if (root === "discounts") page = <Discounts />;
  else if (root === "pricing") page = <Pricing />;

  return (
    <div className="flex min-h-full">
      <aside
        className={cx(
          "fixed inset-y-0 left-0 z-40 w-60 shrink-0 border-r border-line bg-panel p-3 transition-transform lg:static lg:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="px-2 py-2">
          <Brand />
        </div>
        <nav className="mt-2 space-y-0.5">
          {NAV.map((n) => {
            const active = n.to === "/" ? path === "/" : path.startsWith(n.to);
            return (
              <a
                key={n.to}
                href={`#${n.to}`}
                className={cx(
                  "flex items-center gap-2.5 rounded-control px-2.5 py-2 text-sm transition",
                  active ? "bg-brand/15 text-brand-ink" : "text-ink-muted hover:bg-raised hover:text-ink",
                )}
              >
                <Icon name={n.icon} className="shrink-0" />
                {n.label}
              </a>
            );
          })}
        </nav>
        <div className="absolute inset-x-3 bottom-3 border-t border-line pt-3 text-xs text-ink-dim">
          <p className="truncate">{me.email}</p>
          <button
            type="button"
            className="mt-1 flex items-center gap-1.5 text-ink-muted transition hover:text-ink"
            onClick={async () => {
              await backlex.auth.signOut().catch(() => {});
              onSignOut();
            }}
          >
            <Icon name="signOut" size={14} />
            Sign out
          </button>
        </div>
      </aside>
      {navOpen ? <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setNavOpen(false)} /> : null}

      <div className="min-w-0 flex-1">
        {/* Mobile: the nav toggle hugs the right edge. */}
        <div className="flex items-center justify-between border-b border-line px-4 py-2 lg:hidden">
          <Brand />
          <Button variant="ghost" onClick={() => setNavOpen((v) => !v)} title="Menu">
            <Icon name={navOpen ? "close" : "menu"} />
          </Button>
        </div>
        <main className="mx-auto w-full max-w-7xl p-4 sm:p-6">{page}</main>
      </div>
    </div>
  );
}
