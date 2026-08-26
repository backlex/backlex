# Changelog

## 0.1.0

- **Organizations.** New `org` option (and a settable `client.org`) sends
  `X-Backlex-Org`, so `$org.id` in permission rules resolves without threading
  it through every call. Settable at runtime, because an app picks its
  organization after sign-in rather than before.
- **Tracing.** Every request now carries a W3C `traceparent`, so the call shows
  up in the admin Traces panel and stitches to the server spans it triggers.
  On by default; pass `tracing: false` to opt out.

## 0.0.1

- Initial release. Official Dart client for the backlex API: CRUD, the canonical
  filter/query builder, auth (password, social, magic-link, email-OTP, password
  reset/refresh, account + session management), realtime (SSE), and storage.
