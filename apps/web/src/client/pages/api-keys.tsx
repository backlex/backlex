import { useEffect, useState, type FormEvent } from "react";
import {
  KeyIcon,
  PlusIcon,
  PlugIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Card, CardContent, CardHeader, CardTitle } from "@workeros/ui/components/card";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import { Badge } from "@workeros/ui/components/badge";
import { Checkbox } from "@workeros/ui/components/checkbox";
import { Skeleton } from "@workeros/ui/components/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workeros/ui/components/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import { ScrollArea } from "@workeros/ui/components/scroll-area";
import { ConfirmAction } from "@/components/confirm-action";
import { DatePicker } from "@/components/date-picker";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { McpKeyModal } from "@/components/mcp-key-modal";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";

interface ApiKey {
  id: string;
  prefix: string;
  name: string;
  userId: string;
  roleId: string | null;
  roleName: string | null;
  expiresAt: string | number | null;
  lastUsedAt: string | number | null;
  revokedAt: string | number | null;
  createdAt: string | number;
  mcpTools: string[] | null;
  mcpReadOnly: boolean;
}

interface BindableRole {
  id: string;
  name: string;
  admin: boolean;
}

const isExpired = (v: string | number | null): boolean =>
  v != null && new Date(v).getTime() <= Date.now();

// Radix <SelectItem> can't carry an empty value — use a sentinel for the
// "no role restriction" choice and translate it on submit.
const NO_ROLE = "__none__";

type ExpiryPreset = "7d" | "30d" | "90d" | "365d" | "never" | "custom";

const EXPIRY_PRESETS: { value: ExpiryPreset; labelKey: string; days: number | null }[] = [
  { value: "7d", labelKey: "7 days", days: 7 },
  { value: "30d", labelKey: "30 days", days: 30 },
  { value: "90d", labelKey: "90 days", days: 90 },
  { value: "365d", labelKey: "1 year", days: 365 },
  { value: "never", labelKey: "Never (no expiry)", days: null },
  { value: "custom", labelKey: "Custom date…", days: null },
];

const expiresAtFromPreset = (
  preset: ExpiryPreset,
  custom: string | null,
): string | null => {
  if (preset === "never") return null;
  if (preset === "custom") return custom;
  const days = EXPIRY_PRESETS.find((p) => p.value === preset)?.days ?? null;
  if (days === null) return null;
  return new Date(Date.now() + days * 86_400_000).toISOString();
};

