/**
 * The shell: an auth gate on the control plane, a nav rail, and a hash router.
 */
import { useEffect, useState, type FormEvent } from "react";
import { backlex } from "./lib/backlex";
import { ToastHost, errText } from "./lib/hooks";
import { segments, useRoute } from "./lib/router";
import { AuthGateSkeleton, Button, cx, Field, Icon, inputCls, type IconName } from "@backlex-examples/shared";
import { Dashboard } from "./pages/Dashboard";
import { Orders } from "./pages/Orders";
import { OrderDetail } from "./pages/OrderDetail";
import { Fulfillment } from "./pages/Fulfillment";
import { WaveDetail } from "./pages/WaveDetail";
import { Stock } from "./pages/Stock";
import { Shipments } from "./pages/Shipments";
import { Customers } from "./pages/Customers";
import { Campaigns } from "./pages/Campaigns";

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: "/", label: "Panel", icon: "dashboard" },
  { to: "/orders", label: "Siparişler", icon: "orders" },
  { to: "/fulfillment", label: "Hazırlık", icon: "picking" },
  { to: "/stock", label: "Stok", icon: "inventory" },
  { to: "/shipments", label: "Sevkiyat", icon: "shipments" },
  { to: "/customers", label: "Müşteriler", icon: "customers" },
  { to: "/campaigns", label: "Kampanyalar", icon: "campaigns" },
];

/** The warehouse's own mark — drawn, so it tints and scales with the shell. */
function Brand() {
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid size-7 shrink-0 place-items-center rounded-control bg-brand text-on-brand">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M4 15V5l12 10V5" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      Depo &amp; Sevkiyat
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
    // Takes the shape of the sign-in card, not a lone bar on an empty page.
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
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await backlex.auth.signIn({ email, password });
      onDone((r.user as Me) ?? null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-surface border border-line bg-panel p-6">
        <div>
          <h1 className="text-lg font-semibold">Depo & Sevkiyat</h1>
          <p className="mt-1 text-sm text-ink-muted">Operasyon konsoluna giriş yapın.</p>
        </div>
        <Field label="E-posta">
          <input
            className={inputCls}
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="Parola">
          <input
            className={inputCls}
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        {error ? <p className="text-sm text-bad">{error}</p> : null}
        <Button type="submit" variant="primary" disabled={busy} className="w-full">
          {busy ? "Giriş yapılıyor…" : "Giriş yap"}
        </Button>
      </form>
    </div>
  );
}

function Shell({ me, onSignOut }: { me: NonNullable<Me>; onSignOut: () => void }) {
  const [path, go] = useRoute();
  const [navOpen, setNavOpen] = useState(false);
  const seg = segments(path);
  const root = `/${seg[0] ?? ""}`;

  useEffect(() => setNavOpen(false), [path]);

  let page: React.ReactNode;
  if (seg.length === 0) page = <Dashboard go={go} />;
  else if (seg[0] === "orders") page = seg[1] ? <OrderDetail id={seg[1]} go={go} /> : <Orders go={go} />;
  else if (seg[0] === "fulfillment") page = seg[1] ? <WaveDetail id={seg[1]} go={go} /> : <Fulfillment go={go} />;
  else if (seg[0] === "stock") page = <Stock />;
  else if (seg[0] === "shipments") page = <Shipments go={go} />;
  else if (seg[0] === "customers") page = <Customers go={go} />;
  else if (seg[0] === "campaigns") page = <Campaigns />;
  else page = <div className="text-ink-muted">Sayfa bulunamadı.</div>;

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3 md:hidden">
        <Brand />
        {/* Nav toggle hugs the right edge on mobile — the house convention. */}
        <Button variant="ghost" className="ml-auto" onClick={() => setNavOpen((v) => !v)} title="Menü">
          <Icon name={navOpen ? "close" : "menu"} />
        </Button>
      </div>

      <nav
        className={cx(
          "shrink-0 border-line md:w-56 md:border-r",
          navOpen ? "block border-b" : "hidden md:block",
        )}
      >
        <div className="hidden px-4 py-4 md:block">
          <Brand />
        </div>
        <ul className="px-2 py-2">
          {NAV.map((n) => (
            <li key={n.to}>
              <a
                href={`#${n.to}`}
                className={cx(
                  "flex items-center gap-2 rounded-control px-3 py-2 text-sm transition",
                  root === n.to ? "bg-raised font-medium" : "text-ink hover:bg-raised hover:text-ink",
                )}
              >
                <Icon name={n.icon} className="shrink-0 text-ink-dim" />
                {n.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="mt-auto px-4 py-3 text-xs text-ink-dim">
          <p className="truncate">{me.email}</p>
          <button
            type="button"
            className="mt-1 underline underline-offset-2 hover:text-ink"
            onClick={async () => {
              await backlex.auth.signOut().catch(() => {});
              onSignOut();
            }}
          >
            Çıkış
          </button>
        </div>
      </nav>

      <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-6">{page}</main>
    </div>
  );
}
