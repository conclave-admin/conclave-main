import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import EmptyState from '../ui/EmptyState';
import Spinner from '../ui/Spinner';
import { annotateMessages, daySeparatorLabel } from '@/lib/messageMeta';
import Message from './Message';
import TypingIndicator from './TypingIndicator';

function DaySeparator({ label }) {
  return (
    <div className="my-4 flex items-center gap-3" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
      <span className="shrink-0 text-metadata text-muted">{label}</span>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
    </div>
  );
}

const NEAR_BOTTOM_PX = 80;

/**
 * The conversation timeline.
 *
 * Day separators, grouped runs, the typing row, load-older, and a "jump to
 * latest" pill. Each is derived from the message list rather than tracked as
 * separate UI state, so a reload, a socket edit and a paginated page all
 * produce the same rendering.
 *
 * Loading older messages prepends ABOVE the current scroll position and
 * preserves it by offset. Without that compensation the container's scroll
 * height grows upward, the browser keeps the same scrollTop, and the reader is
 * silently dropped thousands of pixels down the history they did not ask for —
 * the single most disorienting bug a paginated chat can have.
 *
 * @param {Array} messages - ascending by created_at, already merged
 * @param {{ current: HTMLElement }} scrollContainerRef
 */
export default function MessageTimeline({
  messages,
  scrollContainerRef,
  viewerId,
  members = [],
  isAdmin,
  roomId,
  deliveryIds,
  typingUserIds = [],
  hasMore,
  isLoadingOlder,
  onLoadOlder,
  onReply,
  onEdit,
  onDelete,
  onToggleReaction,
}) {
  const endRef = useRef(null);
  const topSentinelRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const annotated = useMemo(() => annotateMessages(messages), [messages]);
  const lastMessage = annotated[annotated.length - 1];

  // Reply targets are matched from what is already loaded. There is no
  // GET /messages/:id, so a reply to something scrolled out of the loaded
  // window degrades to "an earlier message" rather than fetching — which is
  // honest, and avoids one request per reply in a long room.
  const replyTargetFor = (message) =>
    message.reply_to_id
      ? annotated.find((candidate) => candidate.id === message.reply_to_id) || null
      : null;

  useEffect(() => {
    const container = scrollContainerRef?.current;
    if (!container) return undefined;

    const handleScroll = () => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const atBottom = distanceFromBottom <= NEAR_BOTTOM_PX;
      isAtBottomRef.current = atBottom;
      setShowJump(!atBottom);
    };

    handleScroll();
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [scrollContainerRef]);

  useEffect(() => {
    if (isAtBottomRef.current) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, lastMessage?.id]);

  // Load-older sentinel. Observing rather than reading scroll offsets on every
  // frame keeps the trigger in one place and means a short first page starts
  // fetching as soon as it is rendered, not only after the user scrolls.
  useEffect(() => {
    const node = topSentinelRef.current;
    const container = scrollContainerRef?.current;
    if (!node || !container || !hasMore || !onLoadOlder) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadOlder();
      },
      { root: container, rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, onLoadOlder, scrollContainerRef, messages.length]);

  const jumpToLatest = () => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  if (!messages.length) {
    return (
      <EmptyState
        title="Start the conversation"
        description="Messages sent to this room will appear here."
      />
    );
  }

  return (
    <div className="relative flex flex-1 flex-col px-4 pb-5 pt-4 md:px-7">
      {hasMore && (
        <div ref={topSentinelRef} className="py-2">
          {isLoadingOlder && <Spinner label="Loading earlier messages" />}
        </div>
      )}

      {annotated.map((message, index) => (
        <Fragment key={message.id}>
          {message._startsDay && (
            <DaySeparator label={daySeparatorLabel(message.created_at)} />
          )}
          {/* mt-auto on the first row keeps a short conversation pinned to the
              bottom of the pane, next to the composer, rather than stranded at
              the top with a void beneath it. */}
          <div className={index === 0 ? 'mt-auto' : message._consecutive ? 'mt-0.5' : 'mt-3'}>
            <Message
              message={message}
              viewerId={viewerId}
              members={members}
              isAdmin={isAdmin}
              roomId={roomId}
              replyTarget={replyTargetFor(message)}
              deliveryIds={deliveryIds}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
              onToggleReaction={onToggleReaction}
            />
          </div>
        </Fragment>
      ))}

      <div ref={endRef} />

      <TypingIndicator typingUserIds={typingUserIds} members={members} />

      {showJump && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="pointer-events-auto absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line bg-surface px-4 py-2 text-label text-ink shadow-modal transition-colors hover:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
