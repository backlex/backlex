import { api, API_BASE, captureBookmark, sessionHeaders } from "@/lib/api";
import type { ApiDocumentTemplate } from "./types";
import type { Envelope } from "./types";

export interface ApiSignatureSigner {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  order: number;
  status: "pending" | "viewed" | "signed" | "declined";
  sentAt: number | string | null;
  viewedAt: number | string | null;
  signedAt: number | string | null;
  declinedAt: number | string | null;
  declineReason: string | null;
  signatureKind: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface ApiSignatureRequest {
  id: string;
  title: string;
  message: string | null;
  templateKey: string | null;
  /** `expired` is derived from the expiry timestamp, not stored. */
  status: "pending" | "completed" | "declined" | "voided" | "expired";
  ordered: boolean;
  documentHash: string;
  documentKey: string | null;
  signedDocumentKey: string | null;
  signedDocumentHash: string | null;
  filename: string | null;
  expiresAt: number | string | null;
  completedAt: number | string | null;
  voidedAt: number | string | null;
  voidReason: string | null;
  writeBack: { collection: string; id: string; field: string } | null;
  notifyEmails: string[];
  createdBy: string | null;
  createdAt: number | string | null;
  updatedAt: number | string | null;
  signers: ApiSignatureSigner[];
  /** Only on the single-request read — the frozen document that was sent. */
  bodyHtml?: string;
}

/** The signer's view of their own link (`GET /api/public/sign/:token`). */
export interface ApiSignerView {
  title: string;
  message: string | null;
  status: ApiSignatureRequest["status"];
  signerStatus: ApiSignatureSigner["status"];
  signerName: string | null;
  signerEmail: string;
  signerRole: string | null;
  yourTurn: boolean;
  signedCount: number;
  signerCount: number;
  expiresAt: number | string | null;
  documentHash: string;
  /** Server-owned wording; the page displays it verbatim and never composes
   *  its own — the certificate quotes this exact string. */
  consentText: string;
  html: string;
  completedAt: number | string | null;
}

export const documentsApi = {
  list: () => api<Envelope<ApiDocumentTemplate[]>>(`/api/admin/documents/templates`),
  save: (key: string, body: Partial<ApiDocumentTemplate>) =>
    api<Envelope<ApiDocumentTemplate>>(`/api/admin/documents/templates/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  remove: (key: string) =>
    api<{ ok: true }>(`/api/admin/documents/templates/${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),
  /** Returns the PDF itself, so this bypasses the JSON envelope helper. */
  render: async (body: Record<string, unknown>): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/api/admin/documents/render`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", ...sessionHeaders() },
      body: JSON.stringify(body),
    });
    captureBookmark(res);
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(err.error?.message ?? `Render failed (${res.status})`);
    }
    return res.blob();
  },
};

export const signaturesApi = {
  list: (status?: string) =>
    api<Envelope<ApiSignatureRequest[]> & { total: number }>(
      `/api/admin/signatures${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  get: (id: string) => api<Envelope<ApiSignatureRequest>>(`/api/admin/signatures/${encodeURIComponent(id)}`),
  create: (body: Record<string, unknown>) =>
    api<
      Envelope<{
        request: ApiSignatureRequest;
        /** Shown once, right after creation — only hashes are stored. */
        links: Array<{ signerId: string; email: string; url: string }>;
        sent: boolean;
      }>
    >(`/api/admin/signatures`, { method: "POST", body: JSON.stringify(body) }),
  void: (id: string, reason?: string) =>
    api<Envelope<ApiSignatureRequest>>(`/api/admin/signatures/${encodeURIComponent(id)}/void`, {
      method: "POST",
      body: JSON.stringify({ reason: reason ?? null }),
    }),
  resend: (id: string, signerId: string) =>
    api<Envelope<{ sent: boolean; email: string }>>(
      `/api/admin/signatures/${encodeURIComponent(id)}/signers/${encodeURIComponent(signerId)}/resend`,
      { method: "POST" },
    ),
  /** Produce the signed copy for a request whose signers have all signed but
   *  whose artefact never rendered. Idempotent — see the route's own note. */
  finalize: (id: string) =>
    api<Envelope<ApiSignatureRequest>>(
      `/api/admin/signatures/${encodeURIComponent(id)}/finalize`,
      { method: "POST" },
    ),
  /** The stored PDF — bytes, so it bypasses the JSON envelope helper (and the
   *  bookmark capture that rides on it, which is why it is done by hand). */
  document: async (id: string, which: "original" | "signed" = "signed"): Promise<Blob> => {
    const res = await fetch(
      `${API_BASE}/api/admin/signatures/${encodeURIComponent(id)}/document?which=${which}`,
      { credentials: "include", headers: sessionHeaders() },
    );
    captureBookmark(res);
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(err.error?.message ?? `Download failed (${res.status})`);
    }
    return res.blob();
  },
};

/** The signer's side — unauthenticated, token in the path. */
export const signPublicApi = {
  /** `lang` is the locale the page actually rendered in — the server picks the
   *  consent wording from it and stores the sentence it picked. */
  get: (token: string, lang?: string) =>
    api<Envelope<ApiSignerView>>(
      `/api/public/sign/${encodeURIComponent(token)}${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`,
    ),
  sign: (
    token: string,
    body: { kind: "drawn" | "typed"; image?: string; text?: string; consent: boolean },
    lang?: string,
  ) =>
    api<Envelope<{ status: string; signedCount: number; signerCount: number; finalized: boolean }>>(
      `/api/public/sign/${encodeURIComponent(token)}/sign${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  decline: (token: string, reason: string | null) =>
    api<Envelope<{ status: string }>>(`/api/public/sign/${encodeURIComponent(token)}/decline`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  documentUrl: (token: string) => `${API_BASE}/api/public/sign/${encodeURIComponent(token)}/document`,
};

export interface ApiApprover {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  order: number;
  status: "pending" | "viewed" | "approved" | "rejected";
  sentAt?: unknown;
  viewedAt?: unknown;
  decidedAt?: unknown;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface ApiApprovalRequest {
  id: string;
  title: string;
  message: string | null;
  subject: { collection: string; id: string } | null;
  summary: Array<{ label: string; value: string }>;
  policy: "all" | "any" | "quorum";
  quorum: number;
  ordered: boolean;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  expiresAt?: unknown;
  settledAt?: unknown;
  outcomeReason: string | null;
  writeBack: Record<string, unknown> | null;
  createdBy: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  approvers: ApiApprover[];
}

/** Approvals, operator side. There is no decide call here on purpose — that is
 *  the approver's act, authenticated by their own link. */
export const approvalsApi = {
  list: (status?: string) =>
    api<Envelope<ApiApprovalRequest[]>>(
      `/api/admin/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  get: (id: string) => api<Envelope<ApiApprovalRequest>>(`/api/admin/approvals/${encodeURIComponent(id)}`),
  cancel: (id: string, reason: string | null) =>
    api<Envelope<ApiApprovalRequest>>(`/api/admin/approvals/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
};

export interface ApiApprovalDecisionView {
  title: string;
  message: string | null;
  summary: Array<{ label: string; value: string }>;
  status: string;
  policy: string;
  ordered: boolean;
  expiresAt?: unknown;
  you: {
    email: string;
    name: string | null;
    role: string | null;
    status: string;
    position: number;
    of: number;
  };
  decided: Array<{ name: string | null; email: string; status: string; decidedAt?: unknown }>;
  /** Non-null when the page must explain why it cannot be acted on. */
  blocked: string | null;
}

/** The approver's side — unauthenticated, token in the path. */
export const approvePublicApi = {
  get: (token: string) =>
    api<Envelope<ApiApprovalDecisionView>>(`/api/public/approve/${encodeURIComponent(token)}`),
  decide: (token: string, decision: "approve" | "reject", reason?: string) =>
    api<Envelope<{ status: string; outcome: string }>>(
      `/api/public/approve/${encodeURIComponent(token)}`,
      { method: "POST", body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }) },
    ),
};
