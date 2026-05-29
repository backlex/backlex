---
title: Design system
description: Source of truth for how the admin looks and behaves — tokens, components, and patterns.
---

This is the source of truth for how the admin looks and behaves. It is
descriptive (codifies what's already in the repo) and prescriptive (what
new pages must follow).

> If a recipe here doesn't match the code, the code is wrong — fix the code, not the doc.

## 1. Brand & voice

**backlex** is a self-hostable Supabase/Directus alternative. The admin is
an operator's dashboard, not a marketing surface. It is used by people who
already know what a collection, a webhook, and a Bearer token are.

- **Tone**: precise, calm, present-tense. No exclamation marks. No emoji.
- **Density**: medium — denser than Supabase, looser than the Linux
  command line. Optimised for keyboard + multi-window workflows.
- **Visual identity**: a single-letter `w` mark on a chartreuse-green
  primary. The brand is the typography (Geist) + the OKLCH palette + the
  generous radius scale, not a logo.

## 2. Tokens (radix-luma preset)

Every colour, radius, and font lives in `packages/ui/src/styles/globals.css`.
**Never hard-code a hex, RGB, or pixel-radius in component code.** Use the
Tailwind theme aliases.

### Colours (OKLCH, light)

| Token | Light | Dark | Use for |
|---|---|---|---|
| `background` | white | near-black | page canvas |
| `foreground` | near-black | white | body text |
| `card` | white | dark grey | elevated surfaces |
| `popover` | white | dark grey | overlay surfaces |
| `primary` | chartreuse green | brighter green | CTA buttons, brand mark, dot indicators |
| `primary-foreground` | dark green | dark green | text on primary |
| `secondary` | light grey | dim grey | non-CTA buttons, soft pills |
| `muted` | light grey | dim grey | subtle backgrounds (skeleton, hover) |
| `muted-foreground` | mid grey | mid grey | metadata, timestamps, hints |
| `accent` | same as muted (light) / dim grey (dark) | hover backgrounds |
| `destructive` | red | red | delete buttons, error states |
| `border` | light grey | white@10% | dividers, input borders |
| `input` | same as border | white@15% | focus ring base |
| `ring` | mid grey | mid grey | focus rings |
| `chart-1..5` | green spectrum | green spectrum | data viz only |
| `sidebar*` | sidebar surface | sidebar surface | reserved for `<Sidebar>` |

**Don't**: invent ad-hoc colours. If a Badge needs a red tint, use
`bg-destructive/15 text-destructive`, not a new variable.

**Do**: prefer transparency over new tokens — `bg-primary/15`,
`text-foreground/60`. Tailwind v4 OKLCH alpha works directly.

### Radius scale

`--radius` defines the unit; multipliers cascade:

| Class | Multiplier | Use |
|---|---|---|
| `rounded-sm` | 0.6× | inline chips, code spans |
| `rounded-md` | 0.8× | small inputs, narrow popovers |
| `rounded-lg` | 1.0× | base — cards, table containers |
| `rounded-xl` | 1.4× | nested cards inside dialogs |
| `rounded-2xl` | 1.8× | **default for surfaces** (cards, panels, buttons in lists) |
| `rounded-3xl` | 2.2× | inputs, primary buttons (signature pill shape) |
| `rounded-4xl` | 2.6× | hero buttons, full-width auth cards |

**Convention**: pill-shaped Inputs + Buttons are the backlex signature.
Don't shrink them to `rounded-md` to look "more pro" — that's another
design system. Embrace the generous radius.

### Typography

- **Font**: Geist Variable (sans). Mono never enforced — use `font-mono`
  inline only for IDs, slugs, code, JSON, key prefixes.
- **Scale**:
  - `text-2xl font-semibold` — page title (single h1)
  - `text-lg font-medium` — section header inside a page
  - `text-sm` — body default
  - `text-xs text-muted-foreground` — metadata, hints, breadcrumbs
  - `text-[10px] uppercase tracking-wide` — badge label, sub-section eyebrow
- **Tabular numerals**: `tabular-nums` on counters, scores, timers — keeps
  values aligned across rows.

### Motion

- All shadcn primitives ship with `tw-animate-css` transitions; don't
  rewrite them.
- Custom motion: keep under 200 ms. No bounce. No spring physics.
- Loading state: use `<Skeleton>`. **Never** show a spinning icon for
  > 1 s — fall back to a skeleton or progress text.
- Empty states never animate. They are calm.

## 3. Layout principles

### Page shell

Every signed-in page renders inside `<AppLayout>` (sidebar + content).
The page itself is a single React component returning:

```tsx
<div>
  <PageHeader title=... description=... actions=... breadcrumbs=... />
  <Card or grid of Cards>
</div>
```

**Page width**: never set a `max-w-*` on a top-level page. The layout
breakpoint is set by `SidebarInset` and the page just fills it. Constrain
**inside** Cards if needed (e.g., a settings form `max-w-lg`).

### PageHeader

