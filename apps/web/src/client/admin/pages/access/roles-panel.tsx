// The roles tab of the Access page: the role list, the editor that writes it,
// and the cards that show the same rules from the database's side.
//
// This panel used to be the single most misleading screen in the product. Its
// save built `{name, description, mcpTools, mcpReadOnly, orgAssignable}` and
// dropped the matrix on the floor, while the dialog captioned the compiled rule
// "saved to role_permissions on save"; its load hardcoded every role's matrix to
// `{read:"all",create:"all",update:"all",delete:"all"}` and showed the row's
// DESCRIPTION where its rule belonged. So an operator ticked five actions, read
// a compiled rule and a promise it was stored, and got a role with zero
// permission rows under which every request is denied — and reopening any
// existing role showed a fabricated preset that saving then made real.
//
// Everything below exists to close that gap: the matrix is derived from the
// stored rows on the way in, and sent on the way out.
import type { PushToast } from "../../types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, IconButton } from "../../ui";
import { Card } from "@backlex/ui/components/card";
import { api } from "@/lib/api";
import { ConfirmDialog } from "../../sheet";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { useMe } from "../../queries";
import { PermissionsMatrix } from "./permissions-matrix";
import { RlsCard } from "./rls-card";
import { ImpersonationCard } from "./impersonation-card";
import {
  RoleEditor,
  defaultRoleRule,
  ruleSummary,
  type RoleData,
  type RoleMatrix,
  type RuleState,
} from "./role-editor";

/** Every action the permission DSL knows, and therefore every key of a
 *  `RoleMatrix`. Declared here rather than imported because `role-editor.tsx`
 *  keeps its copy private; the two must stay in step. */