export const ApiKeys = () => {
  const { t } = useLingui();
  const [items, setItems] = useState<ApiKey[]>([]);
  const [roles, setRoles] = useState<BindableRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset>("never");
  const [customExpiry, setCustomExpiry] = useState<string | null>(null);
  const [roleId, setRoleId] = useState<string>(NO_ROLE);
  const [secret, setSecret] = useState<string | null>(null);
  const [mcpReadOnly, setMcpReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The key currently being inspected in the "Connect MCP" modal. */
  const [mcpKey, setMcpKey] = useState<ApiKey | null>(null);
  /** Plaintext secret if the user just minted this key — passed to the MCP
   *  modal so the install snippet has the real bearer, not a `pak_<prefix>_…`
   *  placeholder. Cleared once the modal closes or the user navigates away. */
  const [mcpKeySecret, setMcpKeySecret] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    Promise.all([
      api<{ data: ApiKey[] }>("/api/api-keys").then((r) => setItems(r.data)),
      api<{ data: BindableRole[] }>("/api/api-keys/available-roles")
        .then((r) => setRoles(r.data))
        .catch(() => setRoles([])),
    ])
      .catch((e) => notifyError(e, t`Loading API keys`))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const resetForm = () => {
    setName("");
    setExpiryPreset("never");
    setCustomExpiry(null);
    setRoleId(NO_ROLE);
    setMcpReadOnly(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (name.trim()) body.name = name.trim();
      const iso = expiresAtFromPreset(expiryPreset, customExpiry);
      if (iso) body.expiresAt = iso;
      if (roleId && roleId !== NO_ROLE) body.roleId = roleId;
      if (mcpReadOnly) body.mcpReadOnly = true;
      const r = await api<{ data: ApiKey & { secret: string } }>(
        "/api/api-keys",
        { method: "POST", body: JSON.stringify(body) },
      );
      setSecret(r.data.secret);
      // Surface the new key in the MCP modal too — the install snippet
      // becomes immediately useful without re-entering the secret.
      setMcpKey(r.data);
      setMcpKeySecret(r.data.secret);
      resetForm();
      setShowForm(false);
      refresh();
    } catch (e) {
      notifyError(e, t`Creating key`);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await api(`/api/api-keys/${id}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      notifyError(e, t`Revoking key`);
    }
  };

  // Build localised preset labels once per render (t needs to be called in component scope)
  const presetLabels: Record<string, string> = {
    "7d": t`7 days`,
    "30d": t`30 days`,
    "90d": t`90 days`,
    "365d": t`1 year`,
    "never": t`Never (no expiry)`,
    "custom": t`Custom date…`,
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t`API Keys`}
        description={t`Long-lived bearer tokens (\`pak_…\`) for CI, scripts, third-party integrations. A key impersonates its owner — optionally narrowed to a single role and/or given an expiry date.`}
        actions={
          <Button size="sm" onClick={() => setShowForm(true)}>
            <PlusIcon /> <Trans>New</Trans>
          </Button>
        }
      />

      {secret && (
        <Card className="max-w-2xl ring-2 ring-primary/40">
          <CardHeader>
            <CardTitle className="text-sm"><Trans>Save this secret now</Trans></CardTitle>
          </CardHeader>
          <CardContent>
            <code className="block break-all rounded-md bg-muted p-3 font-mono text-xs">
              {secret}
            </code>
            <p className="mt-2 text-xs text-muted-foreground">
              <Trans>Once you leave this page, the secret can&rsquo;t be retrieved — only revoked.</Trans>
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              onClick={() => setSecret(null)}
            >
              <Trans>Dismiss</Trans>
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={showForm}
        onOpenChange={(open) => {
          if (busy) return;
          if (!open) resetForm();
          setShowForm(open);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle><Trans>New API key</Trans></DialogTitle>
            <DialogDescription>
              <Trans>The full secret is shown once after creation — copy it somewhere safe.</Trans>
            </DialogDescription>
          </DialogHeader>
          <form id="new-api-key-form" className="space-y-4" onSubmit={submit}>
            <div className="space-y-1.5">
              <Label htmlFor="name"><Trans>Name</Trans></Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t`ci-bot (optional)`}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                <Trans>Optional — a timestamped name is generated if you leave this blank.</Trans>
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role"><Trans>Scope to role</Trans></Label>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger id="role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_ROLE}>
                    <Trans>Owner&rsquo;s full access (no restriction)</Trans>
                  </SelectItem>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                      {r.admin ? t` (admin)` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                <Trans>When set, requests made with this key get only this role&rsquo;s permissions — and only while the owner still holds it.</Trans>
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="expires"><Trans>Expires</Trans></Label>
              <Select
                value={expiryPreset}
                onValueChange={(v) => setExpiryPreset(v as ExpiryPreset)}
              >
                <SelectTrigger id="expires">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_PRESETS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {presetLabels[p.value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {expiryPreset === "custom" && (
                <DatePicker value={customExpiry} onChange={setCustomExpiry} />
              )}
              {expiryPreset === "never" && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                  <span>
                    <Trans>Long-lived keys widen blast radius. Prefer the shortest expiry that works — you can always rotate.</Trans>
                  </span>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                <Trans>Optional — the key stops working after this time.</Trans>
              </p>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-3">
              <Checkbox
                id="mcp-read-only"
                checked={mcpReadOnly}
                onCheckedChange={(v) => setMcpReadOnly(v === true)}
                className="mt-0.5"
              />
              <div className="flex-1 space-y-1">
                <Label htmlFor="mcp-read-only" className="font-medium">
                  <Trans>MCP read-only mode</Trans>
                </Label>
                <p className="text-xs text-muted-foreground">
                  <Trans>
                    Block every write tool (insert / update / delete / invoke / …) when this key is used through the MCP server. REST authorization is unaffected. Allowlist can be configured per-key after creation.
                  </Trans>
                </p>
              </div>
            </div>
          </form>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                resetForm();
                setShowForm(false);
              }}
              disabled={busy}
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" form="new-api-key-form" disabled={busy}>
              {busy ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardContent>
          {loading ? (
            <ul className="divide-y">
              {Array.from({ length: 3 }).map((_, i) => (
                <li key={i} className="flex items-start justify-between gap-4 py-3">
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="size-8 rounded-full" />
                </li>
              ))}
            </ul>
          ) : items.length === 0 ? (
            <EmptyState
              icon={KeyIcon}
              title={t`No API keys yet`}
              description={t`Create a key to authenticate programmatic access (CI, scripts, third-party apps).`}
              action={
                <Button size="sm" onClick={() => setShowForm(true)}>
                  <PlusIcon /> <Trans>New key</Trans>
                </Button>
              }
            />
          ) : (
            <ul className="divide-y">
              {items.map((k) => {
                const expired = !k.revokedAt && isExpired(k.expiresAt);
                return (
                  <li
                    key={k.id}
                    className="flex items-start justify-between gap-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{k.name}</span>
                        {k.revokedAt && (
                          <Badge variant="outline" className="text-destructive">
                            <Trans>revoked</Trans>
                          </Badge>
                        )}
                        {expired && (
                          <Badge variant="outline" className="text-destructive">
                            <Trans>expired</Trans>
                          </Badge>
                        )}
                        {k.roleId && (
                          <Badge variant="secondary">
                            <Trans>role: {k.roleName ?? k.roleId}</Trans>
                          </Badge>
                        )}
                        {k.mcpReadOnly && (
                          <Badge variant="outline">
                            <Trans>MCP read-only</Trans>
                          </Badge>
                        )}
                        {k.mcpTools && (
                          <Badge variant="outline">
                            <Trans>MCP: {k.mcpTools.length} tool(s)</Trans>
                          </Badge>
                        )}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {k.prefix}_…
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        <Trans>created {new Date(k.createdAt).toLocaleString()}</Trans>
                        {k.expiresAt
                          ? expired
                            ? t` · expired ${new Date(k.expiresAt).toLocaleString()}`
                            : t` · expires ${new Date(k.expiresAt).toLocaleString()}`
                          : t` · no expiry`}
                        {k.lastUsedAt
                          ? t` · last used ${new Date(k.lastUsedAt).toLocaleString()}`
                          : t` · never used`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t`Connect MCP`}
                        disabled={!!k.revokedAt}
                        onClick={() => {
                          setMcpKey(k);
                          setMcpKeySecret(null);
                        }}
                      >
                        <PlugIcon />
                      </Button>
                      <ConfirmAction
                        title={t`Revoke this API key?`}
                        description={t`The key "${k.name}" will stop working immediately. This cannot be undone.`}
                        actionLabel={t`Revoke`}
                        destructive
                        onConfirm={() => revoke(k.id)}
                      >
                        <Button variant="ghost" size="icon-sm" disabled={!!k.revokedAt}>
                          <Trash2Icon />
                        </Button>
                      </ConfirmAction>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {mcpKey && (
        <McpKeyModal
          open={!!mcpKey}
          onOpenChange={(open) => {
            if (!open) {
              setMcpKey(null);
              setMcpKeySecret(null);
            }
          }}
          keyId={mcpKey.id}
          keyPrefix={mcpKey.prefix}
          keyName={mcpKey.name}
          initialSecret={mcpKeySecret}
          initialAllowlist={mcpKey.mcpTools}
          initialReadOnly={mcpKey.mcpReadOnly}
          onSaved={refresh}
        />
      )}
    </div>
  );
};
