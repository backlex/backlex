import type { ClientCore } from "../core";

/** The four moments a workspace can hook in its own end-users' authentication.
 *  These fire for the app plane (`/api/t/<slug>/auth/*`) only. */
export type AuthHookEvent =
  | "before-user-created"
  | "custom-access-token"
  | "password-verification"
  | "send-email";

/** An auth hook: the app's own code running at one of those four moments. */
export interface AuthHook {
  id: string;
  event: AuthHookEvent;
  /** `url` — an HTTPS endpoint called with Standard Webhooks headers.
   *  `function` — a backlex function run in the sandbox, with no network hop. */
  targetType: "url" | "function";
  url: string | null;
  functionName: string | null;
  headers: Record<string, string> | null;
  timeoutMs: number;
  /** `deny` fails the auth action when the hook cannot answer; `allow` proceeds
   *  without it — which for `custom-access-token` means a token missing the
   *  claim your authorizer reads. */
  onError: "allow" | "deny";
  enabled: boolean;
  /** Presence only — the signing secret has no read-back path. */
  hasSecret: boolean;
  consecutiveFailures: number;
  lastFailureAt: number | string | null;
  disabledReason: string | null;
  createdAt: number | string | null;
  updatedAt: number | string | null;
}

export interface AuthHookInput {
  /** At most one hook per event per workspace. */
  event: AuthHookEvent;
  targetType: "url" | "function";
  /** Required when `targetType` is `url`. */
  url?: string | null;
  /** Required when `targetType` is `function`; the function must already exist. */
  functionName?: string | null;
  /** Required — there is no safe default. See {@link AuthHook.onError}. */
  onError: "allow" | "deny";
  /** Standard Webhooks signing secret (`whsec_<base64>`). Write-only. */
  secret?: string;
  headers?: Record<string, string> | null;
  timeoutMs?: number;
  enabled?: boolean;
}

export interface AuthHookTestResult {
  ok: boolean;
  ms: number;
  error?: string;
  /** `custom-access-token` only — claims the hook returned that would be
   *  dropped as reserved, which is the usual reason one never appears. */
  droppedClaims?: string[];
  verdict?: {
    allow?: boolean;
    reason?: string;
    claims?: Record<string, unknown>;
    handled?: boolean;
  };
}

export interface AuthHooksClient {
  list: () => Promise<{ data: AuthHook[] }>;
  create: (input: AuthHookInput) => Promise<{ data: AuthHook }>;
  /** Omit `secret` to keep the stored one — it cannot be read back. */
  update: (id: string, patch: Partial<AuthHookInput>) => Promise<{ data: AuthHook }>;
  delete: (id: string) => Promise<{ ok: boolean }>;
  /** One representative call; says whether a hook refuses deliberately or is down. */
  test: (id: string) => Promise<AuthHookTestResult>;
}

export const makeAuthHooks = (core: ClientCore): AuthHooksClient => {
  // Auth hooks. Admin-scoped over `/api/admin/auth-hooks`. Signing secrets only
  // ever travel inbound: `list` reports presence, never the value.
  const hook = (id: string) => `/api/admin/auth-hooks/${encodeURIComponent(id)}`;
  const authHooks: AuthHooksClient = {
    list: () => core.request<{ data: AuthHook[] }>("GET", "/api/admin/auth-hooks"),
    create: (input) => core.request<{ data: AuthHook }>("POST", "/api/admin/auth-hooks", input),
    update: (id, patch) => core.request<{ data: AuthHook }>("PATCH", hook(id), patch),
    delete: (id) => core.request<{ ok: boolean }>("DELETE", hook(id)),
    test: (id) => core.request<AuthHookTestResult>("POST", `${hook(id)}/test`, {}),
  };

  return authHooks;
};
