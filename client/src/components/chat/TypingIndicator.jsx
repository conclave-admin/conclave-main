/**
 * "Someone is typing".
 *
 * Dots plus the names, not dots alone. A row of bouncing dots tells you
 * something is happening but not whether it is one person or six, and in a
 * busy room the difference changes whether you wait or start typing yourself.
 *
 * Renders nothing when nobody is, so it costs no vertical space in the common
 * case — it is overlaid rather than taking a slot in the timeline, because a
 * row that appears and disappears would shove the messages above it.
 *
 * @param {string[]} typingUserIds
 * @param {Array} members - room members, for display names
 */
export default function TypingIndicator({ typingUserIds = [], members = [] }) {
  if (typingUserIds.length === 0) return null;

  const names = typingUserIds.map(
    (id) => members.find((member) => member.id === id)?.display_name || 'Someone',
  );
  const label =
    names.length === 1
      ? `${names[0]} is typing`
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute bottom-2 left-0 right-0 flex items-center gap-2 px-7 text-metadata text-muted"
    >
      <span className="flex items-end gap-0.5" aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-muted [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-muted [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-muted [animation-delay:300ms]" />
      </span>
      <span className="truncate">{label}</span>
    </div>
  );
}
