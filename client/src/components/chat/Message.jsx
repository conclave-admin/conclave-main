import { useMediaViewer } from "./MediaViewer";
import { ReminderAction } from "./MessageLater";
import MessageBody from "./MessageBody";
import Avatar from "@/components/ui/Avatar";
import { usePresence } from "@/contexts/PresenceContext";
import { formatClockTime, messageSummary, readStatus } from "@/lib/messageMeta";
import MessageStatus from "./MessageStatus";
import { AttachmentGroup } from "./AttachmentCard";
import MessageActions from "./MessageActions";
import MessageReactions from "./MessageReactions";
import LinkPreviewCard from "./LinkPreviewCard";
import PollCard from "./PollCard";
import MessageSendState from "./MessageSendState";
import { useRef, useState } from "react";
import useLongPress from "@/hooks/useLongPress";

/**
 * One message row.
 *
 * Own messages sit right on a soft brand surface; others sit left. Consecutive
 * messages share an avatar and name while each bubble retains its own time and
 * receipt state, so individual messages remain identifiable within a run.
 *
 * @param {object} message - from annotateMessages, so _consecutive/_endsGroup exist
 * @param {string} viewerId
 * @param {Array} members - room members, for presence and read pointers
 * @param {boolean} isAdmin
 * @param {string} roomId
 * @param {object|null} replyTarget - the replied-to message, when it is loaded
 * @param {{ pendingIds: Set, failedIds: Set }} deliveryIds
 * @param {{ onReply: Function, onEdit: Function, onDelete: Function, onPromote: Function, onFlagTask: Function, onToggleReaction: Function, onPin: Function, onUnpin: Function }} handlers
 */
