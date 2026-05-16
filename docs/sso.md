# SSO (SAML 2.0)

workeros supports per-tenant SAML 2.0 SSO for the **workspace end-user pool**
(the `app_users` table, served via `/api/t/<slug>/auth/*`). The admin app
itself stays on the existing `/api/auth/*` better-auth surface.

> Phase 2 will add LDAP. The data layer (`external_identities`) is already
> shaped so an LDAP login lands in the same row store as SAML.

## How it fits together

```
+-------------+      AuthnRequest      +-------------+      SAMLResponse      +----------------+
|             | ---------------------> |             | <--------------------- |                |
|  customer   |                        |    IdP      |                        |    workeros    |
|  end-user   | <--------------------- | (Okta etc)  | -- 302 to ACS POST --> |  (workspace SP)|
|             |  sign-in form          |             |                        |                |
+-------------+                        +-------------+                        +----------------+
                                                                                       |
                                                                                       v
                                                                          provision app_user,
                                                                          issue app_session,
                                                                          302 to RelayState
                                                                          with #token=...
```

URL pattern, per workspace + provider slug:

| Purpose             | URL                                                                        |
|---------------------|----------------------------------------------------------------------------|
| SP-initiated login  | `${APP_URL}/api/t/<slug>/auth/saml/<provider-slug>/login?relayState=…`     |
| Assertion Consumer  | `${APP_URL}/api/t/<slug>/auth/saml/<provider-slug>/acs` (HTTP-POST)        |
| SP metadata XML     | `${APP_URL}/api/t/<slug>/auth/saml/<provider-slug>/metadata`               |
| SLO                 | `${APP_URL}/api/t/<slug>/auth/saml/<provider-slug>/slo`                    |

The slug part of the URL is the workspace slug (e.g. `default`), and the
provider slug is the one you choose when creating the SAML provider in the
admin UI (`Authentication → Add SAML`).

## Configure an IdP

The admin dialog has three tabs:

1. **From template** — pick Okta / Azure / Google / ADFS / JumpCloud / Auth0.
   The attribute map (`email`, `firstName`, `lastName`, `groups`) pre-fills
   with that vendor's defaults.
2. **Import metadata** — paste the IdP's metadata XML or its URL; we pull
   out the entityID, SSO URL, SLO URL, and signing cert.
3. **Manual entry** — type every field.

The signing cert is stored encrypted (AES-256-GCM via `AUTH_SECRET`); we
only ever decrypt it inside `resolveSamlProvider`, never return it.

### Okta

1. Okta admin → **Applications** → **Create App Integration** → SAML 2.0.
2. Single Sign On URL: paste the ACS URL from the workeros admin dialog
   (`Authentication → SAML provider → ACS URL`).
3. Audience URI (SP Entity ID): paste the SP entity id (= metadata URL by
   default).
4. Name ID format: `EmailAddress` (matches our default).
5. Attribute Statements: add `email`, `firstName`, `lastName`, and
   (optionally) `groups`. Use the names from the attribute-map fields in
   the workeros dialog.
6. Okta will give you a metadata URL — paste it into the workeros
   dialog's **Import metadata** tab and click **Fetch & parse**.

### Azure AD / Entra ID

1. Microsoft Entra admin → **Enterprise applications** → **New application**
   → **Create your own application** → **Non-gallery**.
2. Single Sign-On → SAML.
3. Identifier (Entity ID): paste the SP entity id.
4. Reply URL (ACS): paste the ACS URL.
5. Attributes: keep the default `http://schemas.xmlsoap.org/…` namespace —
   the workeros **Azure AD / Entra ID** template maps those already.
6. Download the **Federation Metadata XML** and import it via the dialog,
   or paste the SAML Signing Certificate (Base64) into the manual tab.

### Google Workspace

1. Workspace admin → **Apps** → **Web and mobile apps** → **Add app** →
   **Add custom SAML app**.
2. Download the metadata file Google offers; paste into the dialog's
   **Import metadata** tab.
3. Service provider details: ACS URL = the workeros ACS URL; Entity ID =
   SP entity id; Name ID format = `EMAIL`.
4. Attribute mapping: map `Primary email` → `email`, `First name` →
   `first_name`, `Last name` → `last_name`. The workeros **Google
   Workspace** template uses those keys.

## Security knobs

- **`linkByVerifiedEmail`** (off by default): when on, an existing app-user
  with the same email is linked to the SAML subject on first login. This
  makes a hostile IdP an account-takeover vector for any local account
  sharing an email; only enable it for IdPs you actually trust.
- **`wantSignedAssertions`** (on by default): rejects unsigned Assertions.
- **Replay protection**: every AssertionID lands in `app_verifications`
  until `NotOnOrAfter`. A second POST of the same Assertion before then
  is rejected with 401.
- **`InResponseTo`**: SP-initiated logins persist the AuthnRequest id in
  `app_verifications`; the ACS handler rejects responses whose
  `InResponseTo` doesn't match a known request.
- **`relayState`**: validated against `auth_config.redirectUrls` before
  every redirect (open-redirect protection).

## Group → role sync

Set `groupsToRoles` on a provider (admin UI field reserved for v2 — for
now use the JSON `attributeMap`/`groupsToRoles` columns directly). On
each login the provisioner snapshots the assigned roles on
`external_identities.rolesFromGroups`; the diff against the prior
snapshot drives the role-add and role-remove calls. Manual role
assignments aren't touched.

## Troubleshooting

- **"SAML audience mismatch"** → the IdP set `Audience` to a different
  value than the workeros SP entity id. Set the IdP's Audience URI / Entity
  ID to the SP entity id printed in the admin dialog.
- **"SAML issuer mismatch"** → the IdP's `<Issuer>` doesn't match the
  configured `entityId`. Copy the IdP entity id exactly from its metadata.
- **"SAML verification failed: digest mismatch"** → the IdP isn't signing
  with the cert we have on file (e.g. rotated cert, wrong cert). Re-paste
  the current cert via the dialog's manual tab.
- **Replay rejected immediately after IdP redirect** → can happen when the
  same browser tab re-POSTs the form (e.g. devtools "preserve log" re-fires
  a request). Treat as the design: re-initiate by hitting the `/login`
  endpoint again.
- **Clock skew** → samlify enforces `NotBefore` / `NotOnOrAfter`. If your
  IdP or workeros host is more than ~5 min off NTP, fix that first.
- **Cert format** → must be PEM (`-----BEGIN CERTIFICATE-----…`). DER
  binary or `.crt` with Windows line endings: re-export as PEM.
- **Cloudflare Workers runtime** — samlify imports `xml-crypto` which uses
  `node:crypto`. Workers expose those under `nodejs_compat`
  (`apps/web/wrangler.toml`); deploying without that flag will fail at boot.
