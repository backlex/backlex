import { useEffect, useState } from "react";
import { ActivityIcon } from "lucide-react";
import { Card, CardContent } from "@workeros/ui/components/card";
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
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";

interface ActivityEntry {
  id: string;
  userId: string | null;
  action: string;
  collection: string;
  itemId: string | null;
  ip: string | null;
  userAgent: string | null;
  payload: unknown;
  createdAt: string;
}

const fmtPayload = (p: unknown) => {
  if (p === null || p === undefined) return "—";
  try {
    const s = JSON.stringify(p);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch {
    return String(p);
  }
};

const ALL_ACTIONS = "(any)";

const actionVariant = (
  action: string,
): "default" | "secondary" | "destructive" | "outline" => {
  switch (action) {
    case "create":
      return "default";
    case "update":
      return "secondary";
    case "delete":
      return "destructive";
    default:
      return "outline";
  }
};

export const Activity = () => {
  const [items, setItems] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [collection, setCollection] = useState("");
  const [collectionInput, setCollectionInput] = useState("");
  const [action, setAction] = useState<string>(ALL_ACTIONS);

  const refresh = () => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("limit", "100");
    if (collection) params.set("collection", collection);
    api<{ data: ActivityEntry[] }>(`/api/activity?${params}`)
      .then((r) => {
        const filtered =
          action === ALL_ACTIONS
            ? r.data
            : r.data.filter((a) => a.action === action);
        setItems(filtered);
      })
      .catch((e) => notifyError(e, "Loading activity"))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, [collection, action]);

  return (
    <div>
      <PageHeader
        title="Activity"
        description="Audit log of every CRUD action across collections, files, and admin operations."
        actions={
          <Button variant="outline" size="sm" onClick={refresh}>
            Refresh
          </Button>
        }
      />

      <Card className="mb-4">
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setCollection(collectionInput);
            }}
          >
            <div className="flex-1 min-w-[180px] space-y-1.5">
              <Label htmlFor="filter">Collection</Label>
              <Input
                id="filter"
                value={collectionInput}
                onChange={(e) => setCollectionInput(e.target.value)}
                placeholder="(all)"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Action</Label>
              <Select value={action} onValueChange={setAction}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_ACTIONS}>{ALL_ACTIONS}</SelectItem>
                  <SelectItem value="create">create</SelectItem>
                  <SelectItem value="update">update</SelectItem>
                  <SelectItem value="delete">delete</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" size="sm">
              Apply
            </Button>
            {(collection || action !== ALL_ACTIONS) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setCollection("");
                  setCollectionInput("");
                  setAction(ALL_ACTIONS);
                }}
              >
                Clear
              </Button>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          {loading ? (
            <ul className="divide-y">
              {Array.from({ length: 5 }).map((_, i) => (
                <li key={i} className="space-y-2 py-3">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </li>
              ))}
            </ul>
          ) : items.length === 0 ? (
            <EmptyState
              icon={ActivityIcon}
              title="No activity yet"
              description="Each create/update/delete on collections, items, files, and admin endpoints lands here."
            />
          ) : (
            <ul className="divide-y">
              {items.map((a) => (
                <li key={a.id} className="py-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant={actionVariant(a.action)}
                          className="font-mono uppercase"
                        >
                          {a.action}
                        </Badge>
                        <span className="font-mono">{a.collection}</span>
                        {a.itemId && (
                          <span className="font-mono text-xs text-muted-foreground">
                            {a.itemId.slice(0, 8)}…
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {a.userId ? `user ${a.userId.slice(0, 8)}…` : "anonymous"}
                        {a.ip ? ` · ${a.ip}` : ""}
                      </div>
                      <div className="break-all font-mono text-xs text-muted-foreground">
                        {fmtPayload(a.payload)}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {new Date(a.createdAt).toLocaleString()}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
