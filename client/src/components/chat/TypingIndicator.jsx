/**
 * "Someone is typing".
 *
 * Dots plus the names, not dots alone. A row of bouncing dots tells you
 * something is happening but not whether it is one person or six, and in a
 * busy room the difference changes whether you wait or start typing yourself.
 *
 * Renders just above the composer so it stays in the same place regardless of
 * how far through the conversation the reader has scrolled.
 *
 * @param {string[]} typingUserIds
 * @param {Array} members - room members, for display names
 */
export default function TypingIndicator({
  typingUserIds = [],
  recordingUserIds = [],
  members = [],
}) {
  const typers = typingUserIds.filter((id) => !recordingUserIds.includes(id));
  if (!typers.length && !recordingUserIds.length) return null;
  const describe = (ids, singular, plural) => {
    const names = ids.map(
      (id) =>
        members.find((member) => member.id === id)?.display_name || "Someone",
    );
    if (!names.length) return "";
    return names.length === 1
      ? `${names[0]} ${singular}`
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} ${plural}`;
  };
  const label = [
    describe(
      recordingUserIds,
      "is recording a voice message",
      "are recording voice messages",
    ),
    describe(typers, "is typing", "are typing"),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      role="status"
      aria-live="polite"
      className="typing-indicator flex min-h-6 items-center gap-2 px-7 pb-1 text-metadata text-muted"
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
