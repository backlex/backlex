// Collaboration tab for the item edit sheet — share card + comment thread.
//
// The comment thread is real: it reads + writes /api/comments via React
// Query. The share-link card below is still a visual-only mock — there is
// no share-token / share-link endpoint in the server yet.
import { useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { I } from "./icons";
import { Button, relativeTime } from "./ui";
import { authorById } from "./items";
import { commentsApi, type ApiComment } from "./api";
import { useComments, useMe, queryKeys } from "./queries";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { Skeleton } from "@workeros/ui/components/skeleton";

const SHARE_URL = "https://workeros.dev/s/01HZ7K8Q6XYZ?token=sv1_a4e2b9c1f0";
const SHARE_URL_DISPLAY = "https://workeros.dev/s/01HZ7K8Q6XYZ?token=sv1_a4e…";

export function ItemCommentsPanel({
  collection,
  itemId,
  pushToast,
}: {
  collection: string;
  itemId: string;
  pushToast?: (m: string, type?: "success" | "error") => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [shareCopied, setShareCopied] = useState(false);

  const meQuery = useMe();
  const myUserId = meQuery.data?.data.id ?? null;
  const isAdmin = meQuery.data?.data.isAdmin ?? false;

  const commentsQuery = useComments(collection, itemId);
  const comments: ApiComment[] = commentsQuery.data?.data ?? [];
  // Server returns newest-first; render oldest-first so the thread reads
  // top-to-bottom like a conversation.
  const ordered = [...comments].reverse();

  const invalidate = () => {
    void qc.invalidateQueries({
      queryKey: queryKeys.comments(collection, itemId),
    });
  };

  const createMut = useMutation({
    mutationFn: (body: string) =>
      commentsApi.create({ collection, itemId, body }),
    onSuccess: () => {
      setDraft("");
      invalidate();
      pushToast?.("Comment posted.");
    },
    onError: () => pushToast?.("Could not post comment.", "error"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => commentsApi.remove(id),
    onSuccess: () => {
      invalidate();
      pushToast?.("Comment deleted.");
    },
    onError: () => pushToast?.("Could not delete comment.", "error"),
  });

  const send = () => {
    const text = draft.trim();
    if (!text || createMut.isPending) return;
    createMut.mutate(text);
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

  const myAuthor = authorById(myUserId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Share — visual-only mock: no share-token endpoint exists yet. */}
      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.Share size={13} />
          <span style={{ fontSize: 12.5, fontWeight: 500 }}>share this record</span>
        </div>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="field">
            <label className="field-label">Public read-only link</label>
            <div style={{ display: "flex", gap: 6 }}>
              <Input className="font-mono" readOnly value={SHARE_URL_DISPLAY} style={{ fontSize: 11.5, flex: 1 }} />
              <Button variant="outline" icon={shareCopied ? I.Check : I.Copy} onClick={copyShare}>
                {shareCopied ? "Copied" : "Copy"}
              </Button>
            </div>
            <span className="field-hint">
              Signed view token, expires in 7d · revocable from <span className="font-mono">api_keys</span>.
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span className="chip">
              <I.Eye size={11} /> read-only
            </span>
            <span className="chip">
              <I.Clock size={11} /> 7d expiry
            </span>
            <span className="chip">
              <I.Lock size={11} /> password off
            </span>
          </div>
        </div>
      </div>

      {/* Comments — real, backed by /api/comments. */}
      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.MessageSquare size={13} />
          <span style={{ fontSize: 12.5, fontWeight: 500 }}>comments</span>
          <span className="font-mono" style={{ fontSize: 11.5, color: "var(--muted-foreground)" }}>
            {comments.length}
          </span>
        </div>
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          {commentsQuery.isLoading ? (
            <>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </>
          ) : ordered.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--muted-foreground)", padding: "8px 0" }}>
              No comments yet — start the thread below.
            </div>
          ) : (
            ordered.map((c) => {
              const author = authorById(c.userId);
              const canDelete = isAdmin || (!!myUserId && c.userId === myUserId);
              return (
                <div key={c.id} className="comment">
                  <div className="avatar-xs">{author.initials}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 500 }}>{author.name}</span>
                      <span className="font-mono" style={{ fontSize: 10.5, color: "var(--muted-foreground)" }}>
                        {relativeTime(c.createdAt)}
                      </span>
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={I.Trash}
                          onClick={() => deleteMut.mutate(c.id)}
                          disabled={deleteMut.isPending}
                          style={{ marginLeft: "auto" }}
                        />
                      )}
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--foreground)", marginTop: 2 }}>{c.body}</div>
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div
          style={{
            padding: 12,
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 6,
            alignItems: "flex-start",
          }}
        >
          <div className="avatar-xs" style={{ marginTop: 4 }}>{myAuthor.initials}</div>
          <Textarea
            placeholder="Write a comment · ⌘+Enter to send"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKey}
            rows={2}
            style={{ minHeight: 60, fontSize: 12.5, flex: 1 }}
          />
          <Button
            variant="primary"
            size="sm"
            icon={I.Send}
            onClick={send}
            disabled={!draft.trim() || createMut.isPending}
          >
            {createMut.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
