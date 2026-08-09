import type { ClientCore } from "../core";

/** A part of the permission model a policy cannot carry, with the reason. */
export interface RlsOmission {
  collection: string;
  role: string;
  action: string;
  reason: string;
}

export interface RlsPlan {
  /** Idempotent DDL creating the `backlex.*` helper functions a policy reads
   *  the connected identity through. */
  helpers: string[];
  enables: string[];
  policies: Array<{
    collection: string;
    table: string;
    role: string;
    action: "read" | "create" | "update" | "delete";
    name: string;
    statements: string[];
  }>;
  /** Read these before applying: the direct-database view is COARSER than the
   *  API's wherever one appears. */
  omissions: RlsOmission[];
  /** Tables backlex does not own. Applying is refused while any are listed —
   *  row security exempts the owner, so enabling it elsewhere would filter
   *  backlex's own queries. */
  notOwned: string[];
}

export interface RlsStatus {
  /** False on SQLite/D1, where the API remains the only enforcement point. */
  supported: boolean;
  /** Database role the policies apply to (`PUBLIC` by default). */
  appliesTo: string;
  installed: Array<{ table: string; name: string; command: string }>;
  expected: Array<{ table: string; name: string }>;
  /** Installed but no longer expected — a rule changed since the last apply. */
  stale: Array<{ table: string; name: string; command: string }>;
  /** Expected but not installed — a rule was added since. */
  missing: Array<{ table: string; name: string }>;
  omissions: RlsOmission[];
  notOwned: string[];
}

export interface RlsClient {
  /** What is installed, and how far it has drifted from the current rules. */
  status: () => Promise<RlsStatus>;
  /** The exact statements an apply would run. Nothing is changed. */
  plan: () => Promise<RlsPlan>;
  apply: () => Promise<{
    applied: number;
    tables: string[];
    statements: number;
    omissions: RlsOmission[];
  }>;
  /** Drop backlex's policies; disable row security only where none remain. */
  disable: () => Promise<{ dropped: number; disabled: string[] }>;
}

export const makeRls = (core: ClientCore): RlsClient => {
  const base = "/api/admin/rls";
  return {
    status: () => core.request<RlsStatus>("GET", `${base}/status`),
    plan: () => core.request<RlsPlan>("GET", `${base}/plan`),
    apply: () =>
      core.request<{
        applied: number;
        tables: string[];
        statements: number;
        omissions: RlsOmission[];
      }>("POST", `${base}/apply`, {}),
    disable: () =>
      core.request<{ dropped: number; disabled: string[] }>("POST", `${base}/disable`, {}),
  };
};
