/**
 * ldapts-backed LDAP / Active Directory adapter. See
 * packages/core/src/adapters/ldap.ts for the contract.
 *
 * Implementation notes:
 *
 *   - **RFC 4515 escaping** on the username BEFORE substituting `{{username}}`
 *     into `userFilter`. Defends against `alice)(uid=*` style injection.
 *   - **AD `memberOf;range=` pagination**: when the directory returns a
 *     ranged result like `memberOf;range=0-1499` (which AD does past 1500
 *     groups), iteratively re-query with the next range until exhausted.
 *   - **No connection pooling**: connect-per-request. Cheap with ldapts, and
 *     pools can't survive cold isolate restarts anyway.
 *   - **No referral following**: directories are sometimes misconfigured to
 *     emit cross-domain referrals; chasing them is a SSRF risk.
 *   - **Close in `finally`**: even on errors we always unbind to avoid
 *     leaking sockets on transport hiccups.
 *
 * The implementation is structured so tests can inject a fake `Client`
 * factory via {@link ldaptsLdapAdapter}'s `clientFactory` option without
 * touching the real ldapts package.
 */
import { Client as RealLdapClient } from "ldapts";
import type { LdapAdapter, LdapAttributes } from "@workeros/core/adapters";

/**
 * Configuration handed to {@link ldaptsLdapAdapter}. The service decrypts the
 * `bindPassword` + optional `caPem` from the database row before calling here.
 */
export interface LdapSpec {
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  /** `{{username}}` is substituted (after RFC 4515 escaping). */
  userFilter: string;
  /** Optional group-membership search filter. Most directories (AD especially)
   *  expose `memberOf` on the user entry directly — leave undefined and the
   *  adapter will read that attribute instead. */
  groupFilter?: string;
  attributeMap: {
    email: string;
    firstName: string;
    lastName: string;
    groups: string;
  };
  tls?: {
    rejectUnauthorized?: boolean;
    /** Custom CA PEM (decrypted) for self-signed LDAPS endpoints. */
    caPem?: string;
  };
}

/**
 * Minimal subset of the `ldapts.Client` surface the adapter uses — keeps the
 * shape narrow enough that tests can inject a fake without dragging the real
 * package's typings in.
 */
export interface LdapClientLike {
  bind(dn: string, password: string): Promise<void>;
  unbind(): Promise<void>;
  search(
    baseDn: string,
    options: {
      scope: "sub" | "base" | "one";
      filter: string;
      attributes?: string[];
      paged?: boolean;
      sizeLimit?: number;
    },
  ): Promise<{ searchEntries: Array<Record<string, unknown>> }>;
}

export type LdapClientFactory = (opts: {
  url: string;
  tlsOptions?: { rejectUnauthorized?: boolean; ca?: string };
}) => LdapClientLike;

/**
 * RFC 4515 special-character escaping for LDAP filter strings. Used on the
 * username before substituting into `userFilter`. The five characters with
 * special meaning inside a filter — `*`, `(`, `)`, `\` and the NUL byte —
 * become their `\xx` hex sequence.
 *
 * This is the standard defence against filter injection (e.g.
 * `alice)(uid=*` collapsing the filter to match all users).
 */
export const escapeLdapFilter = (input: string): string => {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    if (ch === 0x2a /* * */) out += "\\2a";
    else if (ch === 0x28 /* ( */) out += "\\28";
    else if (ch === 0x29 /* ) */) out += "\\29";
    else if (ch === 0x5c /* \ */) out += "\\5c";
    else if (ch === 0x00 /* NUL */) out += "\\00";
    else out += input[i];
  }
  return out;
};

/** Decode an attribute value (which ldapts returns as `string | Buffer | …`)
 *  into a UTF-8 string. */
const toStr = (v: unknown): string | undefined => {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  if (v == null) return undefined;
  return String(v);
};

const toStrArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(toStr).filter((s): s is string => !!s);
  const one = toStr(v);
  return one ? [one] : [];
};

/** Find the actual returned attribute name on an entry, supporting AD's
 *  `<name>;range=lo-hi` ranged-result syntax. Returns the key + the parsed
 *  range high-end (or `*` for "all done"). */
const findRangedAttr = (
  entry: Record<string, unknown>,
  name: string,
): { key: string; rangeHigh: string } | { key: string; rangeHigh: null } | null => {
  const lower = name.toLowerCase();
  for (const k of Object.keys(entry)) {
    if (k.toLowerCase() === lower) return { key: k, rangeHigh: null };
    const lk = k.toLowerCase();
    if (lk.startsWith(`${lower};range=`)) {
      const range = lk.slice(`${lower};range=`.length);
      const high = range.split("-")[1] ?? "*";
      return { key: k, rangeHigh: high };
    }
  }
  return null;
};

/**
 * Read `groupsAttr` off the user entry, including AD's ranged-result pages.
 * Issues additional base-scoped searches against the user's DN with
 * `groupsAttr;range=<next>-*` until the directory returns `;range=…-*`
 * (meaning "no more pages") or a search returns no rows.
 */
