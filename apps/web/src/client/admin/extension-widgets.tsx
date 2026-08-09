// Renders every enabled extension's widgets for one mount point, in place,
// inside the screen the operator is already on.
//
// A `panel` is a destination — the operator leaves the order they were looking
// at to go read about it somewhere else. A widget renders next to the work, and
// is handed the context of the screen it is on, which is what lets an extension
// be about *this* row rather than about the workspace in general.
//
// Nothing here is privileged: the widget is the same opaque-origin iframe a
// panel gets, its API calls still go through the bridge's `permissions.api`
// allow-list, and the context it receives is ids only — never row contents.
import { Trans } from "@lingui/react/macro";
import { cn } from "@backlex/ui/lib/utils";
import type { ApiExtension, ApiExtensionWidgetMount } from "./api/automation";
import { ExtensionFrame, type ExtensionWidgetContext } from "./extension-frame";
import { useEnabledExtensions } from "./queries";

interface Mounted {
  extension: ApiExtension;
  id: string;
  title: string;
  entry: string;
}

/**
 * Widgets contributed for `mount`, filtered to `collection`.
 *
 * A widget with no `collections` list is workspace-wide and appears on every
 * collection — the common case for something like a notes or audit panel. One
 * WITH a list appears only there, so a shipping widget doesn't turn up on the
 * blog. `home` has no collection, so the filter doesn't apply.
 */
export const widgetsFor = (
  extensions: ApiExtension[],
  mount: ApiExtensionWidgetMount,
  collection?: string,
): Mounted[] => {
  const out: Mounted[] = [];
  for (const extension of extensions) {
    for (const w of extension.manifest?.contributes?.widgets ?? []) {
      if (w.mount !== mount) continue;
      if (mount !== "home" && w.collections && w.collections.length > 0) {
        if (!collection || !w.collections.includes(collection)) continue;
      }
      out.push({ extension, id: w.id, title: w.title, entry: w.entry });
    }
  }
  return out;
};

export interface ExtensionWidgetsProps {
  mount: ApiExtensionWidgetMount;
  context?: ExtensionWidgetContext;
  className?: string;
}

/**
 * Renders nothing at all when no extension contributes to this mount — which
 * is the overwhelmingly common case, so every host screen can drop this in
 * unconditionally without reserving space or drawing an empty section.
 */
export function ExtensionWidgets({ mount, context, className }: ExtensionWidgetsProps) {
  const { data } = useEnabledExtensions();
  const mounted = widgetsFor(data?.data ?? [], mount, context?.collection);
  if (mounted.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {mounted.map((m) => (
        <section key={`${m.extension.name}:${m.id}`} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            {m.title}{" "}
            <span className="text-xs font-normal opacity-70">
              <Trans>via {m.extension.manifest.title}</Trans>
            </span>
          </h3>
          <ExtensionFrame
            extension={m.extension}
            entry={m.entry}
            mode="widget"
            context={context}
          />
        </section>
      ))}
    </div>
  );
}
