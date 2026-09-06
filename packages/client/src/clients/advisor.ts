import type { ClientCore } from "../core";

/** A remediation the advisor can carry out itself. Present on findings that a
 *  single server-built DDL statement fixes. */
export interface AdvisorAction {
  type: "create-index";
  table: string;
  indexName: string;
  columns: string[];
  /** The exact statement `advisor.apply` will run. Informational — the server
   *  re-derives it and never accepts one from the client. */
  sql: string;
}

/** Observed numbers behind a traffic-derived finding. Its presence is what
 *  marks a finding as measured rather than inferred from the schema. */
export interface AdvisorEvidence {
  /** Requests observed in the window — spans seen, never extrapolated. */
  requests: number;
  windowDays: number;
  p95?: number;
  errorRate?: number;
  /** Share of the collection's list traffic touching the column, 0..1. */
  share?: number;
}

export interface AdvisorCheck {
  id: string;
  kind: "security" | "performance";
  level: "error" | "warn" | "info";
  rule: string;
  groupTitle: string;
  title: string;
  body: string;
  fix: string;
  resource: string;
  link?: string;
  action?: AdvisorAction;
  evidence?: AdvisorEvidence;
}

export interface AdvisorResult {
  data: AdvisorCheck[];
  /** 0–100 health score, server-computed over every finding. */
  score: number;
  generatedAt: string;
  /** What the traffic-derived rules had to work with. `spanCount: 0` means no
   *  runtime rule could fire — which is not the same as "no problems". */
  runtime: {
    windowDays: number;
    spanCount: number;
    sampleRate: number;
    truncated: boolean;
  };
}

/** One endpoint's latency + error profile over the insights window. */
export interface AdvisorEndpointStat {
  /** `GET /api/items/posts/:id`. */
  route: string;
  method: string;
  path: string;
  requests: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
  avgMs: number;
  serverErrors: number;
  clientErrors: number;
  errorRate: number;
}

export interface AdvisorColumnUse {
  column: string;
  requests: number;
  /** Share of the collection's list requests touching this column, 0..1. */
  share: number;
}

export interface AdvisorCollectionStat {
  collection: string;
  listRequests: number;
  p50: number;
  p95: number;
  filters: AdvisorColumnUse[];
  sorts: AdvisorColumnUse[];
}

export interface AdvisorPermissionWriteCheckStat {
  collection: string;
  /** `create` / `update` / … — the permission action the write was judged on. */
  action: string;
  /** Requests in the window carrying at least one such write. One per REQUEST:
   *  a 5,000-row import that misses the same condition every time counts once. */
  requests: number;
  /** True when at least one was recorded under `PERMISSION_WRITE_CHECK=enforce`
   *  — i.e. actually refused, not merely counted. */
  refused: boolean;
}

export interface AdvisorInsights {
  /** Slowest first (p95 desc, ties broken by traffic). */
  endpoints: AdvisorEndpointStat[];
  /** Busiest first. */
  collections: AdvisorCollectionStat[];
  /**
   * Writes that landed outside their role's `write` conditions, busiest first.
   *
   * Empty means no recorded write in the window would be refused by
   * `PERMISSION_WRITE_CHECK=enforce` — which is the reading its `warn` default
   * exists to produce, and is only as strong as `window.sampleRate`.
   * Conditions reaching through a relation are not judged in memory and are
   * outside this count either way.
   */
  permissionWriteChecks: AdvisorPermissionWriteCheckStat[];
  window: {
    from: number;
    to: number;
    days: number;
    spanCount: number;
    /** Start of the oldest span seen. Well after `from` means span retention,
     *  not traffic, bounded the window. */
    oldestSpanAt: number | null;
    /** `TRACES_SAMPLE_RATE`. Below 1, the numbers describe a sample. */
    sampleRate: number;
    truncated: boolean;
  };
}

export interface AdvisorClient {
  /** Run the advisor: findings + score + the runtime window behind the
   *  traffic-derived rules. */
  run(opts?: { days?: number }): Promise<AdvisorResult>;
  /** Runtime query insights aggregated from recorded request spans. */
  insights(opts?: { days?: number; limit?: number }): Promise<AdvisorInsights>;
  /** Apply a finding's `action`. Takes only the finding id — the server
   *  re-runs the advisor and executes the statement that fresh finding
   *  carries, so a stale finding can never be applied. */
  apply(
    id: string,
    opts?: { days?: number },
  ): Promise<{ ok: true; applied: AdvisorAction }>;
}

export const makeAdvisor = (core: ClientCore): AdvisorClient => {
  // Advisor. Admin-scoped over `/api/admin/advisor*`. `apply` deliberately
  // sends only the finding id — the server re-derives the statement.
  const advisor: AdvisorClient = {
    run: (opts?: { days?: number }) => {
      const qs = opts?.days ? `?days=${Math.floor(opts.days)}` : "";
      return core.request<AdvisorResult>("GET", `/api/admin/advisor${qs}`);
    },
    insights: (opts?: { days?: number; limit?: number }) => {
      const qs = new URLSearchParams();
      if (opts?.days) qs.set("days", String(Math.floor(opts.days)));
      if (opts?.limit) qs.set("limit", String(Math.floor(opts.limit)));
      const suffix = qs.size > 0 ? `?${qs}` : "";
      return core.request<AdvisorInsights>("GET", `/api/admin/advisor/insights${suffix}`);
    },
    apply: (id: string, opts?: { days?: number }) =>
      core.request<{ ok: true; applied: AdvisorAction }>(
        "POST",
        "/api/admin/advisor/apply",
        opts?.days ? { id, days: Math.floor(opts.days) } : { id },
      ),
  };

  return advisor;
};
