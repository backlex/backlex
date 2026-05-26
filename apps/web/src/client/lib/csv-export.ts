/**
 * Minimal client-side CSV exporter.
 *
 * Extracted from the Activity Log page (admin/pages/logs.tsx) so the Ask
 * AI Runs tab can share the exact escaping + Blob-download path. Both
 * call sites are admin-only and run in the browser; this helper assumes
 * `window`, `Blob`, and `URL.createObjectURL` exist.
 */

/** RFC 4180 quoting — wrap every cell in double quotes and escape any
 *  embedded double quote by doubling it. The header behaviour matches
 *  Excel + LibreOffice + Numbers. */
const csvQuote = (value: unknown): string =>
  `"${String(value ?? "").replace(/"/g, '""')}"`;

/**
 * Triggers a browser download of `rows` as a CSV named `filename`.
 *
 * - `columns` (optional) — fixes the column order and acts as the CSV
 *   header row. Falls back to `Object.keys(rows[0])` when omitted.
 * - The function returns silently when `rows` is empty; callers that want
 *   to surface "nothing to export" should guard before calling.
 */
export function exportToCsv(
  rows: Record<string, unknown>[],
  filename: string,
  columns?: string[],
): void {
  if (rows.length === 0) return;
  const first = rows[0]!;
  const cols = columns ?? Object.keys(first);
  const header = cols.map(csvQuote).join(",");
  const body = rows
    .map((row) => cols.map((c) => csvQuote(row[c])).join(","))
    .join("\n");
  const blob = new Blob([`${header}\n${body}`], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
