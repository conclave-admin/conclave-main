// Mention matching by display name — now a TEMPORARY FALLBACK, used only when a
// client sends a message without `mentionedUserIds`.
//
// The real mechanism is the message_mentions table (BACKEND_TASKS.md item H):
// a client sends the ids of the people it mentioned, and that is recorded and
// read by both the digest and notifications. A display name is not an identity —
// it is not even unique — so text can neither express "this person" nor survive a
// rename.
//
// This module exists so clients that predate that contract keep working. The only
// client send path (client/src/hooks/useMessages.js) does not send ids yet.
//
// DELETE THIS MODULE when that hook passes `mentionedUserIds`, and remove the
// fallback branch in resolveMentionIds (services/message.service.js) with it.
// Until then a rename still misdirects mentions for messages sent without ids —
// the exact bug item H fixes, kept alive only by the bridge.
//
// The matcher itself is sound, and was hardened in three steps: '%' and '_' in a
// display name were treated as wildcards under ILIKE, and a plain substring match
// meant a user named "Al" matched "@Alice". Names are escaped for regex and a
// non-word character is required after them, which gives a real word boundary.
function mentionPattern(displayName) {
  const escaped = displayName.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&');
  // Postgres uses POSIX regex, which has no lookahead, so express the boundary
  // as "a non-word character, or end of string".
  return `@${escaped}([^A-Za-z0-9_]|$)`;
}

/**
 * Whether `text` mentions `displayName`, using the same escaping as
 * mentionPattern but as a JavaScript test.
 *
 * Needed because the pattern is per-member — it embeds that member's display
 * name — so it cannot be a single parameterised SQL `~` comparison.
 *
 * Matched unanchored, so a mention anywhere in the text counts — "@Name"
 * mid-sentence is still a mention.
 *
 * Case-insensitive. There is no longer another matcher to agree with — the digest
 * reads message_mentions and never touches text — so this is now a standalone
 * choice, kept because it was the digest's behaviour and removing it would change
 * which fallback sends notify. Item H's client path removes the question entirely.
 */
function isMentioned(text, displayName) {
  if (!text || !displayName) return false;
  return new RegExp(mentionPattern(displayName), 'i').test(text);
}

module.exports = { mentionPattern, isMentioned };