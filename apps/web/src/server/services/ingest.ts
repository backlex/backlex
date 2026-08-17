/**
 * Document ingest — a stored file becomes rows in a collection, one per
 * section, ready for the vector index that already exists.
 *
 * The shape is the decision worth recording. The obvious version — one row per
 * document — runs straight into the chunk cap: `MAX_CHUNKS` bounds a row at
 * about 64 KB of indexed text, which is ten or fifteen pages, and a real
 * handbook is bigger, so the tail would go silently unindexed. Splitting into
 * sections instead means every row is short, the cap is never approached, and
 * search returns the section that answers the question rather than a document
 * the caller then has to read. That is also the granularity retrieval wants:
 * one row, one idea.
 *
 * **Only text-native formats.** `.txt`, `.md`, `.html`, `.csv` and `.json`
 * decode with no dependency at all and behave identically on all eight
 * runtimes this ships to. PDF and DOCX are deliberately refused by name rather
 * than half-supported: extracting them needs either a library that does not
 * work on workerd or Cloudflare's `AI.toMarkdown()`, which is a per-runtime
 * capability and belongs behind the adapter layer as its own piece of work.
 * A caller who sends one gets a 422 that says so.
 */
import { AppError, htmlToText } from "@backlex/core";

/**
 * Target size for one section, in characters.
 *
 * Comfortably above `CHUNK_CHARS` (2000) so a section is still allowed to
 * chunk into two or three passages — that is the retrieval granularity working
 * as intended — and far below the 32-chunk cap, so ingesting a large document
 * can never lose its tail the way a single-row ingest would.
 */
export const SECTION_CHARS = 4000;

/** What a caller may hand us, and what each one decodes to. */
const TEXT_TYPES = new Map<string, "text" | "html">([
  ["text/plain", "text"],
  ["text/markdown", "text"],
  ["text/x-markdown", "text"],
  ["text/csv", "text"],
  ["application/json", "text"],
  ["text/html", "html"],
  ["application/xhtml+xml", "html"],
]);

const EXT_TYPES = new Map<string, "text" | "html">([
  ["txt", "text"],
  ["md", "text"],
  ["markdown", "text"],
  ["csv", "text"],
  ["json", "text"],
  ["html", "html"],
  ["htm", "html"],
]);

/** Formats worth naming in the refusal, because they are what people try. */
const KNOWN_BINARY = new Set(["pdf", "docx", "doc", "pptx", "xlsx", "rtf", "odt"]);

const extOf = (key: string): string => {
  const base = key.split("/").pop() ?? key;
  const at = base.lastIndexOf(".");
  return at === -1 ? "" : base.slice(at + 1).toLowerCase();
};

/**
 * Decode a stored object to plain text, or refuse it by name.
 *
 * The declared content type wins when it is one we know; otherwise the
 * extension decides. A stored object often carries
 * `application/octet-stream` — a browser upload with no type sniffing — so
 * falling back to the key's extension is the difference between working and
 * refusing everything.
 */
export const extractText = (
  bytes: ArrayBuffer | Uint8Array,
  contentType: string | null | undefined,
  key: string,
): string => {
  const mime = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = extOf(key);
  const kind = TEXT_TYPES.get(mime) ?? EXT_TYPES.get(ext);

  if (!kind) {
    const what = KNOWN_BINARY.has(ext) ? `.${ext} files` : `"${mime || ext || "unknown"}"`;
    throw new AppError(
      "VALIDATION",
      `Cannot ingest ${what}. Text-native formats only: .txt, .md, .html, .csv, .json. ` +
        `Extracting PDF or Office documents needs a per-runtime capability this deployment does not have — convert the file first.`,
    );
  }

  // `fatal: false` on purpose: a document with one bad byte should ingest with
  // a replacement character rather than fail whole, which is what a caller
  // batch-ingesting a folder needs.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return kind === "html" ? htmlToText(text) : text;
};

export interface Section {
  /** The heading this section sits under, when the document had one. */
  title: string | null;
  body: string;
  /** 0-based position in the document, so re-ingest is comparable. */
  index: number;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * Split text into sections.
 *
 * Markdown headings first, because a document that has them has already been
 * divided by its author and any other boundary would be worse. Failing that,
 * paragraphs are accumulated up to `SECTION_CHARS` — the split then lands on a
 * blank line, never mid-sentence.
 *
 * A paragraph longer than the budget on its own is kept whole rather than cut:
 * the chunker downstream will split it for the index, and a row that ends
 * mid-clause reads badly to whoever opens it.
 */
export const splitSections = (text: string, max = SECTION_CHARS): Section[] => {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const lines = trimmed.split("\n");
  const hasHeadings = lines.some((l) => HEADING.test(l));

  const out: Section[] = [];
  const push = (title: string | null, body: string) => {
    const b = body.trim();
    if (b) out.push({ title, body: b, index: out.length });
  };

  if (hasHeadings) {
    let title: string | null = null;
    let buf: string[] = [];
    for (const line of lines) {
      const m = HEADING.exec(line);
      if (m) {
        push(title, buf.join("\n"));
        title = m[2]!;
        buf = [];
      } else {
        buf.push(line);
      }
    }
    push(title, buf.join("\n"));
    return out;
  }

  let buf = "";
  for (const para of trimmed.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (buf && buf.length + p.length + 2 > max) {
      push(null, buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  push(null, buf);
  return out;
};
