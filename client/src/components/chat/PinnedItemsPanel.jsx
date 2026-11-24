import IconChevron from "@/assets/icons/chevron-down.svg?react";
import IconPin from "@/assets/icons/pin.svg?react";
import PinnedDecisionStrip from "./PinnedDecisionStrip";
import PinnedMessagesPanel from "./PinnedMessagesPanel";

export default function PinnedItemsPanel({
  roomId,
  isAdmin = false,
  viewerId,
  onJumpToMessage,
}) {
  return (
    <details className="group shrink-0 border-b border-line bg-surface [&:not(:has(.pinned-items-content))]:hidden">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 py-2 text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/30 [&::-webkit-details-marker]:hidden md:px-7">
        <IconPin className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-body font-medium text-ink">
          Pinned items
        </span>
        <span className="text-metadata text-muted">Messages and decisions</span>
        <IconChevron
          className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <div className="max-h-80 overflow-y-auto border-t border-line">
        <PinnedMessagesPanel
          roomId={roomId}
          isAdmin={isAdmin}
          viewerId={viewerId}
          onJumpToMessage={onJumpToMessage}
          embedded
        />
        <PinnedDecisionStrip roomId={roomId} embedded />
      </div>
    </details>
  );
}
