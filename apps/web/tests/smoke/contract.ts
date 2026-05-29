/**
 * Runtime-agnostic smoke scenario. Hits the backlex API over HTTP
 * (not via in-process `app.fetch`) so the same scenario can verify any
 * deployed runtime: Bun standalone, the pre-bundled Vercel function,
 * the pre-bundled Netlify function, or a remote URL.
 *
 * Scope is deliberately narrow — health, auth round-trip, cron secret
 * gate. The `bun test` suite already covers business-logic coverage
 * in-process; this contract exists to surface runtime-specific
 * regressions (URL reconstruction, env binding shape, cookie domain
 * handling, runtime-conditional adapter selection) that only appear
 * once the code is actually serving HTTP.
 */
const ORIGIN_HEADER = "Origin";

export interface SmokeOptions {
  baseUrl: string;
  /** When true, exercises `/api/_cron/tick` auth (vercel/netlify
   *  entries register it; the Bun entry doesn't). */
  checkCron: boolean;
}

export interface SmokeResult {
  passes: string[];
  failures: string[];
}

const pretty = (resp: Response, body: string) =>
  `${resp.status} ${resp.statusText} — ${body.slice(0, 200)}`;

export const runSmokeContract = async (
  opts: SmokeOptions,
): Promise<SmokeResult> => {
  const passes: string[] = [];
  const failures: string[] = [];
  const ok = (msg: string) => passes.push(msg);
  const fail = (msg: string) => failures.push(msg);

  const base = opts.baseUrl.replace(/\/$/, "");
  const cookieJar = new Map<string, string>();
  const cookieHeader = (): string =>
    [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

  const captureSetCookies = (resp: Response): void => {
    // Node 22+, Bun, and Deno all expose getSetCookie() on Headers.
    const setCookies = resp.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const first = sc.split(";")[0];
      if (!first) continue;
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (value === "" || value === "deleted") cookieJar.delete(name);
      else cookieJar.set(name, value);
    }
  };

  const call = (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has(ORIGIN_HEADER)) headers.set(ORIGIN_HEADER, base);
    if (cookieJar.size > 0) headers.set("Cookie", cookieHeader());
    return fetch(`${base}${path}`, { ...init, headers });
  };

  // 1. Health endpoint — proves the app booted and the DB adapter
  //    answered without throwing.
  try {
    const r = await call("/health");
    const body = await r.text();
    if (r.status === 200 && body.includes('"ok":true')) {
      ok(`/health 200`);
    } else {
      fail(`/health expected 200 ok:true, got ${pretty(r, body)}`);
    }
  } catch (e) {
    fail(`/health threw: ${String(e)}`);
  }

  // 2. Sign-up — random email per run keeps successive smoke runs
  //    against the same DB independent. better-auth returns 200 on
  //    successful sign-up (some versions return 201; accept both).
  const email = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "smoke-correct-horse-battery";
  try {
    const r = await call("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name: "Smoke User" }),
    });
    const body = await r.text();
    if (r.status === 200 || r.status === 201) {
      captureSetCookies(r);
      ok(`sign-up ${r.status}`);
    } else {
      fail(`sign-up expected 200/201, got ${pretty(r, body)}`);
    }
  } catch (e) {
    fail(`sign-up threw: ${String(e)}`);
  }

  // 3. Sign-in — verifies password verification path AND that the
  //    response sets a session cookie the next request can use.
  cookieJar.clear();
  try {
    const r = await call("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await r.text();
    if (r.status === 200) {
      captureSetCookies(r);
      if (cookieJar.size === 0) {
        fail(`sign-in 200 but no Set-Cookie returned (body: ${body.slice(0, 200)})`);
      } else {
        ok(`sign-in 200 (${cookieJar.size} cookie(s))`);
      }
    } else {
      fail(`sign-in expected 200, got ${pretty(r, body)}`);
    }
  } catch (e) {
    fail(`sign-in threw: ${String(e)}`);
  }

  // 4. get-session — proves the cookie round-trip resolves to a real
  //    user. Catches cookie-domain / SameSite regressions that only
  //    surface on real HTTP (not in-process app.fetch).
  try {
    const r = await call("/api/auth/get-session");
    const body = await r.text();
    if (r.status !== 200) {
      fail(`get-session expected 200, got ${pretty(r, body)}`);
    } else if (!body.includes(email)) {
      fail(`get-session 200 but response doesn't include sign-up email — session lost`);
    } else {
      ok(`get-session resolved user`);
    }
  } catch (e) {
    fail(`get-session threw: ${String(e)}`);
  }

  // 5. Cron secret gate — vercel/netlify entries register
  //    /api/_cron/tick with platform-specific auth shape. The bun
  //    entry runs cron via setInterval and doesn't expose the route,
  //    so this check is opt-in per runtime.
  if (opts.checkCron) {
    try {
      const r = await fetch(`${base}/api/_cron/tick`);
      if (r.status === 401) {
        ok(`/api/_cron/tick rejects unauthenticated`);
      } else {
        const body = await r.text();
        fail(
          `/api/_cron/tick expected 401 without secret, got ${pretty(r, body)} — public cron path!`,
        );
      }
    } catch (e) {
      fail(`/api/_cron/tick threw: ${String(e)}`);
    }
  }

  return { passes, failures };
};
