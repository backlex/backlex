// Collaboration tab for the item edit sheet — share card + comment thread.
//
// Both halves are real: the comment thread reads/writes /api/comments and
// the share card mints/revokes public read-only links via /api/shared-links.
import { useState, type KeyboardEvent } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { I } from "./icons";
import { Button, relativeTime } from "./ui";
import { authorById } from "./items";
import { commentsApi, sharedLinksApi, type ApiComment } from "./api";
import {
  useComments,
  useMe,
  useSharedLinks,
  queryKeys,
} from "./queries";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { Skeleton } from "@workeros/ui/components/skeleton";

const CARD_CLS =
  "overflow-hidden rounded-2xl border border-border bg-card text-card-foreground";
const CARD_SECTION_CLS = "flex items-center gap-2 border-b border-border px-4 py-3.5";
const FIELD_CLS = "flex flex-col gap-1.5";
const FIELD_LABEL_CLS = "flex items-center gap-2 text-[12.5px] font-medium text-foreground";
const FIELD_HINT_CLS = "text-[11.5px] text-muted-foreground";
const CHIP_CLS =
  "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-3xl border border-border bg-card px-[11px] text-[12.5px] text-foreground";
const AVATAR_XS_CLS =
  "grid size-[18px] place-items-center rounded-full border border-border bg-muted font-mono text-[9.5px] text-muted-foreground";

/**
 * Public read-only share-link card. A signed-in user mints a `/s/<token>`
 * link to this record; the plaintext token is only returned at creation, so
 * for a link that already existed before this sheet opened we can only show
 * that one is active (with Revoke + Create-new actions), not the URL itself.
 */