Mandatory on every primary page. Contract:

```tsx
<PageHeader
  title="..."                        // h1 — string or <span className="font-mono"> for slugs
  description="..."                  // 1 sentence, ≤ 90 chars, ends with "."
  breadcrumbs={[                     // optional; nested pages always
    { label: "Collections", to: "/collections" },
    { label: slug },                 // last item has no `to`
  ]}
  actions={<>                        // top-right cluster — refresh + primary CTA
    <Button variant="outline" size="sm" onClick={refresh}>Refresh</Button>
    <Button size="sm" onClick={create}><PlusIcon /> New X</Button>
  </>}
/>
```

The order is locked: refresh → secondary actions → primary CTA on the right.

### Sidebar

`AppSidebar` is collapsible-icon. Nav items live in `client/lib/nav.ts`
(single source for sidebar AND command palette). To add a route, add it
to `NAV_ITEMS` first.

**No nested groups.** If a feature warrants a submenu, it gets a top-level
nav entry instead — flat is faster to scan.

### Content surfaces

- **Card** — default container for any list, form, or grouped content.
  Border + `rounded-2xl`. Use `<CardContent>` directly; reserve
  `<CardHeader>` + `<CardTitle>` for rare headings (most lists put their
  controls above the card, not inside it).
- **DataTable** — for any list of records >5 rows or with sortable
  columns. Always `selectable`, always `bulkActions`, always `empty`.
- **Sheet** — for create/edit forms that would otherwise dominate the
  page. Right-side, `sm:max-w-xl`. Use sticky header + scrollable body +
  sticky footer (cancel + primary).
- **Dialog** — short forms (rename, single input). **AlertDialog**
  exclusively for destructive confirmations via `<ConfirmAction>`.
- **Inline forms** (above a list, no card chrome) — only for *filter
  bars* and *the very first item in an empty workspace*.

## 4. Component patterns

### Toasts (`@backlex/ui/components/sonner`)

```tsx
import { toast } from "@backlex/ui/components/sonner";
import { notifyError } from "@/lib/error";

toast.success("Item saved");
notifyError(e, "Saving item");      // wraps toast.error with context prefix
```

- **Success** — short past tense. "Item created." "Flow dispatched."
- **Error** — `notifyError(error, contextPrefix?)`. Never raw `toast.error`
  for caught errors.
- **Position**: top-right (set in `App.tsx`).
- Don't toast for actions whose result is already visible (a list refresh
  after delete already shows the row gone — toast is noise).

### Confirmations

Always `<ConfirmAction>`. **Never** `window.confirm()` or `window.prompt()`.

```tsx
<ConfirmAction
  title="Delete this flow?"
  description='"X" stops firing immediately.'
  actionLabel="Delete"
  destructive
  onConfirm={() => remove(id)}
>
  <Button variant="ghost" size="icon-sm"><Trash2Icon /></Button>
</ConfirmAction>
```

- **Title** ends with `?`.
- **Description** explains the *consequence*, not just "are you sure".
- `destructive` → red action button. Set when state is genuinely
  destructive (DROP TABLE, revoke key, delete row). Don't set for
  reversible toggles.

### Empty states

Always `<EmptyState>`. Three slots: icon (lucide), title, description,
optional action.

```tsx
<EmptyState
  icon={InboxIcon}
  title="No items yet"
  description="Create the first item via the API or the New item button above."
  action={<Button size="sm" onClick={create}><PlusIcon /> New item</Button>}
/>
```

- **Title** is a sentence, not a label. "No items yet" not "No items".
- **Description** explains *why this exists* + *next step*, not just "this
  is empty".

### Skeleton loaders

Always replace "Loading…" text with `<Skeleton>` rows. Pattern:

```tsx
{loading ? (
  <ul className="divide-y">
    {Array.from({ length: 3 }).map((_, i) => (
      <li key={i} className="space-y-2 py-3">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-3 w-1/3" />
      </li>
    ))}
  </ul>
) : items.length === 0 ? (
  <EmptyState ... />
) : (
  // real list
)}
```

3-5 skeletons is enough — more is dishonest.

### Badges

For status, role, action labels. Variants:

| Variant | Use |
|---|---|
| `default` | active state, primary status (active flow, owner-scoped, admin) |
| `secondary` | neutral classification (system role, paused) |
| `destructive` | error state (revoked, failed) |
| `outline` | type label, technical metadata (field type, http method) |

Inline classification (e.g., "owner-scoped" on a card): place after the
title with `gap-2`. No more than 3 badges per row.

### Forms

- Always `<form onSubmit={handle}>` — never bare buttons triggering submits.
- Always `<Label htmlFor="...">` paired with `<Input id="...">`. Bare
  inputs without labels are an a11y bug.
- Submit button on the right (`flex justify-end`). Cancel ghost button to
  its left. Never *Save & continue*.
- Validation: zod first; rely on toast for runtime errors. Inline
  `<p className="text-destructive">` is **deprecated** — use toast.

