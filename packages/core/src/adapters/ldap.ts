/**
 * LDAP / Active Directory authentication adapter contract.
 *
 * The flow is the classic "service-bind, then user-bind":
 *
 *   1. Bind to the directory as the service account (`bindDn` + bind password).
 *   2. Search `baseDn` with `userFilter` substituted (after RFC-4515 escaping
 *      the username) to find the user entry.
 *   3. Bind again as that DN with the supplied password — success here is
 *      the authentication.
 *   4. Read the configured attributes (email / firstName / lastName / groups).
 *
 * All mutation (provisioning, sessions, rate limiting) happens *outside* the
 * adapter, in the route layer. The adapter is stateless and runtime-agnostic.
 */

export interface LdapAttributes {
  /** Full DN of the bound user entry — used as
   *  `external_identities.subject`. */
  dn: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  groups?: string[];
}

export interface LdapAdapter {
  /**
   * Service-bind, search by `userFilter`, then user-bind with the password.
   * Returns `null` on bad credentials or no matching entry (authentication
   * failure — caller maps to 401 without distinguishing the two). Throws
   * only on transport-level errors (TLS handshake failed, host unreachable,
   * etc.), which the caller maps to 503/500.
   */
  authenticate(username: string, password: string): Promise<LdapAttributes | null>;
}