const ACTIONS = ["read", "create", "update", "delete", "publish"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * The collection a role-wide grant is stored against.
 *
 * The five-way picker in the role editor names an action and no collection, so
 * what it describes is a workspace-wide grant — and `*` is exactly how the
 * resolver spells that (`collection IN (slug, '*')`). The per-collection cells
 * live in the matrix card below the list and are left strictly alone here.
 */
const ROLE_WIDE = "*";

/** The two conditions the picker can express. Both are stored verbatim, so the
 *  round trip is an equality check rather than a heuristic. */
const OWNER_CONDITION = { owner_id: { _eq: "$user.id" } };
const PUBLISHED_CONDITION = { status: { _eq: "published" } };

/** A permission row as `GET /api/roles/{id}/permissions` returns it. */
export interface StoredPermission {
  id: string;
  roleId?: string;
  collection: string;
  action: string;
  fields: string[] | null;
  condition: unknown;
}

/** One entry of the complete desired set `PUT /api/roles/{id}/permissions`
 *  takes. `id` names the stored row an entry describes, so a rewritten
 *  condition keeps its row — and the audit trail already keyed to it — instead
 *  of being deleted and recreated. */
export interface DesiredPermission {
  id?: string;
  collection: string;
  action: string;
  fields: string[] | null;
  condition: unknown;
}

const isAction = (v: string): v is Action => (ACTIONS as readonly string[]).includes(v);

/** `{ owner_id: { _eq: "$user.id" } }` and nothing else. The shape is checked
 *  key by key rather than by JSON comparison so a row carrying an extra clause
 *  is correctly reported as inexpressible instead of being flattened. */
const isOwnerCondition = (c: unknown): boolean => {
  const o = c as Record<string, any> | null;
  if (!o || typeof o !== "object" || Object.keys(o).length !== 1) return false;
  const cmp = o.owner_id as Record<string, unknown> | undefined;
  if (!cmp || typeof cmp !== "object") return false;
  return Object.keys(cmp).length === 1 && cmp._eq === "$user.id";
};

/** `{ status: { _eq: "published" } }` and nothing else. */
const isPublishedCondition = (c: unknown): boolean => {
  const o = c as Record<string, any> | null;
  if (!o || typeof o !== "object" || Object.keys(o).length !== 1) return false;
  const cmp = o.status as Record<string, unknown> | undefined;
  if (!cmp || typeof cmp !== "object") return false;
  return Object.keys(cmp).length === 1 && cmp._eq === "published";
};

/**
 * Which of the picker's five states a stored condition IS — or `null` when the
 * picker cannot say.
 *
 * `null` is not a failure. A condition written through the rule builder, the
 * CLI or the SDK can be anything the DSL accepts, and the honest answer for one
 * of those is "this editor does not model it" — which is what keeps it from
 * being silently rewritten as something simpler on the next save.
 */
export function stateFromCondition(condition: unknown): RuleState | null {
  // A row with no condition is the DSL's own spelling of unrestricted.
  if (condition == null) return "all";
  if (isOwnerCondition(condition)) return "owner";
  if (isPublishedCondition(condition)) return "published";
  return null;
}

/**
 * The condition to store for a picked state.
 *
 * `auth` collapses onto `all`, and that is not a shortcut. A permission row is
 * attached to a ROLE, and every role other than `public` is only ever resolved
 * for a signed-in subject — so "any signed-in user" and "everyone in this role"
 * select the same rows, and the DSL has no subject-level predicate to
 * distinguish them with. Reading such a row back therefore reports `all`.
 *
 * `none` never reaches here: see {@link desiredPermissions}.
 */
export function conditionForState(state: RuleState): unknown {
  if (state === "owner") return OWNER_CONDITION;
  if (state === "published") return PUBLISHED_CONDITION;
  return null;
}

/** How much a state opens up, for OR-ing two rows on the same action. */
const PERMISSIVENESS: Record<RuleState, number> = {
  none: 0,
  owner: 1,
  published: 1,
  auth: 2,
  all: 3,
};

/** A matrix in which every action is denied — the state a role with no stored
 *  rows is actually in, and the only honest place to start reading from. */
export function deniedMatrix(): RoleMatrix {
  return { read: "none", create: "none", update: "none", delete: "none", publish: "none" };
}

/**
 * Read a role's stored rows back into the matrix the editor renders.
 *
 * `opaque` names the actions whose role-wide row carries a condition
 * {@link stateFromCondition} could not read. Those are reported rather than
 * guessed at, and {@link desiredPermissions} carries them through a save
 * untouched.
 */
export function matrixFromPermissions(rows: StoredPermission[]): {
  matrix: RoleMatrix;
  opaque: Action[];
} {
  const matrix = deniedMatrix();
  const opaque = new Set<Action>();
  for (const row of rows) {
    if (row.collection !== ROLE_WIDE) continue;
    // Bound to a local so the narrowing survives the call below — `action` is
    // stored as a plain string, and an unrecognised one (a row written by a
    // future release) is skipped rather than widening the matrix's key type.
    const action = row.action;
    if (!isAction(action)) continue;
    const state = stateFromCondition(row.condition);
    if (state === null) {
      opaque.add(action);
      continue;
    }
    // The resolver OR-combines every row that matches, so two rows on one
    // action mean the more permissive of them is what the role actually has.
    if (PERMISSIVENESS[state] > PERMISSIVENESS[matrix[action]]) {
      matrix[action] = state;
    }
  }
  return { matrix, opaque: ACTIONS.filter((a) => opaque.has(a)) };
}

/**
 * The role's COMPLETE permission set after this save — what the PUT replaces
 * everything with.
 *
 * Two kinds of row survive untouched, and both would otherwise be revoked by an
 * endpoint that replaces the whole set:
 *
 *  - per-collection grants, which belong to the matrix card further down the
 *    page and were never shown in this dialog;
 *  - role-wide rows whose condition the five-way picker cannot express.
 *
 * And one row is deliberately not written at all. `none` means no access, and
 * the DSL has no deny operator — `{_deny: true}` is a field comparison carrying
 * no recognised operator, which the compiler reduces to TRUE, i.e. FULL access.
 * Absence is the only thing that denies, so `none` emits nothing.
 */
export function desiredPermissions(
  existing: StoredPermission[],
  matrix: RoleMatrix,
): DesiredPermission[] {
  const opaqueActions = new Set(
    existing
      .filter((r) => r.collection === ROLE_WIDE && stateFromCondition(r.condition) === null)
      .map((r) => r.action),
  );
  const out: DesiredPermission[] = [];
  for (const row of existing) {
    if (row.collection === ROLE_WIDE && !opaqueActions.has(row.action)) continue;
    out.push({
      id: row.id,
      collection: row.collection,
      action: row.action,
      fields: row.fields ?? null,
      condition: row.condition ?? null,
    });
  }
  for (const action of ACTIONS) {
    if (opaqueActions.has(action)) continue;
    const state = matrix[action];
    if (state === "none") continue;
    // Reuse the row already standing in this cell so the server rewrites it in
    // place; a field allow-list set elsewhere rides along rather than being
    // cleared by an editor that never offered it.
    const prior = existing.find((r) => r.collection === ROLE_WIDE && r.action === action);
    out.push({
      ...(prior ? { id: prior.id } : {}),
      collection: ROLE_WIDE,
      action,
      fields: prior?.fields ?? null,
      condition: conditionForState(state),
    });
  }
  return out;
}

/** localStorage key for the zero-permission notice, per signed-in admin. The
 *  warning is about roles this workspace already holds, so one person reading
 *  and dismissing it should not answer it for their colleagues. */
export const noticeKeyFor = (userId: string | null): string =>
  `backlex.roles.zero-permission-notice.${userId ?? "anon"}`;

const readDismissed = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    // localStorage unavailable (private window, blocked site data) — show the
    // notice rather than swallow it; dismissing it then holds for the session.
    return false;
  }
};