function ShareLinkCard({
  collection,
  itemId,
  pushToast,
}: {
  collection: string;
  itemId: string;
  pushToast?: (m: string, type?: "success" | "error") => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const linksQuery = useSharedLinks(collection, itemId);
  const activeLink = linksQuery.data?.data[0] ?? null;

  const invalidate = () => {
    void qc.invalidateQueries({
      queryKey: queryKeys.sharedLinks(collection, itemId),
    });
  };

  const createMut = useMutation({
    mutationFn: () => sharedLinksApi.create({ collection, itemId }),
    onSuccess: (res) => {
      setFreshUrl(`${window.location.origin}${res.data.url}`);
      invalidate();
      pushToast?.(t`Share link created.`);
    },
    onError: () => pushToast?.(t`Could not create share link.`, "error"),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => sharedLinksApi.revoke(id),
    onSuccess: () => {
      setFreshUrl(null);
      invalidate();
      pushToast?.(t`Share link revoked.`);
    },
    onError: () => pushToast?.(t`Could not revoke share link.`, "error"),
  });

  const copy = (url: string) => {
    try {
      void navigator.clipboard.writeText(url);
      setCopied(true);
      pushToast?.(t`Share link copied.`);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      pushToast?.(t`Could not copy link.`, "error");
    }
  };

  return (
    <div className={CARD_CLS}>
      <div className={CARD_SECTION_CLS}>
        <I.Share size={13} />
        <span className="text-[12.5px] font-medium"><Trans>share this record</Trans></span>
      </div>
      <div className="flex flex-col gap-2.5 p-3.5">
        {linksQuery.isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : freshUrl ? (
          // Just-minted link — the only moment we can show the full URL.
          <div className={FIELD_CLS}>
            <label className={FIELD_LABEL_CLS}><Trans>Public read-only link</Trans></label>
            <div className="flex gap-1.5">
              <Input
                className="flex-1 font-mono text-[11.5px]"
                readOnly
                value={freshUrl}
              />
              <Button
                variant="outline"
                icon={copied ? I.Check : I.Copy}
                onClick={() => copy(freshUrl)}
              >
                {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
              </Button>
            </div>
            <span className={FIELD_HINT_CLS}>
              <Trans>Anyone with this link can view the record — copy it now, the
              token is shown only once.</Trans>
            </span>
          </div>
        ) : activeLink ? (
          // A link already exists but its token is no longer recoverable.
          <div className={FIELD_CLS}>
            <label className={FIELD_LABEL_CLS}><Trans>Public read-only link</Trans></label>
            <div className="text-xs text-muted-foreground">
              <Trans>An active share link exists for this record. For security the
              link URL is shown only once, at creation. Revoke it and create a
              new one if you need a fresh copyable URL.</Trans>
            </div>
            <div className="mt-1 flex gap-1.5">
              <Button
                variant="outline"
                icon={I.Trash}
                onClick={() => revokeMut.mutate(activeLink.id)}
                disabled={revokeMut.isPending}
              >
                {revokeMut.isPending ? <Trans>Revoking…</Trans> : <Trans>Revoke</Trans>}
              </Button>
              <Button
                variant="outline"
                icon={I.Plus}
                onClick={() => createMut.mutate()}
                disabled={createMut.isPending || revokeMut.isPending}
              >
                <Trans>Create new link</Trans>
              </Button>
            </div>
          </div>
        ) : (
          // No link yet — offer to mint one.
          <div className={FIELD_CLS}>
            <label className={FIELD_LABEL_CLS}><Trans>Public read-only link</Trans></label>
            <div className="mb-0.5 text-xs text-muted-foreground">
              <Trans>Mint a public link that shows this record read-only — no sign-in
              required to view it.</Trans>
            </div>
            <Button
              variant="primary"
              icon={I.Share}
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending}
            >
              {createMut.isPending ? <Trans>Creating…</Trans> : <Trans>Create share link</Trans>}
            </Button>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          <span className={CHIP_CLS}>
            <I.Eye size={11} /> <Trans>read-only</Trans>
          </span>
          <span className={CHIP_CLS}>
            <I.Trash size={11} /> <Trans>revocable anytime</Trans>
          </span>
        </div>
      </div>
    </div>
  );
}

export function ItemCommentsPanel({
  collection,
  itemId,
  pushToast,
}: {
  collection: string;
  itemId: string;
  pushToast?: (m: string, type?: "success" | "error") => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");

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
      pushToast?.(t`Comment posted.`);
    },
    onError: () => pushToast?.(t`Could not post comment.`, "error"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => commentsApi.remove(id),
    onSuccess: () => {
      invalidate();
      pushToast?.(t`Comment deleted.`);
    },
    onError: () => pushToast?.(t`Could not delete comment.`, "error"),
  });

  const send = () => {
    const text = draft.trim();
    if (!text || createMut.isPending) return;
    createMut.mutate(text);
  };

  const onDraftKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  };

  const myAuthor = authorById(myUserId);

  return (
    <div className="flex flex-col gap-3.5">
      {/* Share — real, backed by /api/shared-links. */}
      <ShareLinkCard
        collection={collection}
        itemId={itemId}
        pushToast={pushToast}
      />

      {/* Comments — real, backed by /api/comments. */}
      <div className={CARD_CLS}>
        <div className={CARD_SECTION_CLS}>
          <I.MessageSquare size={13} />
          <span className="text-[12.5px] font-medium"><Trans>comments</Trans></span>
          <span className="font-mono text-[11.5px] text-muted-foreground">
            {comments.length}
          </span>
        </div>
        <div className="flex flex-col gap-2.5 px-3.5 py-3">
          {commentsQuery.isLoading ? (
            <>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </>
          ) : ordered.length === 0 ? (
            <div className="py-2 text-[12.5px] text-muted-foreground">
              <Trans>No comments yet — start the thread below.</Trans>
            </div>
          ) : (
            ordered.map((c) => {
              const author = authorById(c.userId);
              const canDelete = isAdmin || (!!myUserId && c.userId === myUserId);
              return (
                <div key={c.id} className="flex items-start gap-2 border-b border-dashed border-border py-2 last:border-b-0">
                  <div className={AVATAR_XS_CLS}>{author.initials}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[12.5px] font-medium">{author.name}</span>
                      <span className="font-mono text-[10.5px] text-muted-foreground">
                        {relativeTime(c.createdAt)}
                      </span>
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={I.Trash}
                          onClick={() => deleteMut.mutate(c.id)}
                          disabled={deleteMut.isPending}
                          className="ml-auto"
                        />
                      )}
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-foreground">{c.body}</div>
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div className="flex items-start gap-1.5 border-t border-border p-3">
          <div className={`mt-1 ${AVATAR_XS_CLS}`}>{myAuthor.initials}</div>
          <Textarea
            placeholder={t`Write a comment · ⌘+Enter to send`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKey}
            rows={2}
            className="min-h-[60px] flex-1 text-[12.5px]"
          />
          <Button
            variant="primary"
            size="sm"
            icon={I.Send}
            onClick={send}
            disabled={!draft.trim() || createMut.isPending}
          >
            {createMut.isPending ? <Trans>Sending…</Trans> : <Trans>Send</Trans>}
          </Button>
        </div>
      </div>
    </div>
  );
}
