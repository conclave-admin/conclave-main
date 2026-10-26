import { readPosition, savePosition } from "../../lib/readingPosition";
import { observeMessageReads } from "../../lib/messageReads";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import IconArrowDown from "@/assets/icons/arrow-down.svg?react";
import EmptyState from "../ui/EmptyState";
import Spinner from "../ui/Spinner";
import { annotateMessages, daySeparatorLabel } from "@/lib/messageMeta";
import { groupMediaAlbums, viewerItems } from "../../lib/mediaAlbums";
import { MediaViewerProvider } from "./MediaViewer";
import Message from "./Message";
import TypingIndicator from "./TypingIndicator";

function DaySeparator({ label }) {
  return (
    <div
      className="my-4 flex items-center gap-3"
      role="separator"
      aria-label={label}
    >
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
      <span className="shrink-0 text-metadata text-muted">{label}</span>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
    </div>
  );
}

const NEAR_BOTTOM_PX = 120;
const WINDOW_THRESHOLD = 80;
const OVERSCAN_PX = 900;

function groupKey(group) {
  return group.messages[0].client_id || group.messages[0].id;
}

function estimatedHeight(group) {
  const text = group.messages.reduce(
    (length, message) => length + (message.content?.length || 0),
    0,
  );
  return Math.max(76, 68 * group.messages.length + Math.ceil(text / 42) * 20);
}

function indexAt(offsets, position) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (offsets[middle + 1] <= position) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, offsets.length - 2);
}

function rangeAt(offsets, top, viewportHeight) {
  return {
    start: indexAt(offsets, Math.max(0, top - OVERSCAN_PX)),
    end: Math.min(
      offsets.length - 1,
      indexAt(offsets, top + viewportHeight + OVERSCAN_PX) + 1,
    ),
  };
}

