// Permission tester — dry-runs the resolver for a subject (an existing user or
// an ad-hoc set of role names) against a (collection, action) and renders the
// full allow/deny trace: matched roles + rules, the resolved DSL variables, the
// compiled WHERE clause, and the field allow-list. Mirrors the REST/SDK/CLI/MCP
// `permissions.simulate` surface. Read-only — it never mutates state.
import type { PushToast } from "../../types";
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { I } from "../../icons";
import { Button, Badge, JsonBlock } from "../../ui";
import { Select } from "../../select";
import {
  collectionsApi,
  permissionsApi,
  rolesApi,
  usersApi,
  type PermissionAction,
  type PermissionSimulation,
} from "../../api";

const ACTIONS: PermissionAction[] = ["read", "create", "update", "delete", "publish"];

type SubjectMode = "user" | "adhoc";

export function PermissionTesterPanel({
  pushToast,
}: {
  pushToast: PushToast;
}) {
  const { t } = useLingui();

  // Reference data for the pickers.
  const [users, setUsers] = useState<{ id: string; email: string }[]>([]);
  const [roleNames, setRoleNames] = useState<string[]>([]);
  const [collections, setCollections] = useState<string[]>([]);

  // Form state.
  const [mode, setMode] = useState<SubjectMode>("user");
  const [userId, setUserId] = useState("");
  const [adhocRoles, setAdhocRoles] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [plane, setPlane] = useState<"platform" | "app">("platform");
  const [collection, setCollection] = useState("");
  const [action, setAction] = useState<PermissionAction>("read");
  const [sampleRowText, setSampleRowText] = useState("");

  const [result, setResult] = useState<PermissionSimulation | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [u, r, c] = await Promise.all([
          usersApi.list().catch(() => ({ data: [] })),
          rolesApi.list().catch(() => ({ data: [] })),
          collectionsApi.list().catch(() => ({ data: [] })),
        ]);
        if (cancelled) return;
        setUsers((u.data ?? []).map((x) => ({ id: x.id, email: x.email })));
        setRoleNames((r.data ?? []).map((x) => x.name));
        const slugs = (c.data ?? []).map((x) => x.slug).filter(Boolean);
        setCollections(slugs);
        if (slugs.length && !collection) setCollection(slugs[0]!);
        if ((u.data ?? []).length && !userId) setUserId(u.data![0]!.id);
      } catch {
        // pickers stay empty; the operator can still type values
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleRole = (name: string) =>
    setAdhocRoles((prev) =>
      prev.includes(name) ? prev.filter((r) => r !== name) : [...prev, name],
    );

  const canRun = useMemo(() => {
    if (!collection) return false;
    if (mode === "user") return Boolean(userId);
    return true; // ad-hoc with no roles = anonymous, a valid thing to test
  }, [collection, mode, userId]);

  const run = async () => {
    setError(null);
    setRunning(true);
    setResult(null);
    let sampleRow: Record<string, unknown> | undefined;
    if (sampleRowText.trim()) {
      try {
        sampleRow = JSON.parse(sampleRowText) as Record<string, unknown>;
      } catch {
        setRunning(false);
        setError(t`Sample row is not valid JSON.`);
        return;
      }
    }
    try {
      const { data } = await permissionsApi.simulate({
        collection,
        action,
        ...(mode === "user"
          ? { userId }
          : { roles: adhocRoles, plane, ...(email.trim() ? { email: email.trim() } : {}) }),
        ...(sampleRow ? { sampleRow } : {}),
      });
      setResult(data);
    } catch (e) {
      const msg = (e as Error).message || t`Simulation failed.`;
      setError(msg);
      pushToast(msg);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-3.5">
      {/* ── Subject + target form ─────────────────────────────────────────── */}
      <Card className="gap-0 py-0">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <I.ShieldAlert size={14} />
          <span className="text-[13px] font-medium">
            <Trans>Permission tester</Trans>
          </span>
          <span className="text-xs text-muted-foreground max-sm:hidden">
            <Trans>Dry-run the resolver and see exactly which rule applied.</Trans>
          </span>
        </div>

        <div className="flex flex-col gap-4 p-4">
          {/* Subject mode toggle */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              <Trans>Subject</Trans>
            </label>
            <div className="flex gap-1.5">
              <Button
                variant={mode === "user" ? "primary" : "secondary"}
                size="sm"
                icon={I.Users}
                onClick={() => setMode("user")}
              >
                <Trans>Existing user</Trans>
              </Button>
              <Button
                variant={mode === "adhoc" ? "primary" : "secondary"}
                size="sm"
                icon={I.Shield}
                onClick={() => setMode("adhoc")}
              >
                <Trans>Ad-hoc roles</Trans>
              </Button>
            </div>
          </div>

          {mode === "user" ? (
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                <Trans>User</Trans>
              </label>
              <Select
                value={userId}
                onChange={setUserId}
                placeholder={t`Pick a user`}
                options={users.map((u) => ({ value: u.id, label: u.email }))}
                className="max-w-md"
              />
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded-surface border border-dashed border-border p-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  <Trans>Roles</Trans>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {roleNames.length === 0 && (
                    <span className="text-xs text-muted-foreground">
                      <Trans>No roles found.</Trans>
                    </span>
                  )}
                  {roleNames.map((name) => {
                    const on = adhocRoles.includes(name);
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => toggleRole(name)}
                        className={`rounded-full border px-2.5 py-1 font-mono text-xs transition-colors ${
                          on
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
                <span className="text-xs text-muted-foreground">
                  <Trans>No roles selected = anonymous (the public role).</Trans>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    <Trans>Email (for $user.email)</Trans>
                  </label>
                  <Input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="user@example.com"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    <Trans>Plane</Trans>
                  </label>
                  <Select
                    value={plane}
                    onChange={(v) => setPlane(v as "platform" | "app")}
                    options={[
                      { value: "platform", label: t`platform (admin users)` },
                      { value: "app", label: t`app (workspace end-users)` },
                    ]}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Target collection + action */}
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                <Trans>Collection</Trans>
              </label>
              <Select
                value={collection}
                onChange={setCollection}
                placeholder={t`Pick a collection`}
                options={collections.map((s) => ({ value: s, label: s }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                <Trans>Action</Trans>
              </label>
              <Select
                value={action}
                onChange={(v) => setAction(v as PermissionAction)}
                options={ACTIONS.map((a) => ({ value: a, label: a }))}
              />
            </div>
          </div>

          {/* Optional sample row */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              <Trans>Sample row (optional JSON)</Trans>
            </label>
            <Textarea
              value={sampleRowText}
              onChange={(e) => setSampleRowText(e.target.value)}
              placeholder={`{ "owner_id": "...", "status": "published" }`}
              className="min-h-[72px] font-mono text-xs"
            />
            <span className="text-xs text-muted-foreground">
              <Trans>Test whether a concrete row passes the combined condition.</Trans>
            </span>
          </div>

          <div className="flex items-center justify-end gap-2">
            {error && <span className="mr-auto text-xs text-destructive">{error}</span>}
            <Button
              variant="primary"
              size="sm"
              icon={I.Play}
              onClick={run}
              disabled={!canRun || running}
            >
              {running ? <Trans>Simulating…</Trans> : <Trans>Simulate</Trans>}
            </Button>
          </div>
        </div>
      </Card>

      {/* ── Result ────────────────────────────────────────────────────────── */}
      {result && <SimulationResult result={result} />}
    </div>
  );
}

function SimulationResult({ result }: { result: PermissionSimulation }) {
  const { t } = useLingui();
  const allow = result.allowed;
  return (
    <Card className="gap-0 py-0">
      {/* Verdict banner */}
      <div
        className={`flex items-center gap-2.5 border-b px-4 py-3.5 ${
          allow
            ? "border-border bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "border-border bg-destructive/10 text-destructive"
        }`}
      >
        {allow ? <I.CheckCircle size={16} /> : <I.XCircle size={16} />}
        <span className="text-[13px] font-semibold">
          {allow ? <Trans>Allowed</Trans> : <Trans>Denied</Trans>}
        </span>
        {result.isAdmin && (
          <Badge variant="outline">
            <Trans>admin bypass</Trans>
          </Badge>
        )}
        {result.rowMatch !== undefined && (
          <Badge variant={result.rowMatch ? "default" : "secondary"}>
            {result.rowMatch ? (
              <Trans>sample row matches</Trans>
            ) : (
              <Trans>sample row excluded</Trans>
            )}
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-4 p-4 text-[13px]">
        <p className="text-muted-foreground">{result.reason}</p>

        {/* Subject + roles */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            <Trans>Roles</Trans>
          </span>
          {result.roles.length === 0 && (
            <span className="text-xs text-muted-foreground">
              <Trans>none</Trans>
            </span>
          )}
          {result.roles.map((r) => (
            <Badge key={r.id} variant={r.admin ? "default" : "outline"} mono>
              {r.name}
            </Badge>
          ))}
        </div>

        {/* Matched rules */}
        {result.matchedRules.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              <Trans>Matched rules</Trans>
            </span>
            <ScrollArea className="w-full rounded-control border border-border" viewportClassName="max-h-64">
              <div className="min-w-[480px]">
                {result.matchedRules.map((rule) => (
                  <div
                    key={rule.permissionId}
                    className="flex items-start gap-3 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    <Badge variant="outline" mono>
                      {rule.roleName}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      {rule.collection}
                    </span>
                    <code className="flex-1 whitespace-pre-wrap break-all text-xs">
                      {rule.condition ? JSON.stringify(rule.condition) : "—"}
                    </code>
                    {rule.rowMatch !== undefined &&
                      (rule.rowMatch ? (
                        <I.Check size={14} className="text-emerald-500" />
                      ) : (
                        <I.Minus size={14} className="text-muted-foreground" />
                      ))}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        {/* Compiled WHERE */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            <Trans>Compiled WHERE</Trans>
          </span>
          {result.whereSql ? (
            <pre className="rounded-control border border-border bg-muted/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
              {result.whereSql.sql}
              {result.whereSql.params.length > 0 &&
                `\n-- params: ${JSON.stringify(result.whereSql.params)}`}
            </pre>
          ) : (
            <span className="text-xs text-muted-foreground">
              <Trans>Unrestricted — no row filter applies.</Trans>
            </span>
          )}
        </div>

        {/* Fields */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            <Trans>Fields</Trans>
          </span>
          {result.fields === null ? (
            <span className="text-xs text-muted-foreground">
              <Trans>all fields</Trans>
            </span>
          ) : result.fields.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              <Trans>none</Trans>
            </span>
          ) : (
            result.fields.map((f) => (
              <Badge key={f} variant="secondary" mono>
                {f}
              </Badge>
            ))
          )}
        </div>

        {/* Resolved variables */}
        <JsonBlock label={t`Resolved variables`} value={result.resolvedVars} maxHeight={180} />
      </div>
    </Card>
  );
}
