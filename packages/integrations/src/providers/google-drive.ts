import { OAUTH_ACCESS_TOKEN_KEY, defineProvider } from "../provider";

/**
 * Google Drive — index a folder's files as a collection.
 *
 * Metadata only, and the scope says so: `drive.metadata.readonly` cannot read
 * file CONTENT even if this code tried to. Pulling bytes into storage is a
 * different feature with different limits (size, cost, virus scanning), and
 * asking for a scope that could do it in order not to would be the wrong shape
 * to hand an admin on a consent screen.
 */

/** Drive's own page cap for a list. */
const PAGE = 100;

/** Only what a collection can usefully hold; `parents` and permissions are
 *  graph data that would need their own collections to mean anything. */
const FIELDS = "nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime,webViewLink,trashed)";

export const googleDrive = defineProvider({
  id: "google-drive",
  label: "Google Drive",
  category: "productivity",
  capabilities: ["source"],
  configFields: [
    { key: "clientId", label: "OAuth client ID", placeholder: "….apps.googleusercontent.com" },
    { key: "clientSecret", label: "OAuth client secret", placeholder: "GOCSPX-…", secret: true },
  ],
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/drive.metadata.readonly"],
    // Without both of these Google issues no refresh token.
    authorizeParams: { access_type: "offline", prompt: "consent" },
    pkce: true,
    tokenAuth: "body",
  },
  source: {
    settingFields: [
      { key: "folderId", label: "Folder ID", placeholder: "the id in the folder's URL" },
      {
        key: "includeTrashed",
        label: "Trashed files",
        options: [
          { value: "no", label: "Skip files in the trash" },
          { value: "yes", label: "Include files in the trash" },
        ],
      },
    ],
    async pull(ctx) {
      const token = ctx.str(OAUTH_ACCESS_TOKEN_KEY);
      const folderId = ctx.setting("folderId");
      if (!token || !folderId) throw new Error("Google Drive sync is missing its folder id");

      const url = new URL("https://www.googleapis.com/drive/v3/files");
      // The folder id is quoted into Drive's query language, so a value
      // carrying a quote could change the clause. Refuse rather than escape:
      // Drive ids are opaque but always alphanumeric with - and _.
      if (!/^[A-Za-z0-9_-]+$/.test(folderId)) {
        throw new Error(`Google Drive folder id "${folderId}" is not a valid id`);
      }
      const trashClause = ctx.setting("includeTrashed") === "yes" ? "" : " and trashed = false";
      url.searchParams.set("q", `'${folderId}' in parents${trashClause}`);
      url.searchParams.set("fields", FIELDS);
      url.searchParams.set("pageSize", String(Math.min(ctx.limit, PAGE)));
      // Drive's page token is opaque and belongs in a query parameter.
      if (ctx.cursor) url.searchParams.set("pageToken", ctx.cursor);

      const res = await ctx.fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Google Drive responded ${res.status}`);
      const body = (await res.json()) as {
        files?: Record<string, unknown>[];
        nextPageToken?: string;
      };

      const records = (body.files ?? [])
        .filter((f): f is { id: string } & Record<string, unknown> => typeof f.id === "string")
        .map((f) => ({
          externalId: f.id,
          // `size` arrives as a STRING from Drive and would fail a number
          // column; folders have none at all.
          data: { ...f, size: f.size === undefined ? null : Number(f.size) },
        }));

      return { records, cursor: body.nextPageToken ?? null };
    },
  },
});
