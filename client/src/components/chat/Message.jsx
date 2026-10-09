import Avatar from '@/components/ui/Avatar';
import { usePresence } from '@/contexts/PresenceContext';
import { formatClockTime, readStatus } from '@/lib/messageMeta';
import IconFailed from '@/assets/icons/failed.svg?react';
import IconPending from '@/assets/icons/pending.svg?react';
import IconRead from '@/assets/icons/read.svg?react';
import IconSent from '@/assets/icons/sent.svg?react';
import AttachmentCard from './AttachmentCard';
import MessageActions from './MessageActions';
import MessageReactions from './MessageReactions';

const TICKS = {
  pending: { Icon: IconPending, label: 'Sending' },
  sent: { Icon: IconSent, label: 'Sent' },
  read: { Icon: IconRead, label: 'Read' },
  failed: { Icon: IconFailed, label: 'Failed to send' },
};

function Tick({ status }) {
  if (!status) return null;
  const { Icon, label } = TICKS[status];
  return (
    <span
      className={status === 'failed' ? 'text-error' : status === 'read' ? 'text-brand' : 'text-muted'}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only">{label}</span>
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
 * @param {{ onReply: Function, onEdit: Function, onDelete: Function, onPromote: Function, onFlagTask: Function, onToggleReaction: Function }} handlers
 */
export default function Message({
  message,
  viewerId,
  members = [],
  isAdmin,
  roomId,
  replyTarget,
  deliveryIds,
  onReply,
  onEdit,
  onDelete,
  onPromote,
  onFlagTask,
  onToggleReaction,
}) {
  const { isOnlineIn } = usePresence();
  const mine = message.sender_id === viewerId;

  const status = mine
    ? readStatus(message, members, viewerId, deliveryIds?.pendingIds, deliveryIds?.failedIds)
    : null;

  const senderName = message.sender_name || 'Unknown member';
  const showAvatar = !mine && !message._consecutive;

  const bubbleClass = [
    'max-w-[min(36rem,85%)] px-3 py-2 text-body [overflow-wrap:anywhere]',
    'rounded-2xl',
    mine ? 'bg-brand text-surface' : 'bg-canvas text-ink',
    // The tail: the corner nearest the avatar tightens on the last message of
    // a run, so a group reads as one shape rather than a stack of pills.
    message._endsGroup ? (mine ? 'rounded-br-md' : 'rounded-bl-md') : '',
    message.is_deleted ? 'italic' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={`group flex items-start gap-2.5 ${mine ? 'flex-row-reverse' : ''}`}>
      {showAvatar ? (
        <Avatar
          name={senderName}
          src={message.sender_avatar}
          size="md"
          presence={isOnlineIn(roomId, message.sender_id) ? 'online' : 'offline'}
        />
      ) : (
        // Keeps a run of messages aligned under the first one's text rather
        // than sliding left into the avatar column.
        !mine && <span className="h-10 w-10 shrink-0" aria-hidden="true" />
      )}

      <div className={`flex min-w-0 flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}>
        {!message._consecutive && (
          <div className={`flex items-baseline gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
            <span className="truncate text-label text-ink">
              {mine ? 'You' : senderName}
            </span>
            <time className="text-metadata text-muted" dateTime={message.created_at}>
              {formatClockTime(message.created_at)}
            </time>
          </div>
        )}

        {replyTarget && !message.is_deleted && (
          <div className="max-w-xs truncate rounded-md border-l-2 border-brand bg-canvas px-2 py-1 text-metadata text-muted">
            Replying to {replyTarget.sender_name || 'a message'}:{' '}
            {replyTarget.content || (replyTarget.is_deleted ? 'deleted message' : 'attachment')}
          </div>
        )}
        {message.reply_to_id && !replyTarget && !message.is_deleted && (
          <div className="rounded-md border-l-2 border-line bg-canvas px-2 py-1 text-metadata text-muted">
            Replied to an earlier message
          </div>
        )}

        {message.is_deleted ? (
          <div className={`${bubbleClass} text-muted`}>Message deleted</div>
        ) : (
          message.content && <div className={bubbleClass}>{renderContent(message.content)}</div>
        )}

        {message.attachments?.length > 0 && !message.is_deleted && (
          <div className="flex max-w-[min(36rem,85%)] flex-col gap-1.5">
            {message.attachments.map((attachment) => (
              <AttachmentCard key={attachment.id || attachment.url} attachment={attachment} />
            ))}
          </div>
        )}

        {message.edited_at && !message.is_deleted && (
          <span className="text-metadata text-muted">edited</span>
        )}

        {/* Always rendered, not only when reactions exist: the picker lives
            inside it, so a conditional here would mean a message with no
            reactions yet could never receive its first one. */}
        {!message.is_deleted && (
          <MessageReactions
            message={message}
            onToggle={(emoji) => onToggleReaction(message, emoji)}
          />
        )}

        {message._endsGroup && (
          <div className="flex items-center gap-1.5">
            {status === 'failed' && (
              <span className="text-metadata text-error">Failed to send</span>
            )}
            <Tick status={status} />
          </div>
        )}
      </div>

      <div className="opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
        <MessageActions
          message={message}
          viewerId={viewerId}
          isAdmin={isAdmin}
          onReply={() => onReply(message)}
          onEdit={() => onEdit(message)}
          onDelete={() => onDelete(message)}
          onPromote={() => onPromote(message)}
          onFlagTask={() => onFlagTask(message)}
        />
      </div>
    </article>
  );
}
