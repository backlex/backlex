---
title: Extensions
description: Installable extension packages — sandboxed admin panels, custom field editors, and server hooks from npm or a local directory.
---

Backlex admin panels and item forms can be extended with installable packages
— npm-published or pushed from a local directory. An extension bundles a
manifest plus a handful of self-contained files and can contribute three kinds
of things:

| Contribution | Where it shows up | How it runs |
|---|---|---|
| `panels` | New pages in the admin sidebar | Sandboxed iframe (opaque origin) |
| `fieldEditors` | Custom editors for item-form fields, keyed by interface id | Sandboxed iframe per field |
| `hooks` | Server-side code on item events or on demand | Functions sandbox (`docs/sandbox.md`) |

Extensions are workspace-scoped and admin-managed: **Settings → Extensions**
in the admin, `backlex extensions` on the CLI, `client.extensions.*` in the
SDK, `extensions.*` MCP tools, and the `extensions`/`installExtension`/…
GraphQL fields all drive the same `/api/extensions` service.

## Package format

An extension is a plain npm package (or directory) containing
`backlex-extension.json`:

```json
{
  "name": "color-swatch",
  "version": "1.0.0",
  "title": "Color Swatch",
  "description": "Pick colors visually instead of typing hex strings.",
  "contributes": {
    "panels": [
      { "id": "overview", "title": "Colors", "icon": "palette", "entry": "panel.html" }
    ],
    "fieldEditors": [
      { "interface": "color-swatch", "title": "Color Swatch", "types": ["text"], "entry": "editor.html" }
    ],
    "hooks": [
      { "id": "normalize", "trigger": "event", "pattern": "items:products", "entry": "hooks/normalize.js", "timeoutMs": 5000 },
      { "id": "digest", "trigger": "cron", "pattern": "0 8 * * *", "entry": "hooks/digest.js" }
    ]
  },
  "permissions": {
    "api": ["GET /api/items/*"]
  }
}
```

Rules:

- `name` and every id are lowercase slugs (`[a-z0-9-]`).
- `entry` files are **relative paths inside the package**; each must exist or
  the install is rejected. Only referenced entries are stored (1 MB/file cap;
  5 MB tarball cap).
- UI entries (`panel.html`, `editor.html`) render inside a sandboxed iframe
  with a `default-src 'none'` CSP — inline `<script>`/`<style>` only at
  runtime. You can still split source across files: same-package
  `<script src="./app.js">` and `<link rel="stylesheet" href="./base.css">`
  references are **inlined at install time** (external URLs and refs outside
  the package are left alone and blocked by the CSP by design). The inlined
  document must stay under the 1 MB cap.
- Hook entries are plain JS in the functions-sandbox dialect: no imports, the
  payload arrives as `ctx.data`, `return` a JSON-serializable value. Event
  hooks run with the system principal when a matching item event fires
  (`pattern` uses the same `items:<slug>:<event>` wildcard matching as event
  functions); `cron` hooks fire from the scheduler tick on their cron
  `pattern` (payload: `{firedAt, pattern}`, system principal, at-most-once
  per minute — same window semantics as cron functions); `manual` hooks run
  via the invoke endpoint/CLI/SDK/MCP or the page's Run-hook dialog.

## Installing

```bash
# from the npm registry (server-side fetch; version optional)
bun backlex extensions install backlex-ext-color --version 1.2.0

# local development loop: edit → push → reload the admin
bun backlex extensions push ./my-extension

bun backlex extensions list
bun backlex extensions disable color-swatch
bun backlex extensions uninstall color-swatch
bun backlex extensions invoke color-swatch normalize --data '{"a":1}'
```

The admin install dialog offers the same two paths — npm package name or a
local folder upload. Reinstalling an already-installed name upgrades it in
place. Installs go
through `POST /api/extensions/install` (npm) or `/upload` (file map) — the
server fetches the tarball itself, so the registry must be reachable from the
API runtime. Self-hosters can pin a private mirror with
`EXTENSIONS_NPM_REGISTRY` (defaults to `https://registry.npmjs.org`); tarball
downloads are refused if they resolve to a different host than the registry.

## The iframe bridge

