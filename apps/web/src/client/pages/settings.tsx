import { useEffect, useState, type FormEvent } from "react";
import {
  PlusIcon,
  Trash2Icon,
  ShieldIcon,
  UserIcon,
  KeyRoundIcon,
  ServerIcon,
  InfoIcon,
} from "lucide-react";
import { auth as authClient } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@workeros/ui/components/card";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import { Textarea } from "@workeros/ui/components/textarea";
import { Badge } from "@workeros/ui/components/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workeros/ui/components/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workeros/ui/components/select";
import { ConfirmAction } from "@/components/confirm-action";
import { PageHeader } from "@/components/page-header";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";

interface Role {
  id: string;
  name: string;
  description: string | null;
  admin: boolean | number;
}

interface Permission {
  id: string;
  roleId: string;
  collection: string;
  action: "read" | "create" | "update" | "delete";
  fields: string[] | null;
  condition: unknown;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  roles: { id: string; name: string }[];
}

const SYS = new Set(["admin", "authenticated", "public"]);

const RolesTab = () => {
  const [roles, setRoles] = useState<Role[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  // permission editor state
  const [openRole, setOpenRole] = useState<string | null>(null);
  const [perms, setPerms] = useState<Permission[]>([]);
  const [pCollection, setPCollection] = useState("");
  const [pAction, setPAction] = useState<Permission["action"]>("read");
  const [pCondition, setPCondition] = useState("");

  const refresh = async () => {
    try {
      const r = await api<{ data: Role[] }>("/api/roles");
      setRoles(r.data);
    } catch (e) {
      notifyError(e);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/roles", {
        method: "POST",
        body: JSON.stringify({ name, description }),
      });
      setShowForm(false);
      setName("");
      setDescription("");
      refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/api/roles/${id}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      notifyError(e, "Deleting role");
    }
  };

  const openPerms = async (id: string) => {
    setOpenRole(id);
    setPerms([]);
    try {
      const r = await api<{ data: Permission[] }>(`/api/roles/${id}/permissions`);
      setPerms(r.data);
    } catch (e) {
      notifyError(e);
    }
  };

  const addPerm = async (e: FormEvent) => {
    e.preventDefault();
    if (!openRole) return;
    let condition: unknown = null;
    if (pCondition.trim()) {
      try {
        condition = JSON.parse(pCondition);
      } catch {
        notifyError("Condition must be valid JSON");
        return;
      }
    }
    try {
      await api(`/api/roles/${openRole}/permissions`, {
        method: "POST",
        body: JSON.stringify({
          collection: pCollection,
          action: pAction,
          condition,
        }),
      });
      setPCollection("");
      setPCondition("");
      openPerms(openRole);
    } catch (e) {
      notifyError(e);
    }
  };

  const removePerm = async (id: string) => {
    await api(`/api/permissions/${id}`, { method: "DELETE" });
    if (openRole) openPerms(openRole);
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-medium">
          <ShieldIcon className="size-4" /> Roles
        </h2>
        <Button size="sm" onClick={() => setShowForm((s) => !s)}>
          <PlusIcon /> {showForm ? "Cancel" : "New role"}
        </Button>
      </div>

      {showForm && (
        <Card className="mb-4">
          <CardContent>
            <form className="space-y-3" onSubmit={submit}>
              <div className="space-y-1.5">
                <Label htmlFor="rname">Name</Label>
                <Input
                  id="rname"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rdesc">Description</Label>
                <Input
                  id="rdesc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={busy}>
                  {busy ? "Creating…" : "Create"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}


      <ul className="space-y-2">
        {roles.map((r) => (
          <li key={r.id}>
            <Card>
              <CardContent>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.name}</span>
                      {r.admin ? <Badge>admin</Badge> : null}
                      {SYS.has(r.name) ? (
                        <Badge variant="secondary">system</Badge>
                      ) : null}
                    </div>
                    {r.description ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {r.description}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        openRole === r.id ? setOpenRole(null) : openPerms(r.id)
                      }
                    >
                      Permissions
                    </Button>
                    {!SYS.has(r.name) && (
                      <ConfirmAction
                        title={`Delete role "${r.name}"?`}
                        description="Users currently in this role will lose its permissions."
                        actionLabel="Delete"
                        destructive
                        onConfirm={() => remove(r.id)}
                      >
                        <Button variant="ghost" size="icon-sm">
                          <Trash2Icon />
                        </Button>
                      </ConfirmAction>
                    )}
                  </div>
                </div>

                {openRole === r.id && (
                  <div className="mt-4 space-y-3 border-t pt-4">
                    <ul className="space-y-1 text-xs">
                      {perms.length === 0 ? (
                        <li className="text-muted-foreground">No permissions.</li>
                      ) : (
                        perms.map((p) => (
                          <li
                            key={p.id}
                            className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1"
                          >
                            <span className="font-mono">
                              {p.action.toUpperCase()} {p.collection}
                              {p.condition
                                ? ` if ${JSON.stringify(p.condition)}`
                                : ""}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => removePerm(p.id)}
                            >
                              <Trash2Icon />
                            </Button>
                          </li>
                        ))
                      )}
                    </ul>
                    <form className="grid grid-cols-1 gap-2 md:grid-cols-4" onSubmit={addPerm}>
                      <Input
                        placeholder="collection (or *)"
                        value={pCollection}
                        onChange={(e) => setPCollection(e.target.value)}
                        required
                      />
                      <Select
                        value={pAction}
                        onValueChange={(v) => setPAction(v as Permission["action"])}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="read">read</SelectItem>
                          <SelectItem value="create">create</SelectItem>
                          <SelectItem value="update">update</SelectItem>
                          <SelectItem value="delete">delete</SelectItem>
                        </SelectContent>
                      </Select>
                      <Textarea
                        rows={1}
                        className="md:col-span-1"
                        placeholder='condition JSON (optional)'
                        value={pCondition}
                        onChange={(e) => setPCondition(e.target.value)}
                      />
                      <Button type="submit" size="sm">
                        Add
                      </Button>
                    </form>
                  </div>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
};

const UsersTab = () => {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);

  const refresh = async () => {
    try {
      const [u, r] = await Promise.all([
        api<{ data: UserRow[] }>("/api/users"),
        api<{ data: Role[] }>("/api/roles"),
      ]);
      setUsers(u.data);
      setRoles(r.data);
    } catch (e) {
      notifyError(e);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const assign = async (userId: string, roleId: string) => {
    if (!roleId) return;
    await api(`/api/users/${userId}/roles`, {
      method: "POST",
      body: JSON.stringify({ roleId }),
    });
    refresh();
  };

  const unassign = async (userId: string, roleId: string) => {
    await api(`/api/users/${userId}/roles/${roleId}`, { method: "DELETE" });
    refresh();
  };

  return (
    <div>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-medium">
        <UserIcon className="size-4" /> Users
      </h2>
      <ul className="space-y-2">
        {users.map((u) => (
          <li key={u.id}>
            <Card>
              <CardContent>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {u.name ?? u.email.split("@")[0]}
                    </div>
                    <div className="text-xs text-muted-foreground">{u.email}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {u.roles.length === 0 ? (
                        <span className="text-xs text-muted-foreground">no roles</span>
                      ) : (
                        u.roles.map((r) => (
                          <Badge
                            key={r.id}
                            variant="secondary"
                            className="cursor-pointer pr-1 hover:bg-secondary/70"
                            onClick={() => unassign(u.id, r.id)}
                            title="Click to unassign"
                          >
                            {r.name}
                            <span className="ml-1 text-muted-foreground">×</span>
                          </Badge>
                        ))
                      )}
                    </div>
                  </div>
                  <Select
                    onValueChange={(v) => {
                      assign(u.id, v);
                    }}
                  >
                    <SelectTrigger className="w-[160px]">
                      <SelectValue placeholder="Assign role…" />
                    </SelectTrigger>
                    <SelectContent>
                      {roles
                        .filter((r) => !u.roles.some((ur) => ur.id === r.id))
                        .map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
};

interface PasskeyRow {
  id: string;
  name: string | null;
  deviceType: string | null;
  backedUp: boolean | number;
  createdAt: string;
}

const PasskeysTab = () => {
  const [items, setItems] = useState<PasskeyRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("My passkey");

  const refresh = async () => {
    try {
      const c = authClient as unknown as {
        passkey?: { listUserPasskeys?: () => Promise<{ data?: PasskeyRow[] }> };
      };
      const list = c.passkey?.listUserPasskeys;
      if (!list) {
        notifyError("Passkey plugin not enabled on the server.");
        return;
      }
      const r = await list();
      setItems(r.data ?? []);
    } catch (e) {
      notifyError(e);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const add = async () => {
    setBusy(true);
    try {
      const c = authClient as unknown as {
        passkey?: {
          addPasskey?: (opts: {
            name: string;
            authenticatorAttachment?: "platform" | "cross-platform";
          }) => Promise<{ error?: { message?: string } }>;
        };
      };
      const fn = c.passkey?.addPasskey;
      if (!fn) {
        notifyError("Passkey plugin not enabled on the server.");
        return;
      }
      const res = await fn({ name, authenticatorAttachment: "platform" });
      if (res?.error) {
        notifyError(res.error.message ?? "Failed to add passkey");
        return;
      }
      refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const c = authClient as unknown as {
        passkey?: { deletePasskey?: (opts: { id: string }) => Promise<unknown> };
      };
      await c.passkey?.deletePasskey?.({ id });
      refresh();
    } catch (e) {
      notifyError(e, "Removing passkey");
    }
  };

  const supported =
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined";

  return (
    <div>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-medium">
        <KeyRoundIcon className="size-4" /> Passkeys
      </h2>
      {!supported && (
        <p className="mb-3 text-sm text-destructive">
          This browser doesn&rsquo;t support WebAuthn. Use Safari, Chrome, Edge,
          or Firefox to register a passkey.
        </p>
      )}
      <Card className="mb-4">
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[180px] space-y-1.5">
              <Label htmlFor="pkname">Passkey name</Label>
              <Input
                id="pkname"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="MacBook Touch ID"
              />
            </div>
            <Button size="sm" disabled={busy || !supported} onClick={add}>
              <PlusIcon /> Add passkey
            </Button>
          </div>
        </CardContent>
      </Card>

      <ul className="space-y-2">
        {items.length === 0 ? (
          <li className="text-sm text-muted-foreground">
            No passkeys registered yet.
          </li>
        ) : (
          items.map((p) => (
            <li key={p.id}>
              <Card>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">
                        {p.name ?? "(unnamed)"}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {p.deviceType ?? "device"} ·{" "}
                        {p.backedUp ? "synced" : "local"} · added{" "}
                        {new Date(p.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <ConfirmAction
                      title="Remove this passkey?"
                      description={`"${p.name}" will be removed. You'll need to re-enroll on this device to use a passkey again.`}
                      actionLabel="Remove"
                      destructive
                      onConfirm={() => remove(p.id)}
                    >
                      <Button variant="ghost" size="icon-sm">
                        <Trash2Icon />
                      </Button>
                    </ConfirmAction>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))
        )}
      </ul>
    </div>
  );
};

interface InstanceHealth {
  ok: boolean;
  dialect: string;
  ts: number;
}

const InstanceTab = () => {
  const [health, setHealth] = useState<InstanceHealth | null>(null);

  useEffect(() => {
    api<InstanceHealth>("/health")
      .then(setHealth)
      .catch(() => undefined);
  }, []);

  const onWorkers =
    typeof window !== "undefined" &&
    /workers\.dev|cloudflare/.test(window.location.host);
  const runtime = onWorkers ? "Cloudflare Workers" : "Bun (self-host)";
  const appUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-1 px-4 py-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <InfoIcon className="size-3.5" /> Instance configuration
          </div>
          <p>
            On Cloudflare Workers these values come from <code className="font-mono">wrangler.toml</code>{" "}
            <code className="font-mono">[vars]</code> and{" "}
            <code className="font-mono">wrangler secret</code>; they are
            read-only here. On Bun self-host, set them in{" "}
            <code className="font-mono">apps/web/.env</code> and restart the
            process.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-6">
          <ConfigRow
            label="APP_URL"
            value={appUrl}
            hint="Admin UI origin · used for CORS and auth callbacks."
          />
          <ConfigRow
            label="Runtime"
            value={runtime}
            hint="Auto-detected from request hostname."
            badge={
              <Badge
                variant="outline"
                className="gap-1.5 font-mono text-[10px] uppercase"
              >
                <span className="size-1.5 rounded-full bg-emerald-500" />
                detected
              </Badge>
            }
          />
          <ConfigRow
            label="Database"
            value={health?.dialect ?? "?"}
            hint="From /health · workers → D1, self-host → Bun SQLite or Postgres via DATABASE_URL."
            badge={
              health?.ok ? (
                <Badge className="gap-1.5 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  connected
                </Badge>
              ) : (
                <Badge variant="secondary">unknown</Badge>
              )
            }
          />
          <ConfigRow
            label="EMAIL_FROM"
            value="(not configured)"
            hint="When RESEND_API_KEY + EMAIL_FROM are set, transactional email goes via Resend; otherwise the console adapter logs to stdout."
          />
          <ConfigRow
            label="OAuth providers"
            value="(none configured)"
            hint="Set OAUTH_GOOGLE_* / OAUTH_GITHUB_* env vars to enable each provider."
          />
          <ConfigRow
            label="Open sign-up"
            value="enabled"
            hint="The first user to sign up gets the admin role; subsequent users get authenticated."
            badge={
              <Badge variant="outline" className="font-mono text-[10px] uppercase">
                enabled
              </Badge>
            }
          />
        </CardContent>
      </Card>
    </div>
  );
};

const ConfigRow = ({
  label,
  value,
  hint,
  badge,
}: {
  label: string;
  value: string;
  hint?: string;
  badge?: React.ReactNode;
}) => (
  <div className="grid grid-cols-1 gap-1 border-b border-border pb-3 last:border-b-0 last:pb-0 sm:grid-cols-[180px_1fr_auto] sm:items-start sm:gap-4">
    <div className="text-sm font-medium">{label}</div>
    <div className="space-y-1 min-w-0">
      <div className="break-all font-mono text-sm">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
    {badge && <div className="justify-self-start sm:justify-self-end">{badge}</div>}
  </div>
);

export const Settings = () => {
  return (
    <div>
      <PageHeader
        title="Settings"
        description="Manage roles, permissions, users, passkeys, and view instance configuration."
      />
      <Tabs defaultValue="roles" className="space-y-4">
        <TabsList>
          <TabsTrigger value="roles">
            <ShieldIcon /> Roles &amp; Permissions
          </TabsTrigger>
          <TabsTrigger value="users">
            <UserIcon /> Users
          </TabsTrigger>
          <TabsTrigger value="passkeys">
            <KeyRoundIcon /> Passkeys
          </TabsTrigger>
          <TabsTrigger value="instance">
            <ServerIcon /> Instance
          </TabsTrigger>
        </TabsList>
        <TabsContent value="roles">
          <RolesTab />
        </TabsContent>
        <TabsContent value="users">
          <UsersTab />
        </TabsContent>
        <TabsContent value="passkeys">
          <PasskeysTab />
        </TabsContent>
        <TabsContent value="instance">
          <InstanceTab />
        </TabsContent>
      </Tabs>
    </div>
  );
};
