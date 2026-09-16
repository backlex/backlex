import type { ClientCore } from "../core";

/** Page setup for a rendered document. Defaults: A4 portrait, 20mm margins. */
export interface PdfPageOptions {
  format?: "A4" | "Letter" | "Legal" | "A3" | "A5";
  landscape?: boolean;
  margin?: string | { top?: string; right?: string; bottom?: string; left?: string };
  /** Backgrounds print by DEFAULT here, unlike a browser's print dialog. */
  printBackground?: boolean;
}

/**
 * Theme, accent and font — the settings a form stores, in the same shape. A
 * template reads them as `{{ theme.mode }}`, `{{ theme.accent }}`,
 * `{{ theme.accentInk }}`, `{{ theme.bg }}`, `{{ theme.card }}`,
 * `{{ theme.text }}`, `{{ theme.muted }}`, `{{ theme.faint }}`,
 * `{{ theme.border }}`, `{{ theme.font }}` and `{{ theme.fontsHref }}`; an
 * unset template renders against the light defaults.
 */
export interface TemplateAppearance {
  theme?: "light" | "dark";
  /** `#rrggbb`. */
  accent?: string;
  font?: "sans" | "lexend" | "mono" | "system";
}

/** A stored HTML template a document is rendered from. */
export interface DocumentTemplate {
  id: string;
  key: string;
  name: string;
  description: string | null;
  /** A COMPLETE html document, not a fragment. */
  bodyHtml: string;
  headerHtml: string | null;
  footerHtml: string | null;
  pageOptions: PdfPageOptions;
  filename: string | null;
  variables: string[];
  appearance: TemplateAppearance | null;
  /** True for an instance-wide default this workspace has not overridden.
   *  Saving one creates the override rather than changing the shared row. */
  inherited: boolean;
  /** This workspace's copy shadows an instance-wide default; deleting it
   *  restores the default. */
  overridesDefault: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface DocumentTemplateInput {
  name?: string;
  description?: string | null;
  bodyHtml?: string;
  headerHtml?: string | null;
  footerHtml?: string | null;
  pageOptions?: PdfPageOptions | null;
  filename?: string | null;
  variables?: string[] | null;
  /** Null clears it. */
  appearance?: TemplateAppearance | null;
}

export interface RenderDocumentInput {
  /** Exactly one of these two. */
  templateKey?: string;
  html?: string;
  /** Running header / footer for `html`. Ignored with `templateKey`. */
  headerHtml?: string | null;
  footerHtml?: string | null;
  /** Overrides the template's own appearance for this render. */
  appearance?: TemplateAppearance | null;
  vars?: Record<string, unknown>;
  pageOptions?: PdfPageOptions;
  filename?: string;
}

/**
 * Document generation (admin-scoped). Mirrors `/api/admin/documents`.
 *
 * `render` resolves to the PDF BYTES. There is deliberately no renderer bundled
 * with the server, so a deployment with none configured rejects the call rather
 * than returning a document with broken glyphs — see the Documents guide.
 */
export interface DocumentsClient {
  /** List this workspace's templates; an override hides the shared default. */
  list(): Promise<{ data: DocumentTemplate[] }>;
  /** Create or update a template. Always writes a workspace-scoped row. */
  save(key: string, input: DocumentTemplateInput): Promise<{ data: DocumentTemplate }>;
  /** Delete this workspace's own row. An inherited default 404s. `data` is what
   *  the key resolves to afterwards: the default it overrode, or null. */
  delete(key: string): Promise<{ ok: boolean; data: DocumentTemplate | null }>;
  /** Render to PDF bytes. */
  render(input: RenderDocumentInput): Promise<Uint8Array>;
}

export const makeDocuments = (core: ClientCore): DocumentsClient => {
  const documents: DocumentsClient = {
    list: () => core.request<{ data: DocumentTemplate[] }>("GET", "/api/admin/documents/templates"),
    save: (key: string, input: DocumentTemplateInput) =>
      core.request<{ data: DocumentTemplate }>(
        "PUT",
        `/api/admin/documents/templates/${encodeURIComponent(key)}`,
        input,
      ),
    delete: (key: string) =>
      core.request<{ ok: boolean; data: DocumentTemplate | null }>(
        "DELETE",
        `/api/admin/documents/templates/${encodeURIComponent(key)}`,
      ),
    // Bytes, not JSON: the endpoint answers `application/pdf`, so this goes
    // through the raw path rather than the JSON one.
    render: async (input: RenderDocumentInput) => {
      const res = await core.requestRaw(
        "POST",
        "/api/admin/documents/render",
        JSON.stringify(input),
        "application/json",
      );
      return new Uint8Array(await res.arrayBuffer());
    },
  };

  return documents;
};
