import type { ClientCore } from "../core";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

export type ApproverStatus = "pending" | "viewed" | "approved" | "rejected";

/** `all` — everyone must approve, and one rejection ends it. `any` — the first
 *  approval wins, and it only rejects when everybody has. `quorum` — N
 *  approvals, rejected as soon as N can no longer be reached. */
export type ApprovalPolicy = "all" | "any" | "quorum";

export interface Approver {
  id: string;
  email: string;
  name: string | null;
  /** The capacity they decide in — "Line manager", "Finance". */
  role: string | null;
  order: number;
  status: ApproverStatus;
  sentAt?: unknown;
  viewedAt?: unknown;
  decidedAt?: unknown;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
}

/** What the outcome writes onto the subject row. `collection`/`id` default to
 *  the request's subject. An EXPIRY writes `rejectedValue`: to everything
 *  downstream, a request nobody answered is a request that was not approved. */
export interface ApprovalWriteBack {
  collection?: string;
  id?: string;
  field: string;
  approvedValue?: unknown;
  rejectedValue?: unknown;
}

export interface ApprovalRequest {
  id: string;
  title: string;
  message: string | null;
  /** The row the decision is about. */
  subject: { collection: string; id: string } | null;
  /** What the approvers were shown, frozen at send time. */
  summary: Array<{ label: string; value: string }>;
  policy: ApprovalPolicy;
  quorum: number;
  ordered: boolean;
  status: ApprovalStatus;
  expiresAt?: unknown;
  settledAt?: unknown;
  outcomeReason: string | null;
  writeBack: ApprovalWriteBack | null;
  createdBy: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  approvers: Approver[];
}

export interface ApproverInput {
  email: string;
  name?: string | null;
  role?: string | null;
}

export interface CreateApprovalRequestInput {
  title: string;
  message?: string | null;
  approvers: ApproverInput[];
  policy?: ApprovalPolicy;
  /** Only read with `policy: "quorum"`, where it is required. */
  quorum?: number;
  /** Each link only opens once the one before it has decided. */
  ordered?: boolean;
  /** Default 72. On expiry the request REJECTS. */
  expiresInHours?: number;
  subject?: { collection: string; id: string } | null;
  summary?: Array<{ label: string; value: string }>;
  writeBack?: ApprovalWriteBack | null;
  notifyEmails?: string[];
  /** Off returns the links without emailing them. */
  send?: boolean;
}

/**
 * Approvals (admin-scoped). Mirrors `/api/admin/approvals`.
 *
 * `create` returns the plaintext decision links **once** — only their hashes
 * are stored, so nothing can reproduce them afterwards.
 *
 * There is deliberately no `decide` here: deciding is the approver's act,
 * authenticated by their link token and nothing else. An admin-authenticated
 * decision would also fire whatever the waiting flow does next.
 */
export interface ApprovalsClient {
  list(opts?: { status?: ApprovalStatus; limit?: number }): Promise<{ data: ApprovalRequest[] }>;
  /** The full decision trail — who was asked, who answered, when and why. */
  get(id: string): Promise<{ data: ApprovalRequest }>;
  /** Ask people to approve something. The links come back here and nowhere
   *  else. */
  create(input: CreateApprovalRequestInput): Promise<{
    data: {
      request: ApprovalRequest;
      links: Array<{ approverId: string; email: string; url: string }>;
      sent: boolean;
    };
  }>;
  /** Withdraw it, invalidating every outstanding link. Runs NEITHER flow
   *  branch. */
  cancel(id: string, reason?: string | null): Promise<{ data: ApprovalRequest }>;
}

/* ── Availability & booking (#32) ──────────────────────────────────────── */

export const makeApprovals = (core: ClientCore): ApprovalsClient => {
  const apv = (id: string) => `/api/admin/approvals/${encodeURIComponent(id)}`;
  const approvals: ApprovalsClient = {
    list: (opts) => {
      const q = new URLSearchParams();
      if (opts?.status) q.set("status", opts.status);
      if (opts?.limit != null) q.set("limit", String(opts.limit));
      const qs = q.toString();
      return core.request<{ data: ApprovalRequest[] }>(
        "GET",
        `/api/admin/approvals${qs ? `?${qs}` : ""}`,
      );
    },
    get: (id: string) => core.request<{ data: ApprovalRequest }>("GET", apv(id)),
    create: (input: CreateApprovalRequestInput) =>
      core.request<{
        data: {
          request: ApprovalRequest;
          links: Array<{ approverId: string; email: string; url: string }>;
          sent: boolean;
        };
      }>("POST", "/api/admin/approvals", input),
    cancel: (id: string, reason?: string | null) =>
      core.request<{ data: ApprovalRequest }>("POST", `${apv(id)}/cancel`, { reason: reason ?? null }),
  };

  return approvals;
};
