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
 * is the first one at brace depth zero — provided string literals are skipped
 * first. Tailwind arbitrary variants put a literal `>` inside className
 * (`[&>div]:block`, `[&>*]:min-w-0`); without the quote handling the scan cuts
 * off mid-attribute and silently under-reports.
 */
const propsOf = (src: string, start: number): string => {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    // Quotes are only delimiters in the element's own attribute list. Inside a
    // `{…}` they are ordinary text — `title={<Trans>Couldn't load logs</Trans>}`
    // has an apostrophe that would otherwise open a string and swallow the rest
    // of the file, which is exactly how this scan first under-reported.
    if (depth === 0 && (ch === '"' || ch === "'")) quote = ch;
    else if (ch === "{") depth++;
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

  // A dialog body sized by a hand-written rem budget is a guess about the
  // header + footer + padding around it, and a wrong guess is invisible until
  // some description wraps to a second line and pushes the footer past the
  // bottom edge, where overflow-hidden clips it. `<DialogBody>` lets the
  // browser measure instead.
  test("a dialog body is <DialogBody>, not a hand-capped ScrollArea", () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      for (const m of src.matchAll(/<ScrollArea\b/g)) {
        const props = propsOf(src, m.index!);
        // Only viewport-relative caps: a `max-h-[240px]` list inside a card is
        // a deliberate size, not a dialog-chrome budget.
        if (!/viewportClassName="[^"]*calc\([^"]*vh/.test(props)) continue;
        // …and only where the ScrollArea is the dialog's own body.
        const before = src.slice(0, m.index);
        const opens = (before.match(/<DialogContent\b/g) ?? []).length;
        const closes = (before.match(/<\/DialogContent>/g) ?? []).length;
        if (opens > closes) offenders.push(`${rel}:${lineOf(src, m.index!)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The admin Select wraps Radix, whose handler is `onValueChange`; the wrapper
  // takes `onChange`. It accepts both now — this guards the third spelling.
  test("every admin Select is wired to a handler", () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      if (!/import \{ Select[ ,}][^\n]*\} from "\.{1,2}\/(?:\.\.\/)?select"/.test(src)) continue;
      if (/\bSelectTrigger\b/.test(src)) continue; // also pulls in the shadcn primitive
      for (const m of src.matchAll(/<Select\b/g)) {
        const props = propsOf(src, m.index!);
        if (!/\bon(?:Change|ValueChange)=/.test(props)) {
          offenders.push(`${rel}:${lineOf(src, m.index!)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The size question is really "does something already draw a frame around
  // this?", and answering it by eye is what put a bare unstyled paragraph on
  // the erasure list and on Data syncs. So the check reads the JSX ancestry:
  // an EmptyState with no Card above it must draw its own; one inside a Card
  // must not, or you get a card inside a card.
  test("an EmptyState draws card chrome exactly when nothing else does", () => {
    const bare: string[] = [];
    const nested: string[] = [];
    for (const { rel, src } of FILES) {
      if (!src.includes("<EmptyState")) continue;
      const stack: Array<{ name: string; props: string }> = [];
      const tag = /<(\/?)([A-Za-z][A-Za-z0-9.]*)\b/g;
      let m: RegExpExecArray | null;
      while ((m = tag.exec(src))) {
        const closing = m[1] === "/";
        const name = m[2]!;
        // `useState<Foo>` is a generic, not a tag: real JSX never has an
        // identifier character immediately before the `<`.
        if (!closing && /[A-Za-z0-9_$)\]]/.test(src[m.index - 1] ?? " ")) continue;
        if (closing) {
          for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i]!.name === name) { stack.length = i; break; }
          }
          continue;
        }
        const props = propsOf(src, m.index);
        if (name === "EmptyState") {
          // Attributes written outside any `{…}`, so a nested `<Button size="sm">`
          // in `action={…}` is not read as this EmptyState's own size.
          let own = "", d = 0;
          for (const ch of props) {
            if (ch === "{") d++;
            else if (ch === "}") d--;
            else if (d === 0) own += ch;
          }
          const size = /\bsize="(\w+)"/.exec(own)?.[1] ?? "lg";
          const drawsCard = size !== "sm" && !/\bbare\b/.test(own);
          const framed = stack.some(
            (a) =>
              /^(Card|CardContent)$/.test(a.name) ||
              /className="[^"]*\bborder(?!-0)\b/.test(a.props) ||
              // The legacy `.card` utility predates the Card component.
              /className="[^"]*\bcard\b/.test(a.props),
          );
          const at = `${rel}:${lineOf(src, m.index)}`;
          if (drawsCard && framed) nested.push(at);
          // An EmptyState with no JSX ancestors at all is the whole body of a
          // reusable component (EmptyItems), and its frame is the caller's to
          // draw — nothing in this file can say whether one exists.
          else if (!drawsCard && !framed && stack.length > 0) bare.push(at);
        }
        if (!props.endsWith("/>")) stack.push({ name, props });
        tag.lastIndex = m.index + props.length - 1;
      }
    }
    expect({ bare, nested }).toEqual({ bare: [], nested: [] });
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

  /**
   * `@ts-nocheck` turns a file off for the compiler entirely — not one
   * diagnostic, all of them. Forty-five admin files carried it, hiding 202 real
   * errors: an API method that did not exist, a translate function shadowed by
   * a timer handle, a click handler fed a MouseEvent as its string argument, a
   * union that could not hold values the server actually returns. `bun run
   * typecheck` reported zero the whole time.
   *
   * It is banned rather than budgeted because a budget is what let it spread:
   * each file was individually reasonable and the total was invisible. If a
   * single expression genuinely cannot be typed, `@ts-expect-error` on that
   * line leaves the rest of the file checked — and fails if the error stops
   * happening.
   */
  test("no source file disables typechecking wholesale", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") || p.endsWith(".tsx")) sources.push(p);
      }
    };
    walk(CLIENT);

    // Anchored: prose *about* the directive is fine and several files carry it
    // as a note on why a bug was invisible. Only a real directive — the first
    // thing on its line — turns the compiler off.
    const suppressed = sources
      .filter((p) => /^\s*(?:\/\/|\/\*)\s*@ts-nocheck\b/m.test(readFileSync(p, "utf8")))
      .map((p) => relative(CLIENT, p))
      .sort();
    expect(suppressed).toEqual([]);
  });
});
