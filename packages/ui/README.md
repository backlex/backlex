# @workeros/ui

workeros design system — shadcn-based React component library on Tailwind v4 (radix-luma preset, Geist font, oklch palette). Source-consumed; no build step.

## Install

```bash
bun add @workeros/ui
# or
npm i @workeros/ui
```

Peer deps: `react@^19`, `react-dom@^19`, and Tailwind v4 in the consuming app.

## Usage

```tsx
import "@workeros/ui/globals.css";
import { Button } from "@workeros/ui/components/button";
import { cn } from "@workeros/ui/lib/utils";

export function Example() {
  return <Button className={cn("font-mono")}>Hello</Button>;
}
```

`globals.css` provides the `@theme` block (oklch palette + radius scale + Geist font), the `.dark` overrides, and the `@source` globs for Tailwind content scanning. If your project layout differs from the workeros monorepo, override `@source` with your own globs in your local `globals.css`:

```css
@import "@workeros/ui/globals.css";
@source "../**/*.{ts,tsx}";
```

## Subpath exports

| Export | Purpose |
|---|---|
| `@workeros/ui/globals.css` | Tailwind v4 base layer + theme tokens |
| `@workeros/ui/components/*` | 30+ shadcn components (Button, Dialog, Sheet, Tabs, Sidebar, …) |
| `@workeros/ui/lib/utils` | `cn()` (clsx + tw-merge) |
| `@workeros/ui/hooks/*` | shared React hooks |

No barrel file by design — import the specific component path so the bundler can tree-shake.

## Conventions

- Components use the `radix-ui` meta-package (`import { Slot } from "radix-ui"`), not per-component `@radix-ui/react-*`.
- Scrollable areas: use `<ScrollArea>` from `@workeros/ui/components/scroll-area`; never raw `overflow-auto`.
- Adding a component: `bun run --cwd packages/ui shadcn add <name>` (writes into `src/components/`).

## License

MIT — part of the [workeros](https://github.com/furkankinyas/workeros) project.
