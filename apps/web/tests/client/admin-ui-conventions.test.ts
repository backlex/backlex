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
    // A `//` comment between attributes is prose, and prose is where both of
    // this scanner's terminators appear by accident: an apostrophe in
    // "the element's props" opens a string that swallows the rest of the file,
    // and a tag written as an example ends the props region early. Either way
    // the element silently drops out of every rule below — a filter that
    // matches nothing, which reads exactly like a pass. Skip the line instead.
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl === -1) return src.slice(start);
      i = nl;
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

/**
 * Line numbers that hold comment text rather than code.
 *
 * A JSX-ancestry scan has to skip them: this file's rules are documented in the
 * source they police, so prose naming an element — "callers passed a `<Badge>`"
 * — reads to the tag scanner as an element that opens and never closes, and
 * every real one after it looks nested inside it. Whole-line comments are the
 * shape that actually occurs; a tag written in a trailing comment after code on
 * the same line is not covered, and should be reworded if it ever trips a rule.
 */
const commentLines = (src: string): Set<number> => {
  const out = new Set<number>();
  let inBlock = false;
  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (inBlock) {
      out.add(i + 1);
      if (t.includes("*/")) inBlock = false;
    } else if (t.startsWith("//")) {
      out.add(i + 1);
    } else if (t.startsWith("/*")) {
      out.add(i + 1);
      if (!t.includes("*/")) inBlock = true;
    }
  });
  return out;
};

/** The `className="…"` literal of a props region, or "" when it is an expression. */
const classNameOf = (props: string): string =>
  props.match(/\bclassName="([^"]*)"/)?.[1] ?? "";

/** Whether a DialogContent's contents include something that acts as its body. */
const hasDialogBody = (body: string): boolean =>
  /<DialogBody\b/.test(body) || /data-slot="dialog-body"/.test(body);

/**
 * Every `<DialogContent …>…</DialogContent>` in a file: its props region, the
 * source between the tags, and the line it opens on. Dialogs are never nested
 * inside each other's content, so the first closing tag after the opening one
 * is the matching one.
 */
