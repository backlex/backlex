import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Source-scan gate for the admin's chrome conventions.
 *
 * Every rule here exists because the same defect shipped at least once and was
 * only caught by eye, on a screenshot, after deploy — a filter dropdown a pixel
 * taller than the button beside it, a create button that read as secondary, an
 * empty state that was a bare sentence with no glyph and no background. None of
 * them break a render test, and none of them are visible in a diff. They are
 * visible in a grep, so they are grepped.
 */

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "../../src/client");

const tsxFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) out.push(p);
    }
  };
  walk(CLIENT);
  return out.sort();
};

const FILES = tsxFiles().map((path) => ({
  path,
  rel: relative(CLIENT, path),
  src: readFileSync(path, "utf8"),
}));

const lineOf = (src: string, index: number): number => src.slice(0, index).split("\n").length;

/**
 * The props region of a JSX element. Nested elements only ever appear inside a
 * `{…}` expression container (`action={<Button/>}`), so the element's own `>`
 * is the first one at brace depth zero.
 */
const propsOf = (src: string, start: number): string => {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
};

/** Every `actions={…}` block, brace-matched, with the line it starts on. */
const actionBlocks = (src: string): Array<{ block: string; line: number }> => {
  const out: Array<{ block: string; line: number }> = [];
  for (const m of src.matchAll(/\bactions=\{/g)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          out.push({ block: src.slice(open, i + 1), line: lineOf(src, m.index!) });
          break;
        }
      }
    }
  }
  return out;
};

/** Elements of a given name inside a block, paired with their props region. */
const elementsIn = (block: string, name: string): string[] =>
  [...block.matchAll(new RegExp(`<${name}\\b`, "g"))].map((m) => propsOf(block, m.index!));

describe("admin UI conventions", () => {
  // The admin `Button` is h-8 (size "sm" by default); a default-size `Select`
  // trigger is h-9. Side by side in a header that one pixel of overhang is the
  // whole defect.
  test("a Select in a page header's actions is size=\"sm\"", () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      for (const { block, line } of actionBlocks(src)) {
        for (const props of elementsIn(block, "Select")) {
          if (!/\bsize="sm"/.test(props)) offenders.push(`${rel}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // A header that offers a create action has a filled button — "+ Install
  // extension", not a ghosted outline that reads like a utility sitting next to
  // Refresh/Export. The rule is per header, not per button: a page may well
  // pair a secondary "Add source" with a primary "New migration". What it may
  // not do is offer creation with nothing filled at all.
  test("a page header that offers a create action has a filled button", () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      // Files on the shadcn Button get a filled button by default; the admin
      // wrapper in `admin/ui.tsx` defaults to `outline`, so it must say so.
      const adminButton = /import \{[^}]*\bButton\b[^}]*\} from "\.\.?\/(?:\.\.\/)?ui"/.test(src);
      for (const { block, line } of actionBlocks(src)) {
        const buttons = elementsIn(block, "Button");
        const offersCreate = buttons.some((p) => /icon=\{I\.Plus\}|<I\.Plus\b|<PlusIcon\b/.test(p));
        if (!offersCreate) continue;
        const anyFilled = buttons.some((props) => {
          const variant = /\bvariant="([a-z]+)"/.exec(props)?.[1];
          return adminButton
            ? variant === "primary"
            : variant === undefined || variant === "default" || variant === "primary";
        });
        if (!anyFilled) offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // `size="sm"` is the inline placeholder inside an already-bordered parent (a
  // sidebar list, a table cell). Everything else is a page- or section-level
  // empty state, and those carry a glyph — a lone sentence in a card reads as
  // a rendering bug rather than as "nothing here yet".
  test("a page-level EmptyState passes an icon", () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      for (const m of src.matchAll(/<EmptyState\b/g)) {
        const props = propsOf(src, m.index!);
        if (/\bsize="sm"/.test(props)) continue;
        if (!/\bicon=/.test(props)) offenders.push(`${rel}:${lineOf(src, m.index!)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // There were two of each for a while — `admin/ui.tsx` and `components/*` —
  // and they had drifted apart on action alignment, padding and icon chrome.
  // A page looked different depending on which module it happened to import.
  test("PageHeader and EmptyState have exactly one implementation each", () => {
    const homes: Record<string, string> = {
      PageHeader: "components/page-header.tsx",
      EmptyState: "components/empty-state.tsx",
    };
    for (const [name, home] of Object.entries(homes)) {
      const defs = FILES.filter(({ src }) =>
        new RegExp(`(?:export )?(?:function ${name}\\(|const ${name} = \\()`).test(src),
      ).map(({ rel }) => rel);
      expect(defs).toEqual([home]);
    }
  });
});