function MeasuredGroup({ children, groupIndex, onMeasure, ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = () =>
      onMeasure(groupIndex, node.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [groupIndex, onMeasure]);
  return (
    <div ref={ref} {...props}>
      {children}
    </div>
  );
}

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
  initialPosition,
  messages,
  scrollContainerRef,
  viewerId,
  members = [],
  isAdmin,
  roomId,
  deliveryIds,
  typingUserIds = [],
  recordingUserIds = [],
  hasMore,
  isLoadingOlder,
  onLoadOlder,
  onReply,
  onEdit,
  onDelete,
  onPromote,
  onFlagTask,
  onPin,
  onUnpin,
  onToggleReaction,
  lastSeenSequence = 0,
  onMessageInfo,
  onMessageVisible,
  readsEnabled = true,
  onOpenThread,
  onForward,
  onJumpToMessage,
  jumpTargetId,
  onJumpLocated,
  highlightedId,
  disableWindowing = false,
}) {
  const contentRef = useRef(null);
  const topSentinelRef = useRef(null);
  const stickRef = useRef(true); // are we following the bottom?
  const placedRoomRef = useRef(null); // which room has had its first scroll
  const lastSeenRef = useRef({ firstId: null, lastId: null });
  const heightBeforeOlderRef = useRef(0);
  const pendingBottomRef = useRef(false);
  const heightCacheRef = useRef(new Map());
  const heightRoomRef = useRef(roomId);
  if (heightRoomRef.current !== roomId) {
    heightRoomRef.current = roomId;
    heightCacheRef.current = new Map();
  }
  const [heightRevision, setHeightRevision] = useState(0);
  const [windowRange, setWindowRange] = useState(null);
  const locatedJumpRef = useRef(null);
  const [showJump, setShowJump] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const visibleIds = useMemo(() => new Set(), [roomId]);
  const pendingReads = useMemo(() => new Set(), [roomId]);

  const hasMessages = messages.length > 0;
  const annotated = useMemo(() => annotateMessages(messages), [messages]);
  const messagesById = useMemo(
    () => new Map(annotated.map((message) => [message.id, message])),
    [annotated],
  );
  const firstUnreadId = useMemo(() => {
    const unread = annotated.find(
      (message) =>
        Number(message.room_sequence || 0) > Number(lastSeenSequence) &&
        message.sender_id !== viewerId,
    );
    return unread?.id || null;
  }, [annotated, lastSeenSequence, viewerId]);
  const unreadCount = useMemo(
    () =>
      annotated.filter(
        (message) =>
          Number(message.room_sequence || 0) > Number(lastSeenSequence) &&
          message.sender_id !== viewerId,
      ).length,
    [annotated, lastSeenSequence, viewerId],
  );

  const groups = useMemo(
    () => groupMediaAlbums(annotated, firstUnreadId),
    [annotated, firstUnreadId],
  );
  const mediaItems = useMemo(() => viewerItems(annotated), [annotated]);
  const virtualized = groups.length > WINDOW_THRESHOLD && !disableWindowing;
  const offsets = useMemo(() => {
    const next = [0];
    for (const group of groups)
      next.push(
        next.at(-1) +
          (heightCacheRef.current.get(groupKey(group)) ||
            estimatedHeight(group)),
      );
    return next;
  }, [groups, heightRevision]);
  const groupForMessage = useMemo(() => {
    const index = new Map();
    groups.forEach((group, groupIndex) =>
      group.messages.forEach((message) => index.set(message.id, groupIndex)),
    );
    return index;
  }, [groups]);
  const initialGroup =
    (initialPosition?.id && groupForMessage.get(initialPosition.id)) ??
    (firstUnreadId && groupForMessage.get(firstUnreadId)) ??
    Math.max(0, groups.length - 1);
  const initialRange = virtualized
    ? {
        start: Math.max(0, initialGroup - 12),
        end: Math.min(groups.length, initialGroup + 18),
      }
    : { start: 0, end: groups.length };
  const range =
    virtualized && windowRange?.roomId === roomId
      ? {
          start: Math.min(windowRange.start, groups.length - 1),
          end: Math.min(
            groups.length,
            Math.max(windowRange.end, windowRange.start + 1),
          ),
        }
      : initialRange;

  const syncRange = useCallback(() => {
    if (pendingBottomRef.current) return;
    const container = scrollContainerRef?.current;
    if (!container || !virtualized) return;
    const next = rangeAt(offsets, container.scrollTop, container.clientHeight);
    setWindowRange((current) =>
      current?.roomId === roomId &&
      current.start === next.start && current.end === next.end
        ? current
        : { ...next, roomId },
    );
  }, [scrollContainerRef, virtualized, offsets, roomId]);

  const onMeasure = useCallback((index, height) => {
    const key = groupKey(groups[index]);
    const previous =
      heightCacheRef.current.get(key) || estimatedHeight(groups[index]);
    if (Math.abs(previous - height) < 1) return;
    heightCacheRef.current.set(key, height);
    const container = scrollContainerRef?.current;
    if (
      container &&
      !stickRef.current &&
      offsets[index + 1] <= container.scrollTop
    )
      container.scrollTop += height - previous;
    setHeightRevision((value) => value + 1);
  }, [groups, offsets, scrollContainerRef]);

  // A Map lookup instead of a scan per row.
  const replyTargetFor = (message) =>
    message.reply_to_id ? messagesById.get(message.reply_to_id) || null : null;

  // Instant on purpose. A smooth scroll fires scroll events on the way down,
  // and those events are what decide whether we are "at the bottom".
  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef?.current;
    if (container) {
      if (virtualized) {
        pendingBottomRef.current = true;
        setWindowRange({
          start: Math.max(0, groups.length - 35),
          end: groups.length,
          roomId,
        });
      } else container.scrollTop = container.scrollHeight;
    }
    stickRef.current = true;
    setShowJump(false);
    setNewBelow(0);
  }, [scrollContainerRef, virtualized, groups.length, roomId]);

  useLayoutEffect(() => {
    if (!pendingBottomRef.current || range.end !== groups.length) return;
    const container = scrollContainerRef?.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    pendingBottomRef.current = false;
    syncRange();
  }, [range.start, range.end, groups.length, scrollContainerRef, syncRange]);

  useEffect(() => {
    const container = scrollContainerRef?.current;
    if (!container) return undefined;

    const handleScroll = () => {
      syncRange();
      const distance =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const atBottom = distance <= NEAR_BOTTOM_PX;
      stickRef.current = atBottom;
      setShowJump(!atBottom);
      const viewport = container.getBoundingClientRect();
      const visible = [...container.querySelectorAll("[data-message-id]")].find(
        (el) => {
          const box = el.getBoundingClientRect();
          return box.bottom > viewport.top && box.top < viewport.bottom;
        },
      );
      if (visible && placedRoomRef.current === roomId)
        savePosition(viewerId, roomId, {
          id: visible.dataset.messageId,
          offset: visible.getBoundingClientRect().top - viewport.top,
          atBottom,
        });
      if (atBottom) setNewBelow(0);
    };

    handleScroll();
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [scrollContainerRef, viewerId, roomId, syncRange]);

  // Runs before paint, so the reader never sees the top of the room flash by.
  useLayoutEffect(() => {
    const container = scrollContainerRef?.current;
    if (!container || annotated.length === 0) return;

    const first = annotated[0];
    const last = annotated[annotated.length - 1];
    // An acknowledgement replaces the temporary id without adding a new item.
    // Preserve scroll position and open actions for that same logical message.
    const lastId = last.client_id || last.id;
    const seen = lastSeenRef.current;

    if (placedRoomRef.current !== roomId) {
      // 1. First paint opens at the unread boundary when one exists.
      placedRoomRef.current = roomId;
      const savedId =
        initialPosition && !initialPosition.atBottom && initialPosition.id;
      const savedTarget =
        savedId &&
        container.querySelector(`[data-message-id="${CSS.escape(savedId)}"]`);
      const target =
        savedTarget ||
        (firstUnreadId &&
          container.querySelector(`[data-message-id="${firstUnreadId}"]`));
      if (target) {
        container.scrollTop +=
          target.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          (savedTarget ? initialPosition.offset : 0);
        stickRef.current = false;
      } else {
        container.scrollTop = container.scrollHeight;
        stickRef.current = true;
      }
      if (virtualized && !target && (savedId || firstUnreadId)) {
        const index = groupForMessage.get(savedId || firstUnreadId);
        if (index != null) {
          container.scrollTop =
            offsets[index] - (savedId ? initialPosition.offset || 0 : 0);
          stickRef.current = false;
        }
      }
      syncRange();
    } else if (
      seen.firstId &&
      first.id !== seen.firstId &&
      lastId === seen.lastId
    ) {
      // 2. Older page prepended: keep the reader on the message they were on.
      if (heightBeforeOlderRef.current > 0) {
        container.scrollTop +=
          container.scrollHeight - heightBeforeOlderRef.current;
        heightBeforeOlderRef.current = 0;
        syncRange();
      }
    } else if (lastId !== seen.lastId) {
      // 3. Something new at the bottom. Your own sends always follow.
      const mine = last.sender_id === viewerId;
      if (mine || stickRef.current) {
        container.scrollTop = container.scrollHeight;
        syncRange();
        stickRef.current = true;
        setShowJump(false);
        setNewBelow(0);
      } else {
        setNewBelow((count) => count + 1);
      }
    }

    lastSeenRef.current = { firstId: first.id, lastId };
  }, [
    annotated,
    firstUnreadId,
    roomId,
    viewerId,
    scrollContainerRef,
    virtualized,
    groupForMessage,
    offsets,
    initialPosition,
    syncRange,
  ]);

  useLayoutEffect(() => {
    if (!jumpTargetId || !groupForMessage.has(jumpTargetId)) {
      locatedJumpRef.current = null;
      return;
    }
    const container = scrollContainerRef?.current;
    if (!container) return;
    if (locatedJumpRef.current === jumpTargetId) return;
    const groupIndex = groupForMessage.get(jumpTargetId);
    const node = container.querySelector(
      `[data-message-id="${CSS.escape(String(jumpTargetId))}"]`,
    );
    if (!node) {
      container.scrollTop = offsets[groupIndex];
      stickRef.current = false;
      setWindowRange({
        start: Math.max(0, groupIndex - 8),
        end: Math.min(groups.length, groupIndex + 12),
        roomId,
      });
      return;
    }
    locatedJumpRef.current = jumpTargetId;
    node.scrollIntoView({
      behavior: virtualized ? "auto" : "smooth",
      block: "center",
    });
    if (virtualized)
      savePosition(viewerId, roomId, {
        id: jumpTargetId,
        offset:
          node.getBoundingClientRect().top -
          container.getBoundingClientRect().top,
        atBottom: false,
      });
    onJumpLocated?.(jumpTargetId);
  }, [
    jumpTargetId,
    groupForMessage,
    scrollContainerRef,
    offsets,
    range.start,
    range.end,
    groups.length,
    roomId,
    viewerId,
    virtualized,
    onJumpLocated,
  ]);

  useEffect(() => {
    if (virtualized)
      window.dispatchEvent(new Event("conclave:read-resume"));
  }, [virtualized, range.start, range.end]);

  useEffect(() => {
    const container = scrollContainerRef?.current;
    if (!container || !onMessageVisible) return undefined;
    return observeMessageReads({
      container,
      confirmed: visibleIds,
      inFlight: pendingReads,
      enabled: readsEnabled,
      messages: new Map(
        annotated
          .filter(
            (message) => message.sender_id !== viewerId && !message._optimistic,
          )
          .map((message) => [message.id, message]),
      ),
      onRead: onMessageVisible,
    });
  }, [
    annotated,
    onMessageVisible,
    scrollContainerRef,
    visibleIds,
    pendingReads,
    readsEnabled,
    viewerId,
  ]);

  // Images loading, the composer growing and the mobile keyboard opening all
  // change heights without a message arriving. Stay on the bottom through them.
  useEffect(() => {
    const container = scrollContainerRef?.current;
    const content = contentRef.current;
    if (!container || !content || typeof ResizeObserver === "undefined")
      return undefined;

    const observer = new ResizeObserver(() => {
      if (stickRef.current) container.scrollTop = container.scrollHeight;
      syncRange();
    });
    observer.observe(content);
    observer.observe(container);
    return () => observer.disconnect();
  }, [scrollContainerRef, hasMessages, syncRange]);

  const requestOlder = useCallback(() => {
    const container = scrollContainerRef?.current;
    if (container) heightBeforeOlderRef.current = container.scrollHeight;
    onLoadOlder?.();
  }, [onLoadOlder, scrollContainerRef]);

  useEffect(() => {
    const node = topSentinelRef.current;
    const container = scrollContainerRef?.current;
    if (!node || !container || !hasMore || !onLoadOlder) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) requestOlder();
      },
      { root: container, rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, onLoadOlder, requestOlder, scrollContainerRef, messages.length]);

  if (!messages.length) {
    return (
      // Fills the scroller row so the notice centres in the pane. Left bare,
      // EmptyState is only `min-h-48`, which collapsed the row to 192px and left
      // the composer floating in the space below it. `min-h-full` rather than
      // `h-full` so a viewport too short for the notice scrolls instead of
      // clipping the text.
      <div className="flex min-h-full flex-col justify-center">
        <EmptyState
          title="Start the conversation"
          description="Messages sent to this room will appear here."
        />
      </div>
    );
  }

  return (
    <MediaViewerProvider items={mediaItems} onJump={onJumpToMessage}>
      <div
        ref={contentRef}
        className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-5 pt-4 md:px-7"
      >
        {hasMore && (
          <div ref={topSentinelRef} className="py-2">
            {isLoadingOlder && <Spinner label="Loading earlier messages" />}
          </div>
        )}

        {virtualized && range.start > 0 && (
          <div
            aria-hidden="true"
            style={{ height: offsets[range.start], flexShrink: 0 }}
          />
        )}
        {groups.slice(range.start, range.end).map((group, localIndex) => {
          const groupIndex = range.start + localIndex;
          return (
            <MeasuredGroup
              key={groupKey(group)}
              groupIndex={groupIndex}
              onMeasure={onMeasure}
              className={groupIndex === 0 ? "mt-auto" : ""}
            >
              {group.messages[0].id === firstUnreadId && (
                <div
                  className="my-4 flex items-center gap-3 text-metadata font-medium text-brand"
                  role="separator"
                  aria-label="Unread messages"
                >
                  <span className="h-px flex-1 bg-brand/40" aria-hidden="true" />
                  <span>{unreadCount} unread messages</span>
                  <span className="h-px flex-1 bg-brand/40" aria-hidden="true" />
                </div>
              )}
              {group.messages[0]._startsDay && (
                <DaySeparator
                  label={daySeparatorLabel(group.messages[0].created_at)}
                />
              )}
              {group.albumId && group.messages.length > 1 && (
                <p className="mt-3 text-metadata text-muted">
                  {group.messages.length} media items
                </p>
              )}
              <div
                data-album-id={group.albumId || undefined}
                className={
                  group.albumId && group.messages.length > 1
                    ? "grid w-full grid-cols-2 items-start gap-2 rounded-2xl border border-line p-2"
                    : ""
                }
              >
                {group.messages.map((message) => (
                  <Fragment key={message.client_id || message.id}>
                    {/* mt-auto on the first row keeps a short conversation pinned to the
                bottom of the pane, next to the composer, rather than stranded at
                the top with a void beneath it. */}
                    <div
                      data-message-id={message.id}
                      className={`${group.albumId && group.messages.length > 1 ? "min-w-0" : message._consecutive ? "mt-0.5" : "mt-3"} ${highlightedId === message.id ? "message-jump-highlight rounded-2xl" : ""}`}
                    >
                      <Message
                        message={message}
                        albumTile={Boolean(
                          group.albumId && group.messages.length > 1,
                        )}
                        viewerId={viewerId}
                        members={members}
                        isAdmin={isAdmin}
                        roomId={roomId}
                        replyTarget={replyTargetFor(message)}
                        deliveryIds={deliveryIds}
                        onMessageInfo={onMessageInfo}
                        onReply={onReply}
                        onEdit={onEdit}
                        onDelete={onDelete}
                        onPromote={onPromote}
                        onFlagTask={onFlagTask}
                        onPin={onPin}
                        onUnpin={onUnpin}
                        onToggleReaction={onToggleReaction}
                        onOpenThread={onOpenThread}
                        onForward={onForward}
                        onJumpToMessage={onJumpToMessage}
                      />
                    </div>
                  </Fragment>
                ))}
              </div>
            </MeasuredGroup>
          );
        })}
        {virtualized && range.end < groups.length && (
          <div
            aria-hidden="true"
            style={{
              height: offsets.at(-1) - offsets[range.end],
              flexShrink: 0,
            }}
          />
        )}

        <TypingIndicator
          recordingUserIds={recordingUserIds}
          typingUserIds={typingUserIds}
          members={members}
        />
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {annotated.length
            ? `${annotated.length} messages loaded. Latest message from ${annotated.at(-1)?.sender_name || "a member"}.`
            : ""}
        </span>

        {/*
        `sticky`, not `absolute`. This container is the scroll *content*, so an
        absolutely positioned child anchors to the end of the whole transcript
        — measured 910px below the visible pane, visible only once the reader
        had already scrolled to the bottom, which is the one moment the pill is
        not needed. `sticky` pins it to the scrollport instead.

        The wrapper is `h-0` so it reserves no space: `showJump` flips on every
        scroll tick, and an in-flow button would shove the transcript each time
        it appeared or disappeared.
      */}
        {showJump && (
          <div className="pointer-events-none sticky bottom-3 z-10 h-0">
            <button
              type="button"
              onClick={scrollToBottom}
              className="pointer-events-auto absolute bottom-0 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface px-4 py-2 text-label text-ink shadow-modal transition-colors hover:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <IconArrowDown
                className="h-4 w-4 shrink-0 text-muted"
                aria-hidden="true"
              />
              {newBelow > 0
                ? `${newBelow} new message${newBelow === 1 ? "" : "s"}`
                : "Jump to latest"}
            </button>
          </div>
        )}
      </div>
    </MediaViewerProvider>
  );
}
