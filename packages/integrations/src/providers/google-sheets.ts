import { OAUTH_ACCESS_TOKEN_KEY, defineProvider } from "../provider";

/**
 * Google Sheets — read a sheet into a collection.
 *
 * Source-only: writing back would need a second scope and turns a spreadsheet
 * into a two-way store, which is a different feature with different failure
 * modes. Reading is the case people actually ask for (a team maintains a list
 * in Sheets; the app needs it as data).
 *
 * The first row is the header. That is a convention rather than a setting
 * because the alternative — asking for column letters — produces a mapping that
 * silently shifts the day someone inserts a column.
 */

/** Rows per pull. Sheets' own cap is far higher; this keeps one run bounded. */
const PAGE = 500;

/** A1 notation is `Sheet name!A1:Z100`. Only the sheet name is admin-supplied,
 *  and it goes into a URL path segment, so it is encoded whole. */
const rangeFor = (sheet: string, from: number, to: number) => `${sheet}!A${from}:ZZ${to}`;

export const googleSheets = defineProvider({
  id: "google-sheets",
  label: "Google Sheets",
  category: "productivity",
  capabilities: ["source"],
  configFields: [
    { key: "clientId", label: "OAuth client ID", placeholder: "….apps.googleusercontent.com" },
    { key: "clientSecret", label: "OAuth client secret", placeholder: "GOCSPX-…", secret: true },
  ],
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    // Without both of these Google issues no refresh token, and the connection
    // dies silently an hour later.
    authorizeParams: { access_type: "offline", prompt: "consent" },
    pkce: true,
    tokenAuth: "body",
  },
  source: {
    settingFields: [
      { key: "spreadsheetId", label: "Spreadsheet ID", placeholder: "the long id in the sheet's URL" },
      { key: "sheetName", label: "Sheet name", placeholder: "Sheet1" },
    ],
    async pull(ctx) {
      const token = ctx.str(OAUTH_ACCESS_TOKEN_KEY);
      const spreadsheetId = ctx.setting("spreadsheetId");
      const sheetName = ctx.setting("sheetName") ?? "Sheet1";
      if (!token || !spreadsheetId) throw new Error("Google Sheets sync is missing its spreadsheet id");

      // The cursor is the 1-based row we resume at. It came back out of our own
      // database, so it is parsed rather than trusted: a junk value must not
      // become part of a range and silently read the wrong rows.
      const start = Math.max(2, Number.parseInt(ctx.cursor ?? "2", 10) || 2);
      const limit = Math.min(ctx.limit, PAGE);

      const read = async (range: string) => {
        const url =
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
          `/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
        const res = await ctx.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Google Sheets responded ${res.status}`);
        return ((await res.json()) as { values?: unknown[][] }).values ?? [];
      };

      const header = (await read(rangeFor(sheetName, 1, 1)))[0] ?? [];
      if (header.length === 0) return { records: [], cursor: null };
      const columns = header.map((h, i) => (typeof h === "string" && h.trim() ? h.trim() : `column_${i + 1}`));

      const rows = await read(rangeFor(sheetName, start, start + limit - 1));
      const records = rows
        .map((row, i) => ({
          // The row number IS the identity. Sheets has no row id, so a row that
          // moves is a different record — the alternative (hashing contents)
          // makes every edit look like a delete plus an insert.
          externalId: String(start + i),
          data: Object.fromEntries(columns.map((c, ci) => [c, row[ci] ?? null])),
        }))
        // Trailing blank rows are how a sheet ends; they are not data.
        .filter((r) => Object.values(r.data).some((v) => v !== null && v !== ""));

      // A short page means the sheet ran out, so the run ends and the next one
      // starts over from the top and picks up edits.
      return { records, cursor: rows.length < limit ? null : String(start + rows.length) };
    },
  },
});
