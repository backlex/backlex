import type { Condition } from "@workeros/core";

/**
 * Hybrid filter parser. The flow builder's "test" textarea accepts:
 *
 *   1. Raw JSON in the same shape the runtime evaluator wants —
 *      { "status": { "_eq": "published" } }
 *
 *   2. A short DSL for single-line conditions —
 *      status _eq "published"
 *      tags _contains "release"
 *      AND / OR / NOT keywords for combining clauses.
 *
 * Round-tripping always emits JSON: it's the lossless form. The DSL is
 * just keystroke convenience for the common case.
 */

const COMPARATORS = [
  "_eq",
  "_neq",
  "_in",
  "_nin",
  "_gt",
  "_gte",
  "_lt",
  "_lte",
  "_null",
  "_contains",
  "_starts_with",
  "_ends_with",
] as const;
type Comparator = (typeof COMPARATORS)[number];

export class FilterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterParseError";
  }
}

export const parseFilter = (input: string): Condition => {
  const trimmed = input.trim();
  if (!trimmed) throw new FilterParseError("Filter is empty");

  // Try JSON first — `{` always wins. Falls through on bare DSL.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as Condition;
    } catch (e) {
      throw new FilterParseError(`Invalid JSON: ${(e as Error).message}`);
    }
  }

  // DSL path.
  const tokens = tokenize(trimmed);
  const parser = new DslParser(tokens, trimmed);
  const cond = parser.parseExpr();
  parser.expectEnd();
  return cond;
};

/** Pretty-print a Condition as JSON for the builder textarea. */
export const stringifyFilter = (cond: Condition): string =>
  JSON.stringify(cond, null, 2);

/* ─────────────────────────── tokenizer ─────────────────────────── */

type Tok =
  | { t: "ident"; v: string; pos: number }
  | { t: "op"; v: Comparator; pos: number }
  | { t: "string"; v: string; pos: number }
  | { t: "number"; v: number; pos: number }
  | { t: "bool"; v: boolean; pos: number }
  | { t: "null"; pos: number }
  | { t: "lparen"; pos: number }
  | { t: "rparen"; pos: number }
  | { t: "lbracket"; pos: number }
  | { t: "rbracket"; pos: number }
  | { t: "comma"; pos: number }
  | { t: "and" | "or" | "not"; pos: number };

const tokenize = (src: string): Tok[] => {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    const pos = i;
    if (c === "(") { out.push({ t: "lparen", pos }); i++; continue; }
    if (c === ")") { out.push({ t: "rparen", pos }); i++; continue; }
    if (c === "[") { out.push({ t: "lbracket", pos }); i++; continue; }
    if (c === "]") { out.push({ t: "rbracket", pos }); i++; continue; }
    if (c === ",") { out.push({ t: "comma", pos }); i++; continue; }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let str = "";
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < src.length) {
          str += src[j + 1];
          j += 2;
        } else {
          str += src[j];
          j++;
        }
      }
      if (j >= src.length)
        throw new FilterParseError(`Unterminated string at ${pos}`);
      out.push({ t: "string", v: str, pos });
      i = j + 1;
      continue;
    }
    // Number (allow leading minus)
    const numMatch = /^-?\d+(?:\.\d+)?/.exec(src.slice(i));
    if (numMatch && (i === 0 || /[\s(,\[]/.test(src[i - 1] ?? " "))) {
      out.push({ t: "number", v: Number(numMatch[0]), pos });
      i += numMatch[0].length;
      continue;
    }
    // _comparator (always starts with underscore)
    if (c === "_") {
      const m = /^_[a-z_]+/.exec(src.slice(i));
      if (m && (COMPARATORS as readonly string[]).includes(m[0])) {
        out.push({ t: "op", v: m[0] as Comparator, pos });
        i += m[0].length;
        continue;
      }
    }
    // Identifier or keyword (including dotted paths so `item.author.email`
    // parses as a single ident token).
    const idMatch = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (idMatch) {
      const v = idMatch[0];
      const lower = v.toLowerCase();
      if (lower === "and" || lower === "or" || lower === "not") {
        out.push({ t: lower, pos });
      } else if (lower === "true" || lower === "false") {
        out.push({ t: "bool", v: lower === "true", pos });
      } else if (lower === "null") {
        out.push({ t: "null", pos });
      } else {
        out.push({ t: "ident", v, pos });
      }
      i += v.length;
      continue;
    }
    throw new FilterParseError(`Unexpected character "${c}" at ${pos}`);
  }
  return out;
};

