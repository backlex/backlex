/**
 * @module
 *
 * Where an app-mode session token lives between page loads.
 *
 * Every SPA example in this repository had written the same twenty lines:
 * read a token out of `localStorage` on boot, hand it to `createClient`, and
 * remember to write it back after each sign-in and clear it on sign-out. The
 * third of those is the one that gets forgotten, and the symptom is a session
 * that works until the tab is reloaded.
 *
 * A store is two functions, so the interesting cases are all expressible: a
 * cookie the server can read during SSR, `sessionStorage` for a kiosk, an
 * encrypted store in a native shell, or nothing at all on a server where the
 * token belongs to one request rather than to the process.
 *
 * Nothing here touches a browser global at module scope. These factories run
 * in workerd, Bun and Node as readily as in a browser, and each one degrades
 * to a no-op where its backing store does not exist — a client configured to
 * persist on a server keeps working, it simply forgets.
 *
 * ## What persisting a token costs
 *
 * A session token kept anywhere script can read — `localStorage`,
 * `sessionStorage`, or a cookie written from the page — is readable by any
 * script that gets to run on the origin. Persisting a session and being immune
 * to cross-site scripting are not both available to a browser application, and
 * a store here cannot pretend otherwise: none of them can set `HttpOnly`,
 * because a cookie the page can write is one the page can read.
 *
 * So the trade is stated rather than hidden. `sessionStorage` narrows the
 * window to a tab; `memoryTokens` narrows it to a page view and signs the user
 * out on every reload. What actually reduces the exposure is upstream — a
 * strict Content-Security-Policy, and short token lifetimes so a stolen one
 * expires. For a session that script must not be able to read at all, the
 * cookie plane is the answer: sign in without `workspace` set and let the
 * server issue an `HttpOnly` cookie, which is what the admin console does.
 */

/** Somewhere a session token can be kept and found again. */
export interface TokenStore {
  /** The stored token, or `null` if there is none. Never throws. */
  get(): string | null;
  /** Store a token, or clear it when passed `null`. Never throws. */
  set(token: string | null): void;
}

/** The default key. Namespaced so two workspaces on one origin do not collide. */
const keyFor = (workspace?: string) =>
  workspace ? `backlex.token.${workspace}` : "backlex.token";

/** Keeps the token for the lifetime of the client and no longer. */
export const memoryTokens = (): TokenStore => {
  let token: string | null = null;
  return {
    get: () => token,
    set: (t) => {
      token = t;
    },
  };
};

/**
 * A `Storage`-backed store. Reads are guarded because a browser can refuse
 * `localStorage` outright — Safari in private mode, and any page under a
 * storage-partitioning policy, throw on ACCESS rather than returning null. A
 * client that fell over there would fail at `createClient`, before the app had
 * rendered anything that could explain why.
 */
const webStorageTokens = (pick: () => Storage | undefined, key: string): TokenStore => ({
  get: () => {
    try {
      return pick()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set: (token) => {
    try {
      const store = pick();
      if (!store) return;
      if (token === null) store.removeItem(key);
      else store.setItem(key, token);
    } catch {
      /* storage refused — the session simply does not survive a reload */
    }
  },
});

/** Survives reloads and browser restarts. The default for `persist: true`. */
export const localStorageTokens = (opts: { workspace?: string; key?: string } = {}): TokenStore =>
  webStorageTokens(
    () => (typeof localStorage === "undefined" ? undefined : localStorage),
    opts.key ?? keyFor(opts.workspace),
  );

/** Survives reloads, dies with the tab. */
export const sessionStorageTokens = (opts: { workspace?: string; key?: string } = {}): TokenStore =>
  webStorageTokens(
    () => (typeof sessionStorage === "undefined" ? undefined : sessionStorage),
    opts.key ?? keyFor(opts.workspace),
  );

/**
 * A cookie, so a server rendering the next page can read the session too.
 *
 * `httpOnly` is deliberately not offered: this store runs in the browser and a
 * cookie it can write is a cookie script can read, so claiming otherwise would
 * be a security property that is not there. What it does give is a token the
 * SERVER sees on the next navigation, which is the whole reason to choose a
 * cookie over `localStorage`.
 *
 * Defaults are the conservative ones — `SameSite=Lax` (sent on top-level
 * navigation, which is exactly the SSR case, and withheld from cross-site
 * subrequests) and `Secure` on anything that is not localhost.
 */
export const cookieTokens = (
  opts: {
    workspace?: string;
    name?: string;
    maxAgeSeconds?: number;
    path?: string;
    sameSite?: "Lax" | "Strict" | "None";
    secure?: boolean;
  } = {},
): TokenStore => {
  const name = opts.name ?? keyFor(opts.workspace).replace(/\./g, "_");
  const path = opts.path ?? "/";
  const sameSite = opts.sameSite ?? "Lax";
  const maxAge = opts.maxAgeSeconds ?? 60 * 60 * 24 * 30;
  const secure =
    opts.secure ??
    (typeof location === "undefined" ? true : location.protocol === "https:");

  const doc = (): { cookie: string } | undefined =>
    typeof document === "undefined" ? undefined : (document as unknown as { cookie: string });

  return {
    get: () => {
      const jar = doc()?.cookie;
      if (!jar) return null;
      for (const part of jar.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() !== name) continue;
        // Written encoded, so a token containing `;` or `=` round-trips.
        try {
          // An empty value is an absent token, not a token that is the empty
          // string — a cleared cookie can linger as `name=` rather than
          // disappearing, and a caller must not treat that as a session.
          return decodeURIComponent(part.slice(eq + 1).trim()) || null;
        } catch {
          return null;
        }
      }
      return null;
    },
    set: (token) => {
      const d = doc();
      if (!d) return;
      const attrs = [
        `Path=${path}`,
        `SameSite=${sameSite}`,
        ...(secure || sameSite === "None" ? ["Secure"] : []),
      ];
      d.cookie =
        token === null
          ? `${name}=; Max-Age=0; ${attrs.join("; ")}`
          : `${name}=${encodeURIComponent(token)}; Max-Age=${maxAge}; ${attrs.join("; ")}`;
    },
  };
};

/**
 * What `persist: true` means: the best store this runtime actually has.
 *
 * On a server that is memory, which forgets when the process does — the right
 * answer, because a token there belongs to one request and writing it
 * somewhere process-wide would hand one caller's session to the next.
 */
export const defaultTokenStore = (workspace?: string): TokenStore =>
  typeof localStorage === "undefined" ? memoryTokens() : localStorageTokens({ workspace });

/** Normalize the `persist` option into a store, or `null` for "do not persist". */
export const resolveTokenStore = (
  persist: boolean | TokenStore | undefined,
  workspace?: string,
): TokenStore | null => {
  if (!persist) return null;
  return persist === true ? defaultTokenStore(workspace) : persist;
};
