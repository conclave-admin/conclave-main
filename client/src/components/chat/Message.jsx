import Avatar from '@/components/ui/Avatar';
import { usePresence } from '@/contexts/PresenceContext';
import { formatClockTime, messageSummary, readStatus } from '@/lib/messageMeta';
import IconFailed from '@/assets/icons/failed.svg?react';
import IconPending from '@/assets/icons/pending.svg?react';
import IconRead from '@/assets/icons/read.svg?react';
import IconSent from '@/assets/icons/sent.svg?react';
import { AttachmentGroup } from './AttachmentCard';
import MessageActions from './MessageActions';
import MessageReactions from './MessageReactions';
import PollCard from './PollCard';
import MessageSendState from './MessageSendState';
import { useRef, useState } from "react";
import useLongPress from "@/hooks/useLongPress";

const TICKS = {
  pending: { Icon: IconPending, label: 'Sending' },
  queued: { Icon: IconPending, label: 'Waiting for connection' },
  sent: { Icon: IconSent, label: 'Sent' },
  delivered: { Icon: IconRead, label: 'Delivered' },
  read: { Icon: IconRead, label: 'Read' },
  failed: { Icon: IconFailed, label: 'Failed to send' },
};

function Tick({ status }) {
  if (!status) return null;
  const { Icon, label } = TICKS[status];
  const queued = status === 'queued';
  return (
    <span
      data-message-status={status}
      title={queued ? 'Not sent. Waiting for an internet connection.' : label}
      aria-label={label}
      className={`inline-flex items-center gap-1 ${status === 'failed' ? 'text-error' : status === 'read' ? 'text-brand' : queued ? 'text-warning' : 'text-muted'}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only">{label}</span>
      {queued && <span className="text-[10px] font-medium leading-none">Not sent</span>}
    </span>
  );
}

/**
 * Highlight @tokens in a message body.
 *
 * Styling only — this deliberately does not resolve anybody. The API says
 * display names are not unique, so text cannot tell two members apart; the
 * authoritative list is `mentioned_user_ids`, which is recorded at send time.
 * Painting a token is safe because it changes no identity and notifies nobody.
 */
function renderContent(text) {
  if (!text) return null;
  return text.split(/(@[\w.]+)/).map((part, index) =>
    part.startsWith('@') ? (
      <span key={index} className="rounded bg-brand-soft px-0.5 font-medium text-brand">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/**
 * One message row.
 *
 * Own messages sit right in brand, others left on a soft surface, per section 6.
 * A run of messages from one author shares an avatar and a name — only the last
 * of the run carries the timestamp and the delivery tick, which is what makes a
 * conversation scannable rather than a stack of identical cards.
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
  replyTarget,
  albumTile = false,
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
  const mine = message.sender_id === viewerId;
  const [menuOpen, setMenuOpen] = useState(false);
  const bodyRef = useRef(null);
  const longPress = useLongPress(() => setMenuOpen(true), { disabled: message.is_deleted || message._optimistic });

  const status = mine
    ? readStatus(message, members, viewerId, deliveryIds?.pendingIds, deliveryIds?.failedIds, deliveryIds?.queuedIds)
    : null;

  const senderName = message.sender_name || 'Unknown member';
  const showAvatar = !albumTile && !mine && !message._consecutive;

const bubbleClass = [
  "px-3 py-2 text-body [overflow-wrap:anywhere]",
  albumTile ? "pr-9" : "",
  "rounded-2xl",
  mine ? "bg-brand text-surface" : "bg-canvas text-ink",
  message._endsGroup ? (mine ? "rounded-br-md" : "rounded-bl-md") : "",
  message.is_deleted ? "italic" : "",
  "[-webkit-touch-callout:none] [@media(hover:none)]:select-none",
]
  .filter(Boolean)
  .join(" ");

  return (
    <article
      className={`group relative flex items-start gap-2.5 ${mine ? "flex-row-reverse" : ""}`}
    >
      {showAvatar ? (
        <Avatar
          name={senderName}
          src={message.sender_avatar}
          size="md"
          presence={
            getPresence(roomId, message.sender_id) === 'unknown' ? null : isOnlineIn(roomId, message.sender_id) ? "online" : "offline"
          }
        />
      ) : (
        // Keeps a run of messages aligned under the first one's text rather
        // than sliding left into the avatar column.
        !albumTile && !mine && <span className="h-10 w-10 shrink-0" aria-hidden="true" />
      )}

      <div
        className={`flex min-w-0 ${albumTile ? "w-full max-w-full" : "max-w-[min(36rem,85%)]"} flex-col gap-1 ${
          mine ? "items-end" : "items-start"
        }`}
      >
        {!message._consecutive && !mine && (
          <span className="truncate text-label text-ink">{senderName}</span>
        )}

        {message.forwarded && !message.is_deleted && <p className="text-metadata italic text-muted">Forwarded</p>}
        {replyTarget && !message.is_deleted && (
          <button type="button" onClick={() => onJumpToMessage?.(replyTarget)} className="max-w-xs truncate rounded-md border-l-2 border-brand bg-canvas px-2 py-1 text-left text-metadata text-muted hover:bg-brand/10">
            Replying to {replyTarget.sender_name || "a message"}:{" "}
            {messageSummary(replyTarget)}
          </button>
        )}
        {message.reply_to_id && !replyTarget && !message.is_deleted && (
          <button type="button" onClick={() => onJumpToMessage?.({ id: message.reply_to_id })} className="rounded-md border-l-2 border-line bg-canvas px-2 py-1 text-metadata text-muted hover:bg-brand/10">
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
            className={`relative flex min-w-0 max-w-full ${albumTile ? "w-full flex-col-reverse" : "flex-col"} gap-1.5 ${
              mine ? "items-end" : "items-start"
            }`}
          >
            {message.content &&
              (message.poll ? (
                <PollCard
                  message={message}
                  viewerId={viewerId}
                  canClose={mine || isAdmin}
                />
              ) : (
                <div className={bubbleClass}>{renderContent(message.content)}</div>
              ))}

            {message.attachments?.length > 0 && (
              <AttachmentGroup attachments={message.attachments} albumTile={albumTile} />
            )}

            {/* Beside the body and out of the layout flow, so a row reserves no
                indent. Hover devices reveal it on hover; touch devices hide it
                and open the menu by long-press. */}
            {!message._optimistic && <div
              className={`absolute top-1 transition-opacity ${
                albumTile ? "right-1 z-10 rounded-md bg-surface/90" : mine ? "right-full pr-1" : "left-full pl-1"
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
                onToggleReaction={(emoji) => onToggleReaction(message, emoji)}
                onMessageInfo={mine && onMessageInfo ? () => onMessageInfo(message) : undefined}
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
            </div>}
          </div>
        )}

        {message.edited_at && !message.is_deleted && (
          <span className="text-metadata text-muted">edited</span>
        )}

        {message._outbox && <MessageSendState message={message} onRetry={deliveryIds.onRetry} onCancel={deliveryIds.onCancel} />}

        {/* Renders nothing until a reaction exists. The first one comes from the
            actions menu, so this row only appears once there is something to
            show or add to. */}
        {!message.is_deleted && !message._optimistic && (
          <MessageReactions
            message={message}
            onToggle={(emoji) => onToggleReaction(message, emoji)}
          />
        )}

        {(message._endsGroup || message._outbox) && (
          <div className="flex items-center gap-1.5">
            {status === "failed" && (
              <span className="text-metadata text-error">Failed to send</span>
            )}
            <time
              className="text-metadata text-muted"
              dateTime={message.created_at}
            >
              {formatClockTime(message.created_at)}
            </time>
            {mine && !message._optimistic && onMessageInfo
              ? <button type="button" aria-label="Message info" title="View delivery and read details" onClick={() => onMessageInfo(message)} className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"><Tick status={status} /></button>
              : <Tick status={status} />}
          </div>
        )}
      </div>

    </article>
  );
}
