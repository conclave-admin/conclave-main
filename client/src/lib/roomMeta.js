/**
 * Compact relative times for a chat row.
 *
 * The shapes are the ones a messaging app uses rather than a general-purpose
 * "3 hours ago": today reads as a clock time because that is what you scan
 * for in a list of today's conversations, and anything older collapses to a
 * date quickly because precision past a week is noise.
 *
 * @param {string|number|Date} value
 * @param {Date} [now] - injectable for tests
 */
export function formatRoomTime(value, now = new Date()) {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const minutes = String(date.getMinutes()).padStart(2, '0');

  if (date >= startOfToday) {
    const hours = date.getHours();
    const suffix = hours >= 12 ? 'PM' : 'AM';
    const hour12 = hours % 12 || 12;
    return `${hour12}:${minutes} ${suffix}`;
  }

  const sameYear = date.getFullYear() === now.getFullYear();
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  return sameYear ? `${month} ${date.getDate()}` : `${month} ${date.getDate()}, ${date.getFullYear()}`;
}

/**
 * The one-line preview under the room name.
 *
 * Tombstones and attachments are described rather than shown: a deleted
 * message has no content to display, and an attachment-only message's content
 * is an empty string, which would render as a blank row and read as a bug.
 *
 * @param {{ content?: string|null, is_deleted?: boolean, has_attachment?: boolean }} message
 */
export function formatRoomPreview(message) {
  if (!message) return 'No messages yet';
  if (message.is_deleted) return 'Message deleted';
  if (message.content) return message.content;
  if (message.has_attachment) return 'Attachment';
  return 'No messages yet';
}
