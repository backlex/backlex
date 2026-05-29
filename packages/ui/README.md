# @backlex/ui

workeros design system — shadcn-based React component library on Tailwind v4 (radix-luma preset, Geist font, oklch palette). Source-consumed; no build step.

## Install

```bash
bun add @backlex/ui
# or
npm i @backlex/ui
```

Peer deps: `react@^19`, `react-dom@^19`, and Tailwind v4 in the consuming app.

## Usage

```tsx
import "@backlex/ui/globals.css";
import { Button } from "@backlex/ui/components/button";
import { cn } from "@backlex/ui/lib/utils";

export function Example() {
  return <Button className={cn("font-mono")}>Hello</Button>;
}
```

`globals.css` provides the `@theme` block (oklch palette + radius scale + Geist font), the `.dark` overrides, and the `@source` globs for Tailwind content scanning. If your project layout differs from the workeros monorepo, override `@source` with your own globs in your local `globals.css`:

```css
@import "@backlex/ui/globals.css";
@source "../**/*.{ts,tsx}";
```

## Subpath exports

| Export | Purpose |
|---|---|
| `@backlex/ui/globals.css` | Tailwind v4 base layer + theme tokens |
| `@backlex/ui/components/*` | 30+ shadcn components (Button, Dialog, Sheet, Tabs, Sidebar, …) |
| `@backlex/ui/lib/utils` | `cn()` (clsx + tw-merge) |
| `@backlex/ui/hooks/*` | shared React hooks |

No barrel file by design — import the specific component path so the bundler can tree-shake.

## Conventions

- Components use the `radix-ui` meta-package (`import { Slot } from "radix-ui"`), not per-component `@radix-ui/react-*`.
- Scrollable areas: use `<ScrollArea>` from `@backlex/ui/components/scroll-area`; never raw `overflow-auto`.
- Adding a component: `bun run --cwd packages/ui shadcn add <name>` (writes into `src/components/`).

## License

MIT — part of the [workeros](https://github.com/furkankinyas/workeros) project.
