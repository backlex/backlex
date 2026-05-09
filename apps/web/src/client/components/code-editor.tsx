import { useEffect, useState } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { cn } from "@workeros/ui/lib/utils";

interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  language?: "json" | "plain";
  minHeight?: string;
  /** Render-only border style + inherited typography. */
  className?: string;
}

const useDark = (): boolean => {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setDark(root.classList.contains("dark"));
    const mo = new MutationObserver(update);
    mo.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
};

/**
 * CodeMirror 6 wrapper. Replaces raw <Textarea> for fields that benefit from
 * syntax highlighting + bracket matching (currently JSON; easy to extend).
 * Theme follows the admin's `.dark` class — no separate next-themes hook.
 *
 * Imported lazily via `code-editor-lazy.tsx` so CodeMirror's ~500 KB of
 * runtime + grammar + theme bundles only land when the user opens an item
 * with a JSON field.
 */
const CodeEditor = ({
  value,
  onChange,
  language = "json",
  minHeight = "120px",
  className,
}: CodeEditorProps) => {
  const dark = useDark();
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-input bg-background text-sm",
        className,
      )}
    >
      <CodeMirror
        value={value}
        height="auto"
        minHeight={minHeight}
        theme={dark ? oneDark : "light"}
        extensions={
          language === "json" ? [json(), EditorView.lineWrapping] : [EditorView.lineWrapping]
        }
        onChange={onChange}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
        }}
      />
    </div>
  );
};

export default CodeEditor;
