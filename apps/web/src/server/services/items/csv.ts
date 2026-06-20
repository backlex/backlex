/**
 * Tiny dependency-free CSV (RFC 4180-ish) reader/writer for the per-collection
 * export/import endpoints. Good enough for spreadsheet round-trips: quotes
 * fields containing delimiters/quotes/newlines, escapes `"` as `""`, and parses
 * the same back. Object/array cells are JSON on the way out; the import route
 * coerces strings back to field types on the way in.
 */

const needsQuote = (s: string): boolean =>
  s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r");

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return needsQuote(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Serialize rows to a CSV string. Columns fix the order; cells missing from a
 *  row render as empty. */
export const toCsv = (
  rows: Record<string, unknown>[],
  columns: string[],
): string => {
  const lines = [columns.map(cell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => cell(row[c])).join(","));
  }
  return lines.join("\n");
};

/**
 * Parse a CSV string into an array of header-keyed string records. Handles
 * quoted fields (with embedded commas/newlines/`""`), `\r\n` and `\n` line
 * endings, and a trailing newline. Empty input → `[]`.
 */
export const parseCsv = (text: string): Record<string, string>[] => {
  const rows: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    pushField();
    rows.push(record);
    record = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // Swallow CR; the following LF (if any) closes the record.
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Flush the last field/record unless the input ended on a clean newline.
  if (field.length > 0 || record.length > 0) pushRecord();

  if (rows.length === 0) return [];
  const header = rows[0] ?? [];
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r] ?? [];
    // Skip blank trailing lines (a single empty cell, no real data).
    if (cells.length === 1 && cells[0] === "") continue;
    const obj: Record<string, string> = {};
    header.forEach((key, idx) => {
      obj[key] = cells[idx] ?? "";
    });
    out.push(obj);
  }
  return out;
};
