import { useEffect, useState, type FormEvent } from "react";
import { KeyIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@workeros/ui/components/card";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import { Badge } from "@workeros/ui/components/badge";
import { Skeleton } from "@workeros/ui/components/skeleton";
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
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export const ApiKeys = () => {
  const [items, setItems] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setLoading(true);
    api<{ data: ApiKey[] }>("/api/api-keys")
      .then((r) => setItems(r.data))
      .catch((e) => notifyError(e, "Loading API keys"))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ data: ApiKey & { secret: string } }>(
        "/api/api-keys",
        { method: "POST", body: JSON.stringify({ name }) },
      );
      setSecret(r.data.secret);
      setName("");
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
        description="Long-lived bearer tokens (`pak_…`) for CI, scripts, third-party integrations. Each key impersonates its owner's roles and permissions."
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
                  placeholder="ci-bot"
                  required
                />
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
              {items.map((k) => (
                <li
                  key={k.id}
                  className="flex items-start justify-between gap-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{k.name}</span>
                      {k.revokedAt && (
                        <Badge variant="outline" className="text-destructive">
                          revoked
                        </Badge>
                      )}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {k.prefix}_…
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      created {new Date(k.createdAt).toLocaleString()}
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
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
