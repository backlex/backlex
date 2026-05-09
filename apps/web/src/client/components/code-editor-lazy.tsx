import { Suspense, lazy, type ComponentProps } from "react";
import { Skeleton } from "@workeros/ui/components/skeleton";

const CodeEditorImpl = lazy(() => import("./code-editor"));

type Props = ComponentProps<typeof CodeEditorImpl>;

/**
 * Lazy-loading wrapper for the CodeMirror-backed CodeEditor. The first
 * render of an item with a JSON field triggers the chunk fetch; subsequent
 * mounts hit the loaded module.
 */
export const CodeEditor = (props: Props) => (
  <Suspense
    fallback={
      <div className="overflow-hidden rounded-2xl border border-input bg-background p-3">
        <Skeleton className="h-24 w-full" />
      </div>
    }
  >
    <CodeEditorImpl {...props} />
  </Suspense>
);