## 5. Voice & copy

### Page descriptions

Every PageHeader has a 1-sentence description. Format:

> {What it is}. {Optionally: a constraint or auto-detection note}.

Examples (lifted from current admin):
- Collections: "Dynamic schema. Each collection becomes a physical c_<slug> table at runtime; drop or alter via this UI."
- Storage: "Adapter auto-selected: R2 binding → R2; S3 env vars → S3; else local filesystem (Bun dev)."
- Functions: "Sandboxed JS — HTTP, event-trigger, or cron. Provider auto-selected per runtime."

Avoid: marketing-speak ("Powerful flows for your team!"), tautologies
("Manage your flows here").

### Error messages

`notifyError(e, "Saving item")` becomes "Saving item: HTTP 422".

- Always include action context as the prefix.
- Never trust the API's raw message alone — the prefix tells the user
  *which action* failed.
- Validation messages from zod come through as "field.path: required".
  Don't reformat them.

### Button labels

Imperative, present tense. `New item`, `Save`, `Delete`, `Run now`,
`Apply`. Not `Create new item`, `Save changes`.

Loading states: `Saving…`, `Creating…`, `Deleting…` (em-dash, lowercase).

## 6. Anti-patterns

These are bugs in the design system. If you see them, fix them.

| Anti-pattern | Fix |
|---|---|
| `window.confirm("...")` | `<ConfirmAction>` |
| `window.prompt("...")` | `<Dialog>` with form |
| `alert("...")` | `notifyError` / `toast.success` |
| `<input type="checkbox">` | `<Checkbox>` or `<Switch>` |
| `<select>` | `<Select>` (shadcn) — exception: tiny inline filter selects with class `SELECT_CLS` are tolerated |
| `<p className="text-destructive">{error}</p>` | toast via `notifyError` |
| `<p>Loading…</p>` | `<Skeleton>` |
| `<p>No items.</p>` | `<EmptyState>` |
| Hard-coded hex/rgb | Tailwind token (`bg-primary`, `text-muted-foreground`) |
| `style={{ borderRadius: 12 }}` | `rounded-xl` |
| `console.error("[X] failed", e)` in route handlers | `notifyError(e, "X")` |
| Native `<button>` for actions | `<Button>` |
| Multiple `<h1>` per page | one `<PageHeader title>` only |
| Custom modal divs | `<Dialog>` / `<Sheet>` / `<AlertDialog>` |
| Drilling collection slug into `prompt()` | URL params or Dialog |

## 7. Accessibility musts

These are non-negotiable. Tests should fail when missed.

- Every interactive element is keyboard-reachable. **Cmd+K** opens the
  command palette. **Esc** closes any overlay.
- Every `<Input>` has a `<Label htmlFor>`.
- Every form field has `autoComplete` set when applicable
  (`email`, `current-password webauthn`, `new-password`, `name`,
  `one-time-code`).
- Focus rings: never `outline:none` without replacement. Default ring
  uses `--ring`.
- Colour is not the only signal. Destructive states have an icon AND red
  bg/text. Status badges use icons for connected/disconnected.
- Toasts are dismissible (`closeButton` prop set globally).
- Dark mode is a first-class theme. Test every new page with `d` toggle.

## 8. Per-page checklist (apply when creating/editing a page)

1. Imports include `PageHeader`, `notifyError`, `EmptyState`,
   `ConfirmAction` (and `Skeleton`, `Badge` if applicable).
2. Top-level component starts with `<PageHeader>`. Title + description set.
3. List view goes through `loading? skeleton : items.length===0 ? EmptyState : real list`.
4. All errors land in `notifyError(e, "context")`. No inline `<p>`.
5. All deletes wrapped in `<ConfirmAction destructive>`.
6. All raw `confirm()` / `prompt()` removed.
7. All raw `<select>` swapped for shadcn `<Select>` unless it's a tiny
   inline filter using the project's `SELECT_CLS` className.
8. Page works in dark mode (toggle via `d` key in dev).
9. Page works without a session — gets bounced to `/sign-in`.
10. Cmd+K opens the palette; navigation entries match `lib/nav.ts`.

## 9. Where to add new tokens

If a new token is genuinely needed:

1. Edit `packages/ui/src/styles/globals.css` — add to BOTH the `:root`
   and `.dark` blocks.
2. Add the Tailwind alias in the `@theme inline` block.
3. Document it here in section 2.

If you're tempted to add `oklch(...)` inline, stop and ask — there's
almost always an existing token that fits.

## 10. References

- Source palette: shadcn `radix-luma` preset (committed in
  `packages/ui/components.json`).
- Component stack: `radix-ui` meta-package + cmdk + sonner + xyflow + cmdk
  + react-day-picker.
- Code editor: CodeMirror 6 (lazy-loaded for the JSON field only — see
  `components/code-editor-lazy.tsx`).
- Icons: `lucide-react`. Always size 4 (`size-4`) inline with text;
  size 5 (`size-5`) in EmptyState centre.
