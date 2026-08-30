/**
 * The shell: an auth gate on the control plane, a nav rail, and a hash router.
 */
import { useEffect, useState, type FormEvent } from "react";
import { backlex } from "./lib/backlex";
import { ToastHost, errText } from "./lib/hooks";
import { segments, useRoute } from "./lib/router";
import { Button, Field, inputCls, cx } from "./lib/ui";
import { Dashboard } from "./pages/Dashboard";
import { Orders } from "./pages/Orders";
import { OrderDetail } from "./pages/OrderDetail";
import { Fulfillment } from "./pages/Fulfillment";
import { WaveDetail } from "./pages/WaveDetail";
import { Stock } from "./pages/Stock";
import { Shipments } from "./pages/Shipments";
import { Customers } from "./pages/Customers";
import { Campaigns } from "./pages/Campaigns";

const NAV = [
  { to: "/", label: "Panel", icon: "▦" },
  { to: "/orders", label: "Siparişler", icon: "▤" },
  { to: "/fulfillment", label: "Hazırlık", icon: "◧" },
  { to: "/stock", label: "Stok", icon: "▥" },
  { to: "/shipments", label: "Sevkiyat", icon: "➤" },
  { to: "/customers", label: "Müşteriler", icon: "◍" },
  { to: "/campaigns", label: "Kampanyalar", icon: "◆" },
];

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
    return (
      <div className="grid h-full place-items-center">
        <div className="h-8 w-40 animate-pulse rounded bg-white/10" />
      </div>
    );
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
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <div>
          <h1 className="text-lg font-semibold">Depo & Sevkiyat</h1>
          <p className="mt-1 text-sm text-white/50">Operasyon konsoluna giriş yapın.</p>
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
        {error ? <p className="text-sm text-red-300">{error}</p> : null}
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
  else page = <div className="text-white/60">Sayfa bulunamadı.</div>;

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 md:hidden">
        <span className="font-semibold">Depo & Sevkiyat</span>
        {/* Nav toggle hugs the right edge on mobile — the house convention. */}
        <Button variant="ghost" className="ml-auto" onClick={() => setNavOpen((v) => !v)} title="Menü">
          {navOpen ? "✕" : "☰"}
        </Button>
      </div>

      <nav
        className={cx(
          "shrink-0 border-white/10 md:w-56 md:border-r",
          navOpen ? "block border-b" : "hidden md:block",
        )}
      >
        <div className="hidden px-4 py-4 md:block">
          <span className="font-semibold">Depo & Sevkiyat</span>
        </div>
        <ul className="px-2 py-2">
          {NAV.map((n) => (
            <li key={n.to}>
              <a
                href={`#${n.to}`}
                className={cx(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition",
                  root === n.to ? "bg-white/10 font-medium" : "text-white/65 hover:bg-white/5 hover:text-white",
                )}
              >
                <span aria-hidden className="text-white/40">
                  {n.icon}
                </span>
                {n.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="mt-auto px-4 py-3 text-xs text-white/40">
          <p className="truncate">{me.email}</p>
          <button
            type="button"
            className="mt-1 underline underline-offset-2 hover:text-white/70"
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