const dialogContents = (
  src: string,
): Array<{ props: string; body: string; line: number }> => {
  const out: Array<{ props: string; body: string; line: number }> = [];
  const comments = commentLines(src);
  for (const m of src.matchAll(/<DialogContent\b/g)) {
    if (comments.has(lineOf(src, m.index!))) continue;
    const props = propsOf(src, m.index!);
    const start = m.index! + props.length;
    const end = src.indexOf("</DialogContent>", start);
    out.push({
      props,
      body: src.slice(start, end === -1 ? src.length : end),
      line: lineOf(src, m.index!),
    });
  }
  return out;
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
  // `SidebarMenuSubButton` renders an `<a>`. One that navigates on click and
  // declares no `href` is not a link — an anchor without href is not in the tab
  // order, carries no implicit link role, and offers no ⌘-click "open in new
  // tab", no copy-link, and no URL on hover. The admin's 39 collection entries
  // were exactly that: `.focus()` on one was a no-op, so a keyboard user could
  // not reach the data section of the product at all, while `.click()` went to
  // a perfectly real `/collections/:slug`. The destination existed; it just was
  // not being declared. `asChild` is exempt — the caller supplies the element.
  test("a SidebarMenuSubButton that navigates declares its href", () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      for (const props of elementsIn(src, "SidebarMenuSubButton")) {
        if (!/\bonClick=/.test(props)) continue; // a label, not a destination
        if (/\basChild\b/.test(props)) continue; // renders the caller's element
        if (!/\bhref=/.test(props)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

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

  // `<DialogBody>` only scrolls because DialogContent is a grid whose middle
  // row is the one that shrinks. A `flex` in the caller's className takes that
  // away twice over — tailwind-merge drops the base `grid` as a conflict, and
  // `.flex` outranks it in the cascade anyway — and the failure is not a
  // missing scrollbar but a footer drawn on top of the form, with everything
  // below it unreachable. Five dialogs shipped that way (New agent, New room,
  // Report, Trace, Add field) before anyone looked. The variant in dialog.tsx
  // now wins the cascade, so this rule is about the className saying what the
  // layout actually is rather than about the bug still being reachable.
  test("a dialog with a body doesn't override the layout that scrolls it", () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      for (const { props, body, line } of dialogContents(src)) {
        if (!hasDialogBody(body)) continue;
        const cls = classNameOf(props);
        const bad = cls
          .split(/\s+/)
          .filter((c) => /^(flex|block|inline(-.*)?|table|contents|grid-rows-\[)/.test(c));
        if (bad.length) offenders.push(`${rel}:${line} — ${bad.join(" ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // A dialog that zeroes its own padding hands the job to its three children.
  // Header and footer are written right there and get it; the body is a
  // ScrollArea whose padding belongs on the element inside it, one level
  // further down, and that is the one that gets forgotten. It was forgotten on
  // the API-keys create form, where the fields then sat flush against both
  // edges of the dialog while the title above them was inset.
  test("a p-0 dialog pads its own body", () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      for (const { props, body, line } of dialogContents(src)) {
        if (!/(^|\s)p-0(\s|$)/.test(classNameOf(props))) continue;
        const at = body.indexOf("<DialogBody");
        if (at === -1) continue;
        const bodyProps = propsOf(body, at);
        // Deliberately edge-to-edge bodies (a file browser's sidebar+pane, a
        // full-bleed preview) say so, rather than being guessed at from here.
        if (/\bdata-full-bleed\b/.test(bodyProps)) continue;
        const firstChild = body.slice(at + bodyProps.length).match(/<[A-Za-z][^>]*/s)?.[0] ?? "";
        const padded = (s: string) => /(^|[\s:"'`[])(p|px)-[\d[]/.test(s);
        if (!padded(bodyProps) && !padded(firstChild)) {
          offenders.push(`${rel}:${line} — ${firstChild.slice(0, 48).replace(/\s+/g, " ")}`);
        }
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

  /**
   * A pill inside a pill draws two rounded borders a couple of pixels apart —
   * unmistakable on a screenshot, invisible in a diff, and no render test
   * fails on it.
   *
   * It shipped on the search playground's collection picker. The option passed
   * `<Badge>FTS</Badge>` to `Select`'s `badge` prop, and `Select` wraps
   * whatever it is handed in a Badge of its own, so the label came out double-
   * ringed. That cross-file route is closed by the prop's type — it takes a
   * string now, and the wrapper owns the chrome. This closes the shape a scan
   * can see: one Badge written inside another.
   *
   * Deliberately not the ancestry walk the EmptyState rule uses. That one skips
   * each element's props region wholesale, so a Badge inside `badge={…}` or an
   * `options={…}` literal — where this defect was actually written — is
   * invisible to it. Reading forward from each open tag to its first `</Badge>`
   * has no such blind spot.
   */
  test("a Badge never nests inside another Badge", () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      if ((src.match(/<Badge\b/g) ?? []).length < 2) continue;
      const prose = commentLines(src);
      for (const m of src.matchAll(/<Badge\b/g)) {
        const line = lineOf(src, m.index);
        if (prose.has(line)) continue;
        const props = propsOf(src, m.index);
        if (props.endsWith("/>")) continue;
        const inner = src.slice(m.index + props.length);
        const close = inner.indexOf("</Badge>");
        const next = inner.indexOf("<Badge");
        // A second Badge opening before this one closes is the nesting itself —
        // no need to match the close, since finding one is already the answer.
        if (close !== -1 && next !== -1 && next < close) offenders.push(`${rel}:${line}`);
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

  /**
   * The admin's folder tree has to keep meaning something.
   *
   * It stopped meaning anything once: pages lived in two sibling folders,
   * `pages/` and `parity/`, split by the month they were written rather than by
   * what they did, bridged by a re-export barrel — and 76 further files sat
   * flat in the admin root, pages and field editors and pure helpers all in one
   * listing. Nothing enforced any of it, so every new file defaulted to the
   * root and the root grew.
   *
   * So the root is an allow-list. A file that is genuinely shell — the app
   * itself, its kernel modules, the design layer every page draws from — is
   * named here on purpose. Everything else belongs to a folder that says what
   * it is: `pages/<area>/` for a screen, `fields/` for the field model,
   * `collections/` for the item workbench, `lib/` for logic with no chrome.
   * Adding to this list is a decision; it should read as one in the diff.
   */
  test("the admin root holds the shell, and nothing else", () => {
    const SHELL = [
      // The app and its stylesheets.
      "admin.css",
      "app.tsx",
      "flow-builder.css",
      // Kernel — configuration, transport, shared types, i18n runtime.
      "api.ts",
      "config.ts",
      "i18n.ts",
      "queries.ts",
      "types.ts",
      // Where a tabbed page's open panel lives — the path, not state. Read by
      // twelve pages across five folders, owned by none of them.
      "use-url-tab.ts",
      // Design layer — what every page draws itself with.
      "extras.tsx",
      "icons.tsx",
      "loading.tsx",
      "page-skeletons.tsx",
      "preferences.tsx",
      "rule-builder.tsx",
      "select.tsx",
      "sheet.tsx",
      "ui.tsx",
      // Shared infrastructure with no single owning page.
      "extension-frame.tsx",
      // Mounted by the items list, the record editor and the overview page —
      // three owners is no owner, same bucket as the frame it renders.
      "extension-widgets.tsx",
    ].sort();

    const root = join(CLIENT, "admin");
    const actual = readdirSync(root)
      .filter((entry) => !statSync(join(root, entry)).isDirectory())
      .sort();
    expect(actual).toEqual(SHELL);
  });

  /**
   * The split this replaced. Named so it cannot come back by habit.
   *
   * `api/` is the exception, and it is one on purpose: it holds the parts of
   * `api.ts` — the typed client — one module per admin domain, and `api.ts`
   * itself stays at the root as their barrel. It is not a second page tree; no
   * file in it renders anything.
   */
  test("there is no second pages folder", () => {
    const dirs = readdirSync(join(CLIENT, "admin")).filter((e) =>
      statSync(join(CLIENT, "admin", e)).isDirectory(),
    );
    expect(dirs.sort()).toEqual(["api", "collections", "fields", "lib", "pages"]);
  });

  test("`api/` holds no component", () => {
    const dir = join(CLIENT, "admin", "api");
    // A .tsx here would mean a page's markup followed its data call into the
    // client, which is how the root grew a second page tree the last time.
    expect(readdirSync(dir).filter((f) => f.endsWith(".tsx"))).toEqual([]);
  });

  /**
   * The router is the boundary between two audiences, and a static import
   * quietly erases it.
   *
   * The public pages — a form, a booking calendar, a signing page — are
   * self-styled on purpose, so that somebody opening a link from an email gets
   * a page and not an admin console. But every route element used to be a plain
   * import, which meant opening `/f/<token>` downloaded the whole admin anyway:
   * 616 KB gzip of JavaScript to render a contact form. Nothing failed, so
   * nothing said so.
   *
   * One static import of a page is enough to put it back, and it will look
   * perfectly ordinary in the diff. Hence a rule rather than a habit.
   */
  test("the router imports no page eagerly", () => {
    const src = readFileSync(join(CLIENT, "App.tsx"), "utf8");

    const eager = [...src.matchAll(/^import\s+[^;]*?from\s+"([^"]+)";/gm)]
      .map((m) => m[1] as string)
      .filter((spec) => spec.startsWith("@/pages/") || spec === "@/admin/app");
    expect(eager).toEqual([]);

    // And the flip side: everything the routes render is behind `lazy()`, so
    // the check above cannot be satisfied by simply not rendering a page.
    const lazyBound = new Set(
      [...src.matchAll(/const\s+(\w+)\s*=\s*lazy\(/g)].map((m) => m[1] as string),
    );
    const rendered = new Set(
      [...src.matchAll(/element=\{<(\w+)[\s/>]/g)].map((m) => m[1] as string),
    );
    // `AdminRoute` is declared in this file — it is the catch-all's wrapper, and
    // the thing it renders (`AdminApp`) is itself lazy.
    const notLazy = [...rendered].filter(
      (name) => name !== "AdminRoute" && !lazyBound.has(name),
    );
    expect(notLazy).toEqual([]);
  });

  /**
   * What the shell renders before it knows who is looking.
   *
   * `main.tsx` and `App.tsx` load for every visitor, admin or stranger, so
   * anything they import is in front of first paint by definition. That is easy
   * to forget for a *provider*, which reads as configuration rather than as
   * weight: a single `<TooltipProvider>` at the root pulled Radix — one pinned
   * chunk, 45 KB gzip — in front of a public booking page whose visitor will
   * never open a dropdown. It now lives inside the lazy admin chunk.
   *
   * The allow-list is what the shell genuinely needs to paint a route: the
   * toaster and the stylesheet. Adding to it should be a decision.
   */
  test("the eager shell pulls no admin-only UI", () => {
    const SHELL_UI = ["@backlex/ui/components/sonner", "@backlex/ui/globals.css"];

    for (const file of ["main.tsx", "App.tsx"]) {
      const src = readFileSync(join(CLIENT, file), "utf8");
      const ui = [...src.matchAll(/^import\s+[^;]*?"(@backlex\/ui\/[^"]+)";/gm)]
        .map((m) => m[1] as string)
        .filter((spec) => !SHELL_UI.includes(spec));
      expect(`${file}: ${ui.join(", ")}`).toBe(`${file}: `);
    }
  });
});

/**
 * The nav is wired in three places and two of them fail SILENTLY.
 *
 * Nothing in this repo asserted any of it before the Websites/Consent split, so
 * these are new. The failure modes, in the order they bite:
 *
 *  - A group array registered in the sidebar but left out of the `NAV_ITEMS`
 *    concatenation: the row renders, is clickable, and `app.tsx` rewrites the
 *    URL's meaning back to where you came from, because `NAV_IDS` is built from
 *    `NAV_ITEMS` alone. Clicking the sidebar cannot reproduce it.
 *  - A missing `NAV_LABELS` entry: the sidebar shows the raw lowercase id, and
 *    `i18n._({id})` returns the id by design, so nothing throws. The command
 *    palette then HIDES the defect — it filters on the label, so typing
 *    "consent" still finds a row labelled `consent`.
 */
describe("the admin nav is wired end to end", () => {
  // Relative to `src/client`, which this file already resolves.
  const src = (p: string) => readFileSync(join(CLIENT, p), "utf8");

  test("every group array is part of the NAV_ITEMS concatenation", () => {
    const config = src("admin/config.ts");
    const groups = [...config.matchAll(/export const (NAV_[A-Z_]+): NavItem\[\]/g)].map(
      (m) => m[1]!,
    );
    // The union itself, and the two rendered outside it, are not members.
    const members = groups.filter(
      (g) => !["NAV_ITEMS", "NAV_DEVELOPERS", "NAV_SETTINGS"].includes(g),
    );
    expect(members.length).toBeGreaterThan(3);

    const concat = config.slice(config.indexOf("export const NAV_ITEMS"));
    const listed = concat.slice(0, concat.indexOf("];"));
    for (const g of members) {
      expect(`${g} is spread into NAV_ITEMS: ${listed.includes(`...${g}`)}`).toBe(
        `${g} is spread into NAV_ITEMS: true`,
      );
    }
  });

  test("every group array is rendered by the sidebar", () => {
    // The other direction: an array that exists and is in `NAV_ITEMS` but is
    // never rendered gives a reachable URL with no way to click to it.
    const config = src("admin/config.ts");
    const ui = src("admin/ui.tsx");
    const groups = [...config.matchAll(/export const (NAV_[A-Z_]+): NavItem\[\]/g)]
      .map((m) => m[1]!)
      .filter((g) => !["NAV_ITEMS"].includes(g));
    for (const g of groups) {
      expect(`${g} reaches the sidebar: ${ui.includes(g)}`).toBe(
        `${g} reaches the sidebar: true`,
      );
    }
  });

  test("every nav id has a label, so none renders as a raw slug", () => {
    const config = src("admin/config.ts");
    const ui = src("admin/ui.tsx");
    const ids = [...config.matchAll(/\{ id: "([a-z0-9-]+)", icon:/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(20);

    const labels = ui.slice(ui.indexOf("const NAV_LABELS"));
    const labelBlock = labels.slice(0, labels.indexOf("\n};"));
    for (const id of ids) {
      const quoted = labelBlock.includes(`"${id}":`);
      const bare = new RegExp(`^\\s*${id}: msg\``, "m").test(labelBlock);
      expect(`${id} has a NAV_LABELS entry: ${quoted || bare}`).toBe(
        `${id} has a NAV_LABELS entry: true`,
      );
    }
  });

  test("every nav id with a lazy page is prefetchable and has a skeleton", () => {
    // Not every id is lazy — some pages render inline. But an id that IS lazy
    // and is missing from `LOADERS` flashes a Suspense fallback on every
    // navigation, which is the exact cost `page-prefetch.ts` exists to avoid.
    const app = src("admin/app.tsx");
    const prefetch = src("admin/lib/page-prefetch.ts");
    const skeletons = src("admin/page-skeletons.tsx");
    // `analytics` joined the list once it turned out to be lazy in app.tsx and
    // absent from LOADERS — the defect this rule describes, shipped.
    for (const id of ["websites", "consent", "tag-manager", "analytics"]) {
      expect(`${id} is lazy: ${app.includes(`pages/observability/${id}`)}`).toBe(
        `${id} is lazy: true`,
      );
      expect(`${id} is prefetchable: ${prefetch.includes(`observability/${id}`)}`).toBe(
        `${id} is prefetchable: true`,
      );
      expect(`${id} has a skeleton case: ${skeletons.includes(`case "${id}":`)}`).toBe(
        `${id} has a skeleton case: true`,
      );
    }
  });

  test("the tabs that became pages redirect, so old deep links do not land on Overview", () => {
    // `/analytics/sites` still passes `NAV_IDS.has("analytics")`, and the
    // unknown second segment falls back to the default tab — so without a
    // redirect the address bar keeps saying `sites` while Overview renders and
    // the operator concludes the feature was deleted.
    const app = src("admin/app.tsx");
    expect(app).toContain('segs[1] === "sites"');
    expect(app).toContain('navigate("/websites"');
    expect(app).toContain('segs[1] === "consent"');
    expect(app).toContain('navigate("/consent"');
  });

  test("the surfaces that need a website can reach the page that registers one", () => {
    // Requirement, not decoration: both empty states used to name a tab and
    // offer no way to get to it, and one of them named a tab that no longer
    // exists.
    for (const f of [
      "admin/pages/observability/consent.tsx",
      "admin/pages/observability/tag-manager.tsx",
    ]) {
      const s = src(f);
      expect(`${f} offers the CTA: ${s.includes('setActiveNav("websites")')}`).toBe(
        `${f} offers the CTA: true`,
      );
      // …and no longer points at a tab that is gone.
      expect(`${f} still says "Sites tab": ${/Sites tab|Analytics → Sites/.test(s)}`).toBe(
        `${f} still says "Sites tab": false`,
      );
    }
  });
});
