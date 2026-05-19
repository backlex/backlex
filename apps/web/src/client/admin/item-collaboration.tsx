// Collaboration tab for the item edit sheet — share card + comment thread.
//
// Mock-only for now: the share token, comment list, and composer all live in
// local component state. Wire to /api/comments when that lands.
import { useState, type KeyboardEvent } from "react";
import { I } from "./icons";
import { Button } from "./ui";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";

interface Comment {
  id: string;
  who: string;
  initials: string;
  t: string;
  body: string;
}

// TODO(comments): replace with /api/comments when the endpoint lands.
const SEED_COMMENTS: Comment[] = [
  { id: "c_01", who: "kai", initials: "KT", t: "2m ago", body: "Can you confirm the cf-image fit param before I publish?" },
  { id: "c_02", who: "rana", initials: "RM", t: "1m ago", body: "Going with fit=cover for now — we can revisit when we ship the responsive image helper." },
  { id: "c_03", who: "priya", initials: "PR", t: "just now", body: "+1 — same call we made on the docs site." },
];

const SHARE_URL = "https://workeros.dev/s/01HZ7K8Q6XYZ?token=sv1_a4e2b9c1f0";
const SHARE_URL_DISPLAY = "https://workeros.dev/s/01HZ7K8Q6XYZ?token=sv1_a4e…";

const CHIP =
  "inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-3xl border border-border bg-card px-[11px] text-[12.5px] text-foreground hover:bg-accent";
const AVATAR_XS =
  "grid size-[18px] place-items-center rounded-full border border-border bg-muted font-mono text-[9.5px] text-muted-foreground";

export function ItemCommentsPanel({ pushToast }: { pushToast?: (m: string, type?: "success" | "error") => void }) {
  const [items, setItems] = useState<Comment[]>(SEED_COMMENTS);
  const [draft, setDraft] = useState("");
  const [shareCopied, setShareCopied] = useState(false);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setItems((arr) => [
      ...arr,
      {
        id: "c_" + Math.random().toString(36).slice(2, 6),
        who: "rana",
        initials: "RM",
        t: "just now",
        body: text,
      },
    ]);
    setDraft("");
    pushToast?.("Comment posted.");
  };

  const copyShare = () => {
    try {
      void navigator.clipboard.writeText(SHARE_URL);
      setShareCopied(true);
      pushToast?.("Share link copied.");
      setTimeout(() => setShareCopied(false), 1800);
    } catch {
      pushToast?.("Could not copy link.", "error");
    }
  };

  const onDraftKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col gap-3.5">
      {/* Share */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <I.Share size={13} />
          <span className="text-[12.5px] font-medium">share this record</span>
        </div>
        <div className="flex flex-col gap-2.5 p-3.5">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Public read-only link</label>
            <div className="flex gap-1.5">
              <Input className="font-mono flex-1 text-[11.5px]" readOnly value={SHARE_URL_DISPLAY} />
              <Button variant="outline" icon={shareCopied ? I.Check : I.Copy} onClick={copyShare}>
                {shareCopied ? "Copied" : "Copy"}
              </Button>
            </div>
            <span className="text-[11.5px] text-muted-foreground">
              Signed view token, expires in 7d · revocable from <span className="font-mono">api_keys</span>.
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span className={CHIP}>
              <I.Eye size={11} /> read-only
            </span>
            <span className={CHIP}>
              <I.Clock size={11} /> 7d expiry
            </span>
            <span className={CHIP}>
              <I.Lock size={11} /> password off
            </span>
          </div>
        </div>
      </div>

      {/* Comments */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <I.MessageSquare size={13} />
          <span className="text-[12.5px] font-medium">comments</span>
          <span className="font-mono text-[11.5px] text-muted-foreground">{items.length}</span>
        </div>
        <div className="flex flex-col gap-2.5 px-3.5 py-3">
          {items.map((c) => (
            <div key={c.id} className="flex items-start gap-2 border-b border-dashed border-border py-2 last:border-b-0">
              <div className={AVATAR_XS}>{c.initials}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[12.5px] font-medium">{c.who}</span>
                  <span className="font-mono text-[10.5px] text-muted-foreground">{c.t}</span>
                </div>
                <div className="mt-0.5 text-[12.5px] text-foreground">{c.body}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-start gap-1.5 border-t border-border p-3">
          <div className={`${AVATAR_XS} mt-1`}>RM</div>
          <Textarea
            placeholder="Write a comment · @-mention to notify · ⌘+Enter to send"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKey}
            rows={2}
            className="min-h-[60px] flex-1 text-[12.5px]"
          />
          <Button variant="primary" size="sm" icon={I.Send} onClick={send} disabled={!draft.trim()}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