export default function Message({
  message,
  viewerId,
  members = [],
  isAdmin,
  roomId,
  readOnly = false,
  replyTarget,
  albumTile = false,
  overflowCount = 0,
  deliveryIds,
  onMessageInfo,
  onReply,
  onEdit,
  onDelete,
  onPromote,
  onFlagTask,
  onPin,
  onUnpin,
  onToggleReaction,
  onOpenThread,
  onForward,
  onJumpToMessage,
}) {
  const { isOnlineIn, getPresence } = usePresence();
  const mediaViewer = useMediaViewer();
  const mine = message.sender_id === viewerId;
  const [menuOpen, setMenuOpen] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  const bodyRef = useRef(null);
  const longPress = useLongPress(() => setMenuOpen(true), {
    disabled: readOnly || message.is_deleted || message._optimistic,
  });

  const status = mine
    ? readStatus(
        message,
        members,
        viewerId,
        deliveryIds?.pendingIds,
        deliveryIds?.failedIds,
        deliveryIds?.queuedIds,
      )
    : null;

  const senderName = message.sender_name || "Unknown member";
  const showAvatar = !albumTile && !mine && !message._consecutive;

  const bubbleClass = [
    "message-bubble min-w-0 max-w-full px-3 py-2 text-body [overflow-wrap:anywhere]",
    albumTile ? "pr-9" : "",
    "rounded-xl",
    mine ? "message-bubble-out" : "message-bubble-in text-ink",
    message._endsGroup ? (mine ? "rounded-br-md" : "rounded-bl-md") : "",
    message.is_deleted ? "italic" : "",
    "[-webkit-touch-callout:none] [@media(hover:none)]:select-none",
  ]
    .filter(Boolean)
    .join(" ");

  const metadata = (
    <div
      className={`message-meta mt-1 flex items-center justify-end gap-1 whitespace-nowrap text-[11px] leading-4 text-muted ${albumTile ? "order-3" : ""}`}
    >
      {status === "failed" && (
        <span className="text-metadata text-error">Failed to send</span>
      )}
      {message.edited_at && !message.is_deleted && <span>edited</span>}
      <time className="tabular-nums" dateTime={message.created_at}>
        {formatClockTime(message.created_at)}
      </time>
      {mine && !message._optimistic && onMessageInfo ? (
        <button
          type="button"
          aria-label="Message info"
          title="View delivery and read details"
          onClick={() => onMessageInfo(message)}
          className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <MessageStatus status={status} />
        </button>
      ) : (
        <MessageStatus status={status} />
      )}
    </div>
  );

  return (
    <article
      className={`group relative flex w-full min-w-0 max-w-full items-start gap-2.5 ${mine ? "flex-row-reverse" : ""}`}
    >
      {showAvatar ? (
        <Avatar
          name={senderName}
          src={message.sender_avatar}
          size="sm"
          presence={
            getPresence(roomId, message.sender_id) === "unknown"
              ? null
              : isOnlineIn(roomId, message.sender_id)
                ? "online"
                : "offline"
          }
        />
      ) : (
        // Keeps a run of messages aligned under the first one's text rather
        // than sliding left into the avatar column.
        !albumTile &&
        !mine && <span className="h-9 w-9 shrink-0" aria-hidden="true" />
      )}

      <div
        className={`flex min-w-0 ${albumTile ? "w-full max-w-full" : "message-column"} flex-col gap-1 ${
          mine ? "items-end" : "items-start"
        }`}
      >
        {!albumTile && !message._consecutive && !mine && (
          <span className="truncate text-label font-semibold text-brand">
            {senderName}
          </span>
        )}

        {!readOnly && !message._optimistic && !message.is_deleted && (
          <ReminderAction
            messageId={message.id}
            externalOpen={reminderOpen}
            hideTrigger
            onClose={() => setReminderOpen(false)}
          />
        )}
        {message.thread_count > 0 && !message.is_deleted && (
          <button
            type="button"
            className="min-h-9 text-label text-brand"
            onClick={() => onOpenThread?.(message)}
          >
            {message.thread_count}{" "}
            {message.thread_count === 1 ? "reply" : "replies"}
            {message.thread_unread ? ` · ${message.thread_unread} unread` : ""}
          </button>
        )}
        {message.forwarded && !message.is_deleted && (
          <p className="text-metadata italic text-muted">Forwarded</p>
        )}
        {replyTarget && !message.is_deleted && (
          <button
            type="button"
            onClick={() => onJumpToMessage?.(replyTarget)}
            className="max-w-xs truncate rounded-md border-l-2 border-brand bg-canvas px-2 py-1 text-left text-metadata text-muted hover:bg-brand/10"
          >
            Replying to {replyTarget.sender_name || "a message"}:{" "}
            {messageSummary(replyTarget)}
          </button>
        )}
        {message.reply_to_id && !replyTarget && !message.is_deleted && (
          <button
            type="button"
            onClick={() => onJumpToMessage?.({ id: message.reply_to_id })}
            className="rounded-md border-l-2 border-line bg-canvas px-2 py-1 text-metadata text-muted hover:bg-brand/10"
          >
            Replied to an earlier message
          </button>
        )}

        {message.is_deleted ? (
          <div className={`${bubbleClass} text-muted`}>Message deleted</div>
        ) : (
          // One body for everything that is the message itself: the bubble or
          // poll, and its attachments. Long-press and the hover button both
          // attach here, so a message that is only a photo has a menu too.
          <div
            ref={bodyRef}
            {...longPress}
            className={`relative flex min-w-0 max-w-full ${albumTile ? "w-full flex-col" : "flex-col"} gap-1.5 ${
              mine ? "items-end" : "items-start"
            } ${message.attachments?.length ? "message-attachment-body rounded-xl border border-line/50 bg-surface p-1.5" : ""}`}
          >
            {message.content &&
              (message.poll ? (
                <PollCard
                  message={message}
                  viewerId={viewerId}
                  canClose={mine || isAdmin}
                />
              ) : (
                <div className={`${bubbleClass} ${albumTile ? "order-2" : ""}`}>
                  <MessageBody
                    text={message.content}
                    members={members}
                    mentionedIds={
                      message.mentioned_user_ids ||
                      message.mentionedUserIds ||
                      []
                    }
                    forceExpanded={Boolean(message._searchMatch)}
                    query={message._searchQuery || ""}
                  />
                  <LinkPreviewCard text={message.content} compact />
                  {!message.attachments?.length && metadata}
                </div>
              ))}

            {message.attachments?.length > 0 && (
              <AttachmentGroup
                attachments={message.attachments}
                albumTile={albumTile}
              />
            )}

            {message.attachments?.length > 0 && metadata}
            {message._outbox &&
              message.attachments?.some((file) =>
                /^(image|video)\//.test(file.mime_type || ""),
              ) && (
                <MessageSendState
                  message={message}
                  onRetry={deliveryIds.onRetry}
                  onCancel={deliveryIds.onCancel}
                  compact
                />
              )}
            {overflowCount > 0 && (
              <button
                type="button"
                className="album-overflow absolute inset-0 z-[2] flex items-center justify-center rounded-lg bg-black/45 text-3xl font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                aria-label={`View ${overflowCount} more photos and videos`}
                onClick={() =>
                  mediaViewer?.open(
                    message.attachments.find((file) =>
                      /^(image|video)\//.test(file.mime_type || ""),
                    ),
                  )
                }
              >
                +{overflowCount}
              </button>
            )}

            {/* Beside the body and out of the layout flow, so a row reserves no
                indent. Hover devices reveal it on hover; touch devices hide it
                and open the menu by long-press. */}
            {!readOnly && !message._optimistic && (
              <div
                className={`absolute top-1 transition-opacity ${
                  albumTile
                    ? "right-1 z-10 rounded-md bg-surface/90"
                    : mine
                      ? "right-full pr-1"
                      : "left-full pl-1"
                } ${
                  menuOpen ? "opacity-100" : "opacity-0"
                } [@media(hover:none)]:hidden [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-within:opacity-100`}
              >
                <MessageActions
                  message={message}
                  viewerId={viewerId}
                  isAdmin={isAdmin}
                  open={menuOpen}
                  onOpenChange={setMenuOpen}
                  anchorRef={bodyRef}
                  align={mine ? "end" : "start"}
                  onRemind={() => {
                    setMenuOpen(false);
                    setReminderOpen(true);
                  }}
                  onToggleReaction={(emoji) => onToggleReaction(message, emoji)}
                  onMessageInfo={
                    mine && onMessageInfo
                      ? () => onMessageInfo(message)
                      : undefined
                  }
                  onReply={() => onReply(message)}
                  onOpenThread={() => onOpenThread(message)}
                  onForward={onForward ? () => onForward(message) : undefined}
                  onEdit={() => onEdit(message)}
                  onDelete={() => onDelete(message)}
                  onPromote={() => onPromote(message)}
                  onFlagTask={() => onFlagTask(message)}
                  onPin={onPin}
                  onUnpin={onUnpin}
                />
              </div>
            )}
          </div>
        )}

        {message._outbox &&
          !message.attachments?.some((file) =>
            /^(image|video)\//.test(file.mime_type || ""),
          ) && (
            <MessageSendState
              message={message}
              onRetry={deliveryIds.onRetry}
              onCancel={deliveryIds.onCancel}
            />
          )}

        {/* Renders nothing until a reaction exists. The first one comes from the
            actions menu, so this row only appears once there is something to
            show or add to. */}
        {!message.is_deleted && !message._optimistic && !readOnly && (
          <MessageReactions
            message={message}
            onToggle={(emoji) => onToggleReaction(message, emoji)}
          />
        )}

        {(!message.attachments?.length || message.is_deleted) &&
          (!message.content || message.poll || message.is_deleted) &&
          metadata}
      </div>
    </article>
  );
}