/* ─────────────────────────── parser ─────────────────────────── */

class DslParser {
  private idx = 0;
  constructor(private toks: Tok[], private src: string) {}

  private peek(): Tok | undefined {
    return this.toks[this.idx];
  }
  private next(): Tok {
    const t = this.toks[this.idx];
    if (!t) throw new FilterParseError(`Unexpected end of filter "${this.src}"`);
    this.idx++;
    return t;
  }
  expectEnd(): void {
    if (this.idx < this.toks.length) {
      const t = this.toks[this.idx]!;
      throw new FilterParseError(
        `Trailing token "${describe(t)}" at ${t.pos}`,
      );
    }
  }

  /** OR has lowest precedence. */
  parseExpr(): Condition {
    const parts: Condition[] = [this.parseAnd()];
    while (this.peek()?.t === "or") {
      this.next();
      parts.push(this.parseAnd());
    }
    if (parts.length === 1) return parts[0]!;
    return { $or: parts };
  }

  private parseAnd(): Condition {
    const parts: Condition[] = [this.parsePrimary()];
    while (this.peek()?.t === "and") {
      this.next();
      parts.push(this.parsePrimary());
    }
    if (parts.length === 1) return parts[0]!;
    return { $and: parts };
  }

  private parsePrimary(): Condition {
    const tok = this.peek();
    if (!tok) throw new FilterParseError("Empty primary expression");
    if (tok.t === "not") {
      this.next();
      return { $not: this.parsePrimary() };
    }
    if (tok.t === "lparen") {
      this.next();
      const inner = this.parseExpr();
      const close = this.next();
      if (close.t !== "rparen")
        throw new FilterParseError(`Missing ) at ${close.pos}`);
      return inner;
    }
    return this.parseComparison();
  }

  private parseComparison(): Condition {
    const fieldTok = this.next();
    if (fieldTok.t !== "ident")
      throw new FilterParseError(
        `Expected field name at ${fieldTok.pos}, got "${describe(fieldTok)}"`,
      );
    const opTok = this.next();
    if (opTok.t !== "op")
      throw new FilterParseError(
        `Expected comparator (e.g. _eq) at ${opTok.pos}, got "${describe(opTok)}"`,
      );
    // `_null` doesn't consume a value when used as `field _null` — but for
    // simplicity require an explicit boolean. (`_null true` / `_null false`)
    const value = this.parseValue();

    // Strip the `item.` / `data.` namespace from the field — the runtime
    // evaluator looks up keys directly on the row, not on a wrapper.
    const field = fieldTok.v.replace(/^(?:item|data|row|record)\./, "");
    return { [field]: { [opTok.v]: value } };
  }

  private parseValue(): unknown {
    const t = this.next();
    if (t.t === "string") return t.v;
    if (t.t === "number") return t.v;
    if (t.t === "bool") return t.v;
    if (t.t === "null") return null;
    if (t.t === "lbracket") {
      const items: unknown[] = [];
      if (this.peek()?.t !== "rbracket") {
        items.push(this.parseValue());
        while (this.peek()?.t === "comma") {
          this.next();
          items.push(this.parseValue());
        }
      }
      const close = this.next();
      if (close.t !== "rbracket")
        throw new FilterParseError(`Missing ] at ${close.pos}`);
      return items;
    }
    if (t.t === "ident") return t.v; // bare identifier as string
    throw new FilterParseError(
      `Expected value at ${t.pos}, got "${describe(t)}"`,
    );
  }
}

const describe = (t: Tok): string => {
  switch (t.t) {
    case "ident": return t.v;
    case "op": return t.v;
    case "string": return `"${t.v}"`;
    case "number": return String(t.v);
    case "bool": return String(t.v);
    case "null": return "null";
    case "lparen": return "(";
    case "rparen": return ")";
    case "lbracket": return "[";
    case "rbracket": return "]";
    case "comma": return ",";
    case "and":
    case "or":
    case "not":
      return t.t;
  }
};
