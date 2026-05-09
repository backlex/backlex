import { useEffect, useMemo, useRef, useState } from "react";
import { RadioIcon, SendIcon, PlusIcon, ShieldIcon } from "lucide-react";
import { Card, CardContent } from "@workeros/ui/components/card";
import { Input } from "@workeros/ui/components/input";
import { Button } from "@workeros/ui/components/button";
import { Label } from "@workeros/ui/components/label";
import { Badge } from "@workeros/ui/components/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";
import { cn } from "@workeros/ui/lib/utils";

type ConnState = "connecting" | "open" | "closed";

interface Entry {
  ts: string;
  data: string;
}

interface ChannelEntry {
  name: string;
  description: string;
  /** "system" channels reject external POST /publish (server-side gate). */
  kind: "items" | "collections" | "free-form";
}

interface Collection {
  slug: string;
}

const SYSTEM_CHANNELS: ChannelEntry[] = [
  {
    name: "collections",
    description: "Schema events · admin role only",
    kind: "collections",
  },
];

const ALWAYS_VISIBLE_FREEFORM: ChannelEntry[] = [
  { name: "demo", description: "Free-form · open", kind: "free-form" },
];

export const Realtime = () => {
  const [channelInput, setChannelInput] = useState("demo");
  const [channel, setChannel] = useState("demo");
  const [messages, setMessages] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const [conn, setConn] = useState<ConnState>("connecting");
  const [adHoc, setAdHoc] = useState<ChannelEntry[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // Fetch known collections so items:<slug> channels appear in the browser.
  useEffect(() => {
    api<{ data: Collection[] }>("/api/collections")
      .then((r) => setCollections(r.data))
      .catch(() => undefined);
  }, []);

  const channels: ChannelEntry[] = useMemo(() => {
    const items: ChannelEntry[] = collections.map((c) => ({
      name: `items:${c.slug}`,
      description: `Item events on ${c.slug} · permission-filtered`,
      kind: "items",
    }));
    const seen = new Set<string>();
    return [...items, ...SYSTEM_CHANNELS, ...ALWAYS_VISIBLE_FREEFORM, ...adHoc].filter(
      (c) => {
        if (seen.has(c.name)) return false;
        seen.add(c.name);
        return true;
      },
    );
  }, [collections, adHoc]);

  useEffect(() => {
    setMessages([]);
    setConn("connecting");
    const es = new EventSource(`/api/realtime/${channel}/subscribe`);
    es.addEventListener("open", () => setConn("open"));
    es.addEventListener("message", (e) => {
      setMessages((m) => [
        { ts: new Date().toLocaleTimeString(), data: e.data },
        ...m,
      ].slice(0, 200));
    });
    es.addEventListener("error", () => setConn("closed"));
    esRef.current = es;
    return () => {
      es.close();
      setConn("closed");
    };
  }, [channel]);

  const send = async () => {
    if (!text.trim()) return;
    try {
      const res = await fetch(`/api/realtime/${channel}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setText("");
    } catch (e) {
      notifyError(e, "Publishing message");
    }
  };

  const connBadge =
    conn === "open" ? (
      <Badge className="gap-1.5 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
        <span className="size-1.5 rounded-full bg-emerald-500" /> connected
      </Badge>
    ) : conn === "connecting" ? (
      <Badge variant="secondary" className="gap-1.5">
        <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
        connecting…
      </Badge>
    ) : (
      <Badge variant="destructive" className="gap-1.5">
        <span className="size-1.5 rounded-full bg-current" /> disconnected
      </Badge>
    );

  const isSystem = channel.startsWith("items:") || channel === "collections";

  const groupedChannels = useMemo(() => {
    return {
      items: channels.filter((c) => c.kind === "items"),
      system: channels.filter((c) => c.kind === "collections"),
      freeForm: channels.filter((c) => c.kind === "free-form"),
    };
  }, [channels]);

  return (
    <div>
      <PageHeader
        title="Realtime"
        description="In-process pub/sub on Bun, Durable Objects on Workers. Permission filter applies on subscribe + publish."
        actions={connBadge}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr] items-start">
        {/* Channel browser */}
        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <RadioIcon className="size-4" />
            <span className="text-sm font-medium">Channels</span>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="icon-sm"
              title="Subscribe to ad-hoc channel"
              onClick={() => setAddOpen(true)}
            >
              <PlusIcon />
            </Button>
          </div>
          <ChannelGroup
            title="Items"
            entries={groupedChannels.items}
            active={channel}
            onSelect={setChannel}
          />
          <ChannelGroup
            title="System"
            entries={groupedChannels.system}
            active={channel}
            onSelect={setChannel}
          />
          <ChannelGroup
            title="Free-form"
            entries={groupedChannels.freeForm}
            active={channel}
            onSelect={setChannel}
          />
        </Card>

        {/* Active channel detail */}
        <div className="space-y-3">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <RadioIcon className="size-4" />
              <span className="font-mono text-sm">{channel}</span>
              {isSystem && (
                <Badge variant="outline" className="gap-1 text-[10px]">
                  <ShieldIcon className="size-3" /> permission-aware
                </Badge>
              )}
              <div className="flex-1" />
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {messages.length} event(s)
              </span>
            </div>

            {!isSystem && (
              <div className="border-b border-border px-4 py-3">
                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    send();
                  }}
                >
                  <div className="flex-1 space-y-1.5">
                    <Label htmlFor="msg" className="text-xs">
                      Publish to {channel}
                    </Label>
                    <Input
                      id="msg"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder="Message body (any JSON or string)"
                      className="font-mono text-xs"
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={!text.trim() || conn !== "open"}
                  >
                    <SendIcon /> Publish
                  </Button>
                </form>
              </div>
            )}

            <CardContent className="p-0">
              {messages.length === 0 ? (
                <EmptyState
                  icon={RadioIcon}
                  title={isSystem ? "Subscribed" : "Waiting for messages"}
                  description={
                    isSystem
                      ? `Subscribed to ${channel}. CRUD on this collection will publish events here.`
                      : `Subscribed to ${channel}. Publish above or wait for events.`
                  }
                />
              ) : (
                <ul className="max-h-[60vh] divide-y divide-border overflow-auto">
                  {messages.map((m, i) => (
                    <li
                      key={i}
                      className="flex items-baseline gap-3 px-4 py-2 text-sm"
                    >
                      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                        {m.ts}
                      </span>
                      <code className="break-all font-mono text-xs">
                        {m.data}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {isSystem && (
            <p className="text-xs text-muted-foreground">
              System channels (<code className="font-mono">items:*</code>,{" "}
              <code className="font-mono">collections</code>) reject external
              POST publish — events come from the CRUD routes themselves.
            </p>
          )}
        </div>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Subscribe to channel</DialogTitle>
            <DialogDescription>
              Free-form channel name — any string works. System channels (
              <code className="font-mono">items:*</code>,{" "}
              <code className="font-mono">collections</code>) appear automatically.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = channelInput.trim();
              if (!trimmed) return;
              setAdHoc((prev) =>
                prev.find((c) => c.name === trimmed)
                  ? prev
                  : [
                      ...prev,
                      {
                        name: trimmed,
                        description: "Free-form · open",
                        kind: "free-form",
                      },
                    ],
              );
              setChannel(trimmed);
              setAddOpen(false);
            }}
            className="space-y-3"
          >
            <div className="space-y-1.5">
              <Label htmlFor="newch">Channel</Label>
              <Input
                id="newch"
                value={channelInput}
                onChange={(e) => setChannelInput(e.target.value)}
                placeholder="presence:editor"
                className="font-mono"
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setAddOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit">Subscribe</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

interface ChannelGroupProps {
  title: string;
  entries: ChannelEntry[];
  active: string;
  onSelect: (name: string) => void;
}

const ChannelGroup = ({ title, entries, active, onSelect }: ChannelGroupProps) => {
  if (entries.length === 0) return null;
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <ul>
        {entries.map((c) => (
          <li
            key={c.name}
            onClick={() => onSelect(c.name)}
            className={cn(
              "flex cursor-pointer items-center gap-2 px-3 py-2 text-sm transition-colors",
              active === c.name ? "bg-accent" : "hover:bg-muted/40",
            )}
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                active === c.name ? "bg-primary" : "bg-muted-foreground/40",
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-xs">{c.name}</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {c.description}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};