const writeDismissed = (key: string): void => {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Same as above: the dismissal holds for this session only.
  }
};

const SYSTEM_ROLE_NAMES = ["admin", "authenticated", "public"];

/** A role row as this panel holds it: everything `RoleEditor` needs, plus what
 *  the list renders that the editor does not model. */
interface RoleRow extends RoleData {
  id: string;
  /** `roles.admin` — this role bypasses the permission tables entirely, so its
   *  matrix says nothing about what it can reach. */
  bypass: boolean;
  /** Actions whose role-wide rule the picker cannot express. */
  opaque: Action[];
}

interface ApiRoleRow {
  id: string;
  name: string;
  description: string | null;
  admin: boolean;
  mcpTools: string[] | null;
  mcpReadOnly: boolean;
  orgAssignable: boolean;
}

const badgesFor = (row: {
  bypass?: boolean;
  mcpReadOnly?: boolean;
  mcpTools?: string[] | null;
  orgAssignable?: boolean;
}): string[] => [
  ...(row.bypass ? ["bypass"] : []),
  // Surfaced on the row so an operator can see at a glance which roles an agent
  // is constrained by without opening each editor.
  ...(row.mcpReadOnly ? ["mcp read-only"] : []),
  ...(row.mcpTools ? ["mcp scoped"] : []),
  // Which roles have left the workspace matters at a glance: it's the set a
  // customer's org admin can hand out on their own.
  ...(row.orgAssignable ? ["org-assignable"] : []),
];

