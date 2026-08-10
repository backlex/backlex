// JWT signing keys and their life cycle.
//
// The card is a state machine made visible. What an operator has to understand
// before pressing anything is the ORDER — generate, let the JWKS propagate,
// promote — so the empty state and the freshly-generated row both say it,
// rather than leaving it in a doc nobody opens mid-rotation.
import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState, relativeTime } from "../../ui";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { signingKeysApi, type ApiSigningKey } from "../../api";
import { fetchSafely } from "../_shared";

const STATUS_LABEL: Record<string, string> = {
  standby: "standby",
  in_use: "in use",
  previously_used: "previously used",
  revoked: "revoked",
};

export function SigningKeysCard({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<ApiSigningKey[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetchSafely<{ data: ApiSigningKey[] }>("/api/admin/signing-keys");
      if (!live) return;
      setRows(res?.data ?? []);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  const reload = async () => {
    const res = await fetchSafely<{ data: ApiSigningKey[] }>("/api/admin/signing-keys");
    setRows(res?.data ?? []);
  };

  const generate = async () => {
    setBusy("generate");
    try {
      const res = await signingKeysApi.generate({});
      setRows((prev) => [...prev, res.data]);
      pushToast(t`Key generated — it is published and signing nothing. Promote it once verifiers have picked up the JWKS.`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Optimistic: a transition changes one row's status, and the whole set is
  // reconciled afterwards because promoting also demotes another row.
  const transition = async (row: ApiSigningKey, verb: "promote" | "revoke" | "restore") => {
    const snapshot = rows;
    setBusy(row.id);
    const optimistic: Record<typeof verb, string> = {
      promote: "in_use",
      revoke: "revoked",
      restore: row.activatedAt ? "previously_used" : "standby",
    };
    setRows(
      rows.map((r) =>
        r.id === row.id
          ? { ...r, status: optimistic[verb] as ApiSigningKey["status"] }
          : verb === "promote" && r.status === "in_use"
            ? { ...r, status: "previously_used" }
            : r,
      ),
    );
    try {
      await signingKeysApi[verb](row.id);
      await reload();
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (row: ApiSigningKey) => {
    const snapshot = rows;
    setRows(rows.filter((r) => r.id !== row.id));
    try {
      await signingKeysApi.remove(row.id);
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <I.Key size={13} />
        <span className="text-[13px] font-medium">
          <Trans>Signing keys</Trans>
        </span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          icon={I.Plus}
          disabled={busy !== null}
          onClick={() => void generate()}
        >
          {busy === "generate" ? <Trans>Generating…</Trans> : <Trans>Generate</Trans>}
        </Button>
      </div>

      <div className="border-b border-border px-4 py-3 text-[12.5px] text-muted-foreground">
        <Trans>
          Rotate by promoting a standby key, not by editing a secret and redeploying. A new key is
          published in the JWKS immediately and signs nothing — verifiers cache that document, so a
          key has to be visible before it signs. Promote it once they have picked it up.
        </Trans>
      </div>

      {!loaded ? (
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-6">
          <EmptyState
            bare
            size="sm"
            icon={I.Key}
            title={<Trans>No stored keys</Trans>}
            description={
              <Trans>
                Tokens are signed with whatever the environment configures. Generate a key to
                rotate from here instead — nothing changes until you promote one.
              </Trans>
            }
          />
        </div>
      ) : (
        rows.map((row) => (
          <div key={row.id} className="border-b border-border px-3.5 py-3 last:border-b-0">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2">
              <div className="min-w-0 sm:flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={row.status === "in_use" ? "default" : "outline"}>
                    {STATUS_LABEL[row.status] ?? row.status}
                  </Badge>
                  <span className="text-[12.5px]">{row.alg}</span>
                  {!row.published && (
                    <Badge variant="destructive">
                      <Trans>not in JWKS</Trans>
                    </Badge>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {row.kid}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {row.note ?? ""}
                  {row.createdAt ? ` · ${relativeTime(row.createdAt)}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-2">
                {row.status !== "in_use" && row.status !== "revoked" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void transition(row, "promote")}
                  >
                    <Trans>Promote</Trans>
                  </Button>
                )}
                {row.status === "revoked" ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void transition(row, "restore")}
                    >
                      <Trans>Restore</Trans>
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove(row)}>
                      <Trans>Delete</Trans>
                    </Button>
                  </>
                ) : (
                  row.status !== "in_use" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void transition(row, "revoke")}
                    >
                      <Trans>Revoke</Trans>
                    </Button>
                  )
                )}
              </div>
            </div>
          </div>
        ))
      )}
    </Card>
  );
}
