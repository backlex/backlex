import type { PdfPageOptions } from "./documents";
import type { ClientCore } from "../core";

export type SignatureStatus = "pending" | "completed" | "declined" | "voided" | "expired";

export type SignerStatus = "pending" | "viewed" | "signed" | "declined";

export interface SignatureSigner {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  order: number;
  status: SignerStatus;
  sentAt?: unknown;
  viewedAt?: unknown;
  signedAt?: unknown;
  declinedAt?: unknown;
  declineReason: string | null;
  signatureKind: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface SignatureRequest {
  id: string;
  title: string;
  message: string | null;
  templateKey: string | null;
  /** `expired` is derived from the expiry timestamp rather than stored, so it
   *  becomes true by the clock alone. */
  status: SignatureStatus;
  ordered: boolean;
  /** SHA-256 of the frozen document SOURCE, not of the PDF bytes. */
  documentHash: string;
  documentKey: string | null;
  signedDocumentKey: string | null;
  signedDocumentHash: string | null;
  filename: string | null;
  expiresAt?: unknown;
  completedAt?: unknown;
  voidedAt?: unknown;
  voidReason: string | null;
  writeBack: { collection: string; id: string; field: string } | null;
  notifyEmails: string[];
  createdBy: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  signers: SignatureSigner[];
  /** Only on the single-request read: the document as it was frozen. */
  bodyHtml?: string;
}

export interface SignatureSignerInput {
  email: string;
  name?: string | null;
  role?: string | null;
}

export interface CreateSignatureRequestInput {
  title?: string;
  message?: string | null;
  /** Exactly one of these two. */
  templateKey?: string;
  html?: string;
  vars?: Record<string, unknown>;
  pageOptions?: PdfPageOptions;
  filename?: string;
  signers: SignatureSignerInput[];
  /** Each link only opens once the one before it has signed. */
  ordered?: boolean;
  expiresInDays?: number;
  /** Where the SIGNED document's storage key lands once everyone signs. */
  writeBack?: { collection: string; id: string; field: string } | null;
  notifyEmails?: string[];
  /** Off returns the links without emailing them. */
  send?: boolean;
}

/**
 * E-signature (admin-scoped). Mirrors `/api/admin/signatures`.
 *
 * `create` returns the plaintext signing links **once** — only their hashes are
 * stored, so nothing can reproduce them afterwards. `void` and `resend` both
 * mint a new token, which is what makes a link that went astray stop working.
 */
export interface SignaturesClient {
  list(opts?: { status?: SignatureStatus; limit?: number; offset?: number }): Promise<{
    data: SignatureRequest[];
    total: number;
  }>;
  /** Includes the frozen document HTML. */
  get(id: string): Promise<{ data: SignatureRequest }>;
  /** Freeze a document and send it out. The links come back here and nowhere
   *  else. */
  /** Alias of {@link SignaturesClient.create} — the verb the CLI
   *  (`signatures send`) and MCP (`signatures.send`) use. */
  send(input: CreateSignatureRequestInput): Promise<{
    data: {
      request: SignatureRequest;
      links: Array<{ signerId: string; email: string; url: string }>;
      sent: boolean;
    };
  }>;
  create(input: CreateSignatureRequestInput): Promise<{
    data: {
      request: SignatureRequest;
      links: Array<{ signerId: string; email: string; url: string }>;
      sent: boolean;
    };
  }>;
  /** Cancel, invalidating every outstanding link. */
  void(id: string, reason?: string | null): Promise<{ data: SignatureRequest }>;
  /** Re-send one signer's invitation with a FRESH link. */
  resend(id: string, signerId: string): Promise<{ data: { sent: boolean; email: string } }>;
  /** Produce the signed copy for a request everybody already signed — the
   *  recovery for a renderer that was down when the last signature landed. */
  finalize(id: string): Promise<{ data: SignatureRequest }>;
  /** The stored PDF: the signed copy by default, what was sent with
   *  `"original"`. */
  document(id: string, which?: "original" | "signed"): Promise<Uint8Array>;
}

/* ── Approvals (#36) ───────────────────────────────────────────────────── */

export const makeSignatures = (core: ClientCore): SignaturesClient => {
  const sig = (id: string) => `/api/admin/signatures/${encodeURIComponent(id)}`;
  const signatures: SignaturesClient = {
    list: (opts) => {
      const q = new URLSearchParams();
      if (opts?.status) q.set("status", opts.status);
      if (opts?.limit != null) q.set("limit", String(opts.limit));
      if (opts?.offset != null) q.set("offset", String(opts.offset));
      const qs = q.toString();
      return core.request<{ data: SignatureRequest[]; total: number }>(
        "GET",
        `/api/admin/signatures${qs ? `?${qs}` : ""}`,
      );
    },
    get: (id: string) => core.request<{ data: SignatureRequest }>("GET", sig(id)),
    create: (input: CreateSignatureRequestInput) =>
      core.request<{
        data: {
          request: SignatureRequest;
          links: Array<{ signerId: string; email: string; url: string }>;
          sent: boolean;
        };
      }>("POST", "/api/admin/signatures", input),
    /** Alias of {@link SignaturesClient.create}. The CLI (`signatures send`)
     *  and MCP (`signatures.send`) both call it this, and it is what the act
     *  actually is — you send a document out to be signed. Kept beside `create`
     *  so the SDK stays internally consistent and either name works. */
    send: (input: CreateSignatureRequestInput) => signatures.create(input),
    void: (id: string, reason?: string | null) =>
      core.request<{ data: SignatureRequest }>("POST", `${sig(id)}/void`, { reason: reason ?? null }),
    resend: (id: string, signerId: string) =>
      core.request<{ data: { sent: boolean; email: string } }>(
        "POST",
        `${sig(id)}/signers/${encodeURIComponent(signerId)}/resend`,
      ),
    finalize: (id: string) => core.request<{ data: SignatureRequest }>("POST", `${sig(id)}/finalize`),
    // Bytes, not JSON — same raw path the document render uses.
    document: async (id: string, which: "original" | "signed" = "signed") => {
      const res = await core.requestRaw("GET", `${sig(id)}/document?which=${which}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };

  return signatures;
};