const collectGroups = async (
  client: LdapClientLike,
  userDn: string,
  groupsAttr: string,
  initialEntry: Record<string, unknown>,
): Promise<string[]> => {
  const acc: string[] = [];
  let entry: Record<string, unknown> = initialEntry;
  // Loop until we hit a "no more pages" marker or the directory stops returning
  // a ranged form. A safety cap of 10 iterations keeps a misbehaving directory
  // from looping forever — 10 × 1500 = 15 000 groups per user is well beyond
  // any practical AD deployment.
  for (let iter = 0; iter < 10; iter++) {
    const found = findRangedAttr(entry, groupsAttr);
    if (!found) return acc;
    acc.push(...toStrArray(entry[found.key]));
    if (found.rangeHigh === null) return acc; // unranged → got everything
    if (found.rangeHigh === "*") return acc; // AD marker for "last page"
    const nextLow = Number(found.rangeHigh) + 1;
    if (!Number.isFinite(nextLow)) return acc;
    // Re-query the user entry with the next range slice.
    const result = await client.search(userDn, {
      scope: "base",
      filter: "(objectClass=*)",
      attributes: [`${groupsAttr};range=${nextLow}-*`],
    });
    const next = result.searchEntries[0];
    if (!next) return acc;
    entry = next;
  }
  return acc;
};

/**
 * Build an LDAP adapter bound to a single directory + service account. Each
 * `authenticate` call opens a fresh connection — there is no pooling.
 *
 * `clientFactory` exists for testing: pass a factory that returns a
 * {@link LdapClientLike} stand-in and the adapter will use it instead of the
 * real `ldapts.Client`.
 */
export const ldaptsLdapAdapter = (
  spec: LdapSpec,
  options: { clientFactory?: LdapClientFactory } = {},
): LdapAdapter => {
  const tlsOptions: { rejectUnauthorized?: boolean; ca?: string } | undefined =
    spec.tls
      ? {
          ...(spec.tls.rejectUnauthorized !== undefined
            ? { rejectUnauthorized: spec.tls.rejectUnauthorized }
            : {}),
          ...(spec.tls.caPem ? { ca: spec.tls.caPem } : {}),
        }
      : undefined;

  const factory: LdapClientFactory =
    options.clientFactory ??
    (({ url, tlsOptions }) =>
      new RealLdapClient({ url, tlsOptions }) as unknown as LdapClientLike);

  return {
    async authenticate(username, password): Promise<LdapAttributes | null> {
      if (!username || !password) return null;
      const escaped = escapeLdapFilter(username);
      const filter = spec.userFilter.replaceAll("{{username}}", escaped);
      const attributes = [
        "dn",
        spec.attributeMap.email,
        spec.attributeMap.firstName,
        spec.attributeMap.lastName,
        spec.attributeMap.groups,
      ];

      // Service-bind connection — used for the search.
      const search = factory({ url: spec.url, tlsOptions });
      let userEntry: Record<string, unknown> | undefined;
      let userDn: string | undefined;
      try {
        await search.bind(spec.bindDn, spec.bindPassword);
        const result = await search.search(spec.baseDn, {
          scope: "sub",
          filter,
          attributes,
          sizeLimit: 2,
        });
        // Multiple matches is a configuration error; treat as no match.
        if (result.searchEntries.length !== 1) {
          return null;
        }
        userEntry = result.searchEntries[0];
        userDn = toStr(userEntry?.dn);
      } finally {
        try {
          await search.unbind();
        } catch {
          // Best effort — already closed or transport gone.
        }
      }
      if (!userEntry || !userDn) return null;

      // User-bind connection — the actual authentication.
      const userClient = factory({ url: spec.url, tlsOptions });
      try {
        try {
          await userClient.bind(userDn, password);
        } catch {
          // Invalid credentials — bad bind on a valid DN. Return null without
          // distinguishing from "no such user" so the caller can't enumerate.
          return null;
        }
      } finally {
        try {
          await userClient.unbind();
        } catch {
          // ignore
        }
      }

      // Read the group set (with AD `;range=` pagination if applicable). We do
      // this on a fresh service-bound connection so the user-bind one stays
      // narrowly scoped to "did the password work".
      let groups: string[] = [];
      if (spec.attributeMap.groups) {
        const groupClient = factory({ url: spec.url, tlsOptions });
        try {
          await groupClient.bind(spec.bindDn, spec.bindPassword);
          groups = await collectGroups(
            groupClient,
            userDn,
            spec.attributeMap.groups,
            userEntry,
          );
        } catch {
          // Group lookup failures shouldn't fail the login — log and move on.
          // Tests assert that bad creds are handled separately above.
          groups = toStrArray(userEntry[spec.attributeMap.groups]);
        } finally {
          try {
            await groupClient.unbind();
          } catch {
            // ignore
          }
        }
      }

      return {
        dn: userDn,
        email: toStr(extractScalar(userEntry, spec.attributeMap.email)),
        firstName: toStr(extractScalar(userEntry, spec.attributeMap.firstName)),
        lastName: toStr(extractScalar(userEntry, spec.attributeMap.lastName)),
        groups,
      };
    },
  };
};

const extractScalar = (entry: Record<string, unknown>, key: string): unknown => {
  if (!key) return undefined;
  // Case-insensitive lookup so a user-typed `Mail` still matches `mail`.
  const lower = key.toLowerCase();
  for (const k of Object.keys(entry)) {
    if (k.toLowerCase() === lower) {
      const v = entry[k];
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
};
