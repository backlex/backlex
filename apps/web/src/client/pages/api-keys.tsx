import { useEffect, useState, type FormEvent } from "react";
import { KeyIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@workeros/ui/components/card";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import { Badge } from "@workeros/ui/components/badge";
import { Skeleton } from "@workeros/ui/components/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workeros/ui/components/select";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
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

export const ApiKeys = () => {
  const [items, setItems] = useState<ApiKey[]>([]);
  const [roles, setRoles] = useState<BindableRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [roleId, setRoleId] = useState<string>(NO_ROLE);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setLoading(true);
    Promise.all([
      api<{ data: ApiKey[] }>("/api/api-keys").then((r) => setItems(r.data)),
      api<{ data: BindableRole[] }>("/api/api-keys/available-roles")
        .then((r) => setRoles(r.data))
        .catch(() => setRoles([])),
    ])
      .catch((e) => notifyError(e, "Loading API keys"))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const resetForm = () => {
    setName("");
    setExpiresAt("");
    setRoleId(NO_ROLE);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (name.trim()) body.name = name.trim();
      if (expiresAt) body.expiresAt = new Date(expiresAt).toISOString();
      if (roleId && roleId !== NO_ROLE) body.roleId = roleId;
      const r = await api<{ data: ApiKey & { secret: string } }>(
        "/api/api-keys",
        { method: "POST", body: JSON.stringify(body) },
      );
      setSecret(r.data.secret);
      resetForm();
      setShowForm(false);
      refresh();
    } catch (e) {
      notifyError(e, "Creating key");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await api(`/api/api-keys/${id}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      notifyError(e, "Revoking key");
    }
  };

  return (
    <div>
      <PageHeader
        title="API Keys"
        description="Long-lived bearer tokens (`pak_…`) for CI, scripts, third-party integrations. A key impersonates its owner — optionally narrowed to a single role and/or given an expiry date."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh}>
              Refresh
            </Button>
            <Button size="sm" onClick={() => setShowForm((s) => !s)}>
              <PlusIcon /> {showForm ? "Cancel" : "New"}
            </Button>
          </>
        }
      />

      {secret && (
        <Card className="mb-6 ring-2 ring-primary/40">
          <CardHeader>
            <CardTitle className="text-sm">Save this secret now</CardTitle>
          </CardHeader>
          <CardContent>
            <code className="block break-all rounded-md bg-muted p-3 font-mono text-xs">
              {secret}
            </code>
            <p className="mt-2 text-xs text-muted-foreground">
              Once you leave this page, the secret can&rsquo;t be retrieved — only
              revoked.
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              onClick={() => setSecret(null)}
            >
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {showForm && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>New API key</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={submit}>
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="ci-bot (optional)"
                />
                <p className="text-xs text-muted-foreground">
                  Optional — a timestamped name is generated if you leave this blank.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="role">Scope to role</Label>
                <Select value={roleId} onValueChange={setRoleId}>
                  <SelectTrigger id="role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_ROLE}>
                      Owner&rsquo;s full access (no restriction)
                    </SelectItem>
                    {roles.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                        {r.admin ? " (admin)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  When set, requests made with this key get only this role&rsquo;s
                  permissions — and only while the owner still holds it.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="expires">Expires</Label>
                <Input
                  id="expires"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Optional — the key stops working after this time.
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="submit" disabled={busy}>
                  {busy ? "Creating…" : "Create"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

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
              title="No API keys yet"
              description="Create a key to authenticate programmatic access (CI, scripts, third-party apps)."
              action={
                <Button size="sm" onClick={() => setShowForm(true)}>
                  <PlusIcon /> New key
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
                            revoked
                          </Badge>
                        )}
                        {expired && (
                          <Badge variant="outline" className="text-destructive">
                            expired
                          </Badge>
                        )}
                        {k.roleId && (
                          <Badge variant="secondary">
                            role: {k.roleName ?? k.roleId}
                          </Badge>
                        )}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {k.prefix}_…
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        created {new Date(k.createdAt).toLocaleString()}
                        {k.expiresAt
                          ? ` · ${expired ? "expired" : "expires"} ${new Date(k.expiresAt).toLocaleString()}`
                          : " · no expiry"}
                        {k.lastUsedAt
                          ? ` · last used ${new Date(k.lastUsedAt).toLocaleString()}`
                          : " · never used"}
                      </div>
                    </div>
                    <ConfirmAction
                      title="Revoke this API key?"
                      description={`The key "${k.name}" will stop working immediately. This cannot be undone.`}
                      actionLabel="Revoke"
                      destructive
                      onConfirm={() => revoke(k.id)}
                    >
                      <Button variant="ghost" size="icon-sm" disabled={!!k.revokedAt}>
                        <Trash2Icon />
                      </Button>
                    </ConfirmAction>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
