/**
 * The few shapes more than one admin domain reaches for.
 *
 * Everything else lives with the `xApi` namespace that uses it — see `api.ts`.
 * A type that starts being shared moves here; one that stops being shared moves
 * back out. Keeping the list short is the point.
 */
export interface Envelope<T> {
  data: T;
  active?: string | null;
}

export interface ApiDocumentTemplate {
  id: string;
  key: string;
  name: string;
  description: string | null;
  /** A COMPLETE html document, not a fragment. */
  bodyHtml: string;
  headerHtml: string | null;
  footerHtml: string | null;
  pageOptions: {
    format?: "A4" | "Letter" | "Legal" | "A3" | "A5";
    landscape?: boolean;
    margin?: string;
    printBackground?: boolean;
  };
  filename: string | null;
  variables: string[] | null;
  /** An instance-wide default this workspace has not overridden. Saving one
   *  creates the override; it never changes the shared row. */
  inherited: boolean;
}
