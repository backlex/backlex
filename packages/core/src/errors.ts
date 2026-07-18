export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "GONE"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "INTERNAL"
  | "UNAVAILABLE";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  /** The resource existed but was deliberately switched off (paused form). */
  GONE: 410,
  VALIDATION: 422,
  RATE_LIMITED: 429,
  /** A metered usage limit (per-key monthly quota or workspace plan limit)
   *  is exhausted. Unlike RATE_LIMITED this doesn't clear in seconds — the
   *  budget resets on the next UTC month (or when an admin raises it). */
  QUOTA_EXCEEDED: 429,
  INTERNAL: 500,
  /** Feature is configured but the runtime can't serve it (e.g. LDAP on
   *  Cloudflare Workers — no raw TCP). */
  UNAVAILABLE: 503,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