export function RolesPanel({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [roles, setRoles] = useState<RoleRow[]>([]);
  /** Every stored row for every role, keyed by role id. Held because a save
   *  replaces the WHOLE set and so has to restate the rows this editor never
   *  showed. */
  const [perms, setPerms] = useState<Record<string, StoredPermission[]>>({});
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [deleting, setDeleting] = useState<RoleRow | null>(null);
  /** How many workspace users hold the role queued for deletion; `null` while
   *  the count is still being fetched, or when it could not be read. */
  const [holders, setHolders] = useState<number | null>(null);

  const meQuery = useMe();
  const userId = meQuery.data?.data?.id ?? null;
  const noticeKey = noticeKeyFor(userId);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const noticeDismissed = useMemo(
    () => dismissedKey === noticeKey || readDismissed(noticeKey),
    [dismissedKey, noticeKey],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api<{ data: ApiRoleRow[] }>(`/api/roles`);
        const rows = Array.isArray(r.data) ? r.data : [];
        // Every role's real rows, in parallel. A role whose fetch fails renders
        // from an empty set — which reads as "denied", the same thing the
        // server does with rows it cannot see.
        const fetched = await Promise.all(
          rows.map(async (row) => {
            try {
              const res = await api<{ data: StoredPermission[] }>(
                `/api/roles/${row.id}/permissions`,
              );
              return [row.id, res.data ?? []] as const;
            } catch {
              return [row.id, [] as StoredPermission[]] as const;
            }
          }),
        );
        if (cancelled) return;
        const byRole: Record<string, StoredPermission[]> = {};
        for (const [id, list] of fetched) byRole[id] = list;
        setPerms(byRole);
        setRoles(
          rows.map((row) => {
            const { matrix, opaque } = matrixFromPermissions(byRole[row.id] ?? []);
            return {
              id: row.id,
              name: row.name,
              system: SYSTEM_ROLE_NAMES.includes(row.name),
              bypass: Boolean(row.admin),
              opaque,
              badges: badgesFor({ ...row, bypass: row.admin }),
              description: row.description ?? "",
              matrix,
              rule: ruleSummary(matrix),
              mcpTools: row.mcpTools ?? null,
              mcpReadOnly: Boolean(row.mcpReadOnly),
              orgAssignable: Boolean(row.orgAssignable),
            };
          }),
        );
      } catch {
        // Leave the list empty; the empty state explains itself.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openNew = () => {
    setEditing(null);
    setIsNew(true);
  };
  const openEdit = (r: RoleRow) => {
    setEditing(r);
    setIsNew(false);
  };
  const close = () => {
    setEditing(null);
    setIsNew(false);
  };

  /** Replace a role's whole permission set, then adopt what the server read
   *  back. "The request was accepted" and "the rows now say this" are different
   *  claims, and this screen exists because the second was being asserted
   *  without the first ever being made. */
  const putPermissions = useCallback(
    async (roleId: string, permissions: DesiredPermission[]): Promise<void> => {
      const res = await api<{ data: StoredPermission[] }>(
        `/api/roles/${roleId}/permissions`,
        { method: "PUT", body: JSON.stringify({ permissions }) },
      );
      if (Array.isArray(res?.data)) {
        setPerms((p) => ({ ...p, [roleId]: res.data }));
      }
    },
    [],
  );

  const save = async (data: RoleData) => {
    const matrix = data.matrix ?? defaultRoleRule();
    const rolesSnapshot = roles;
    const permsSnapshot = perms;
    const target = editing;
    setEditing(null);
    setIsNew(false);
    const payload = {
      name: data.name,
      description: data.description,
      mcpTools: data.mcpTools ?? null,
      mcpReadOnly: data.mcpReadOnly ?? false,
      orgAssignable: data.orgAssignable ?? false,
    };

    if (isNew) {
      if (roles.some((r) => r.name === data.name)) {
        pushToast(t`Role "${data.name}" already exists.`, "error");
        return;
      }
      // Paint first: the row, its badges and its rule all read the new values
      // while the two requests are still in flight, and every one of them is
      // rolled back together if either fails.
      const optimistic: RoleRow = {
        ...data,
        id: "",
        bypass: false,
        opaque: [],
        matrix,
        rule: ruleSummary(matrix),
        badges: badgesFor({ ...data, bypass: false }),
      };
      setRoles((arr) => [...arr, optimistic]);
      try {
        const created = await api<{ data: { id: string } }>(`/api/roles`, {
          method: "POST",
          body: JSON.stringify({ ...payload, admin: false }),
        });
        const id = created.data.id;
        // Reconcile the server-assigned id so a follow-up edit patches the
        // right row instead of falling back to a name lookup.
        setRoles((arr) => arr.map((r) => (r.name === data.name ? { ...r, id } : r)));
        await putPermissions(id, desiredPermissions([], matrix));
        pushToast(t`Role "${data.name}" created.`);
      } catch (e) {
        setRoles(rolesSnapshot);
        setPerms(permsSnapshot);
        pushToast((e as Error).message, "error");
      }
      return;
    }

    if (!target) return;
    const id = target.id || data.id || "";
    const existing = perms[id] ?? [];
    const { opaque } = matrixFromPermissions(existing);
    setRoles((arr) =>
      arr.map((r) =>
        r.id === target.id
          ? {
              ...r,
              ...data,
              id: r.id,
              bypass: r.bypass,
              // An action the picker could not express keeps its rule, so it
              // keeps being reported as unexpressed.
              opaque,
              matrix,
              rule: ruleSummary(matrix),
              badges: badgesFor({ ...data, bypass: r.bypass }),
            }
          : r,
      ),
    );
    try {
      if (!id) throw new Error("Role id missing — reload the page and retry.");
      await api(`/api/roles/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
      await putPermissions(id, desiredPermissions(existing, matrix));
      pushToast(t`Role "${data.name}" saved.`);
    } catch (e) {
      setRoles(rolesSnapshot);
      setPerms(permsSnapshot);
      pushToast((e as Error).message, "error");
    }
  };

  /** Count the workspace users holding a role, so the confirm names the blast
   *  radius instead of asking for a signature on an unknown. */
  const requestDelete = (role: RoleRow) => {
    setDeleting(role);
    setHolders(null);
    void (async () => {
      try {
        const res = await api<{ data: { roles?: { id: string }[] }[] }>(`/api/users`);
        const n = (res.data ?? []).filter((u) =>
          (u.roles ?? []).some((r) => r.id === role.id),
        ).length;
        setHolders(n);
      } catch {
        // Leave it null — the dialog then says the count is unknown rather than
        // claiming zero, which is the one wrong answer here.
      }
    })();
  };

  const confirmDelete = async () => {
    const role = deleting;
    if (!role) return;
    const rolesSnapshot = roles;
    const permsSnapshot = perms;
    setDeleting(null);
    setRoles((arr) => arr.filter((r) => r.id !== role.id));
    try {
      await api(`/api/roles/${role.id}`, { method: "DELETE" });
      setPerms((p) => {
        const next = { ...p };
        delete next[role.id];
        return next;
      });
      pushToast(t`Role "${role.name}" deleted.`);
    } catch (e) {
      setRoles(rolesSnapshot);
      setPerms(permsSnapshot);
      pushToast((e as Error).message, "error");
    }
  };

  const systemCount = roles.filter((r) => r.system).length;
  const customCount = roles.filter((r) => !r.system).length;

  return (
    <div className="flex flex-col gap-3.5">
      {!meQuery.isPending && !noticeDismissed && (
        <Card className="gap-2 border-[color-mix(in_oklch,oklch(0.78_0.16_75)_45%,var(--border))] bg-[color-mix(in_oklch,oklch(0.78_0.16_75)_10%,var(--card))] p-3.5">
          <div className="flex items-start gap-2.5">
            <I.AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[13px] font-medium">
                <Trans>Re-check every role created here before today</Trans>
              </span>
              <span className="text-[12px] text-muted-foreground">
                <Trans>
                  This editor used to display a full permission matrix and save
                  none of it. A role created that way holds no permission rows at
                  all, so every request made under it is denied. Open each custom
                  role, set the access it should have, and save — this screen now
                  writes what it shows.
                </Trans>
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                writeDismissed(noticeKey);
                setDismissedKey(noticeKey);
              }}
            >
              <Trans>Got it</Trans>
            </Button>
          </div>
        </Card>
      )}

      <Card className="py-0 gap-0">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <I.Shield size={14} />
          <span className="text-[13px] font-medium">
            <Trans>roles</Trans>
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            <Trans>
              {systemCount} system · {customCount} custom
            </Trans>
          </span>
          <div className="flex-1" />
          <Button variant="primary" size="sm" icon={I.Plus} onClick={openNew}>
            <Trans>Add role</Trans>
          </Button>
        </div>
        {!loaded && (
          <div className="flex flex-col gap-3 px-3.5 py-[11px]">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="grid grid-cols-[24px_200px_1fr_auto] items-center gap-3 max-[640px]:grid-cols-[24px_1fr_auto]"
              >
                <Skeleton className="size-3.5 rounded-full" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-3/4 max-[640px]:hidden" />
                <Skeleton className="size-7" />
              </div>
            ))}
          </div>
        )}
        {loaded && roles.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            <Trans>No roles in this workspace yet.</Trans>
          </div>
        )}
        {roles.map((r) => (
          <div
            key={r.id || r.name}
            className="grid grid-cols-[24px_200px_1fr_auto] max-[640px]:grid-cols-[24px_1fr_auto] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0"
          >
            <span>
              <I.Users size={14} />
            </span>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="font-mono text-[13px]">{r.name}</span>
              {r.system && (
                <Badge variant="secondary">
                  <Trans>system</Trans>
                </Badge>
              )}
              {(r.badges || []).map((b) => (
                <Badge key={b} variant="outline">
                  {b}
                </Badge>
              ))}
            </div>
            <span className="truncate font-mono text-xs text-muted-foreground max-[640px]:hidden">
              {r.bypass ? (
                <Trans>bypasses every permission check</Trans>
              ) : r.opaque.length > 0 ? (
                <Trans>
                  {r.rule} · {r.opaque.length} kept as written
                </Trans>
              ) : (
                r.rule
              )}
            </span>
            {/* Both controls hug the right edge, which is where the house style
                puts row actions on a phone. Delete is offered for custom roles
                only: the server refuses a system role outright, and a button
                that exists to be rejected is not an affordance. */}
            <div className="flex items-center justify-end gap-1">
              <IconButton icon={I.Pencil} title={t`Edit role`} onClick={() => openEdit(r)} />
              {!r.system && (
                <IconButton
                  icon={I.Trash}
                  title={t`Delete role`}
                  onClick={() => requestDelete(r)}
                />
              )}
            </div>
          </div>
        ))}
        <div className="border-t border-border px-4 py-2.5 text-[11.5px] text-muted-foreground">
          <Trans>
            A role's own permissions apply to every collection. The matrix below
            narrows or widens them one collection at a time.
          </Trans>
        </div>
      </Card>

      <PermissionsMatrix roles={roles} pushToast={pushToast} />
      {/* The same rules, pushed into the database — so a connection that never
          touches the API is filtered too. */}
      <RlsCard pushToast={pushToast} />
      {/* Seeing what one of those roles actually sees, for one real person. */}
      <ImpersonationCard pushToast={pushToast} />
      <RoleEditor
        open={editing !== null || isNew}
        role={editing}
        isNew={isNew}
        onClose={close}
        onSave={save}
      />
      <ConfirmDialog
        open={deleting !== null}
        destructive
        title={t`Delete role "${deleting?.name ?? ""}"?`}
        description={
          holders === null
            ? t`Its permission rows go with it, and anyone still holding it loses whatever it granted. How many members hold it could not be read just now.`
            : holders === 0
              ? t`No workspace member holds this role. Its permission rows are deleted with it.`
              : t`${holders} workspace member(s) hold this role and lose whatever it granted. Its permission rows are deleted with it.`
        }
        actionLabel={t`Delete role`}
        onConfirm={() => {
          void confirmDelete();
        }}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