Panels and field editors are iframed with `sandbox="allow-scripts"` and **no**
`allow-same-origin` — the document gets an opaque origin and can never read
the admin's cookies or DOM. All communication is `postMessage`:

| Direction | Message | Meaning |
|---|---|---|
| ext → admin | `{type:"backlex-ext:ready"}` | Handshake; admin replies with `init` |
| admin → ext | `{type:"backlex-ext:init", value, field, ctx}` | Current field value + field def (field editors) |
| ext → admin | `{type:"backlex-ext:value", value}` | Field editors: propagate a new value |
| ext → admin | `{type:"backlex-ext:resize", height}` | Field editors: fit the iframe to content |
| ext → admin | `{type:"backlex-ext:api", id, method, path, body}` | Proxied API call |
| admin → ext | `{type:"backlex-ext:api-result", id, ok, status, data}` | API call result |

API calls are executed by the admin page **with the signed-in user's
session**, but only when the manifest's `permissions.api` allow-list permits
the `(method, path)` — entries look like `"GET /api/items/posts"` or
`"* /api/items/*"` (trailing `*` = prefix match; paths must live under
`/api/`). No list, no API access. The user's own permissions still apply on
the server — the bridge can't grant anything the session couldn't do anyway.

Minimal field editor:

```html
<!doctype html>
<meta charset="utf-8" />
<input id="c" type="color" style="width:100%;height:40px;border:none" />
<script>
  const input = document.getElementById("c");
  window.addEventListener("message", (e) => {
    if (e.data?.type === "backlex-ext:init" && typeof e.data.value === "string")
      input.value = e.data.value;
  });
  input.addEventListener("input", () =>
    parent.postMessage({ type: "backlex-ext:value", value: input.value }, "*"));
  parent.postMessage({ type: "backlex-ext:ready" }, "*");
  parent.postMessage({ type: "backlex-ext:resize", height: 56 }, "*");
</script>
```

Assign the editor to a field by setting the field's `interface` to the
manifest's `fieldEditors[].interface` id (the schema tab lists extension
editors under an "Extensions" group, filtered by the `types` the editor
declares).

## Security model

- **UI code is untrusted.** Opaque-origin iframe + `default-src 'none'` CSP
  (inline script/style only) + the manifest-capped postMessage bridge is the
  entire attack surface. Extension UI never executes in the admin document.
- **Hook code is admin-trusted**, exactly like sandbox functions: it runs in
  the functions sandbox (QuickJS / bun-worker / remote executor — see
  `docs/sandbox.md` for the provider table and its soft-sandbox caveats).
  Installing an extension is an admin-only action for the same reason.
- Assets are served session-gated at `/api/extensions/<name>/assets/<path>`
  and 403 the moment the extension is disabled.
- Install caps: 5 MB tarball, 15 MB unpacked, 1 MB per stored file, 20
  contributions per kind.

## Surfaces

| Surface | Where |
|---|---|
| REST | `GET/POST /api/extensions`, `/install`, `/upload`, `PATCH/DELETE /{name}`, `POST /{name}/hooks/{hookId}/invoke`, `GET /{name}/assets/*` |
| SDK | `client.extensions.list/enabled/install/upload/setEnabled/uninstall/invokeHook` |
| GraphQL | `extensions`, `extension`, `installExtension`, `uploadExtension`, `setExtensionEnabled`, `uninstallExtension`, `invokeExtensionHook` |
| MCP | `extensions.list`, `extensions.install`, `extensions.set_enabled`, `extensions.uninstall`, `extensions.invoke_hook` |
| CLI | `bun backlex extensions <list\|install\|push\|enable\|disable\|uninstall\|invoke>` |

Parity is pinned by `apps/web/tests/extensions-surfaces.test.ts`; the service
internals (manifest validation, tar reader, bridge allow-list, asset CSP) by
`apps/web/tests/extensions.test.ts`.

## Limits & backlog

- No dependency resolution: packages must ship prebuilt entries (bundle
  before publishing if you use a framework); only same-package script/style
  refs are resolved, at install time.
- Sibling assets other than scripts/styles (images, fonts) must be `data:`
  URIs inside the entry document.
