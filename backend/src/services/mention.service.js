// Mention matching — shared by the digest and by createMessage.
//
// This is a STOPGAP (BACKEND_TASKS.md Bug 9). Matching raw text with ILIKE is
// wrong in two ways: '%' and '_' inside a display name act as wildcards, and a
// plain substring match means a user named "Al" matches "@Alice". The name is
// escaped for POSIX regex and a non-word character is required after it, which
// gives a real word boundary.
//
// It lives here rather than in the digest controller because both need it: the
// digest to find messages mentioning you, and createMessage to notify you when
// someone writes your name. One implementation, so the two cannot drift apart.
//
// Replaced entirely by the message_mentions table (BACKEND_TASKS.md item H), and
// by a client-supplied mentionedUserIds list — a display name is not an identity,
// so renaming a user currently changes who gets mentioned.
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
 * name — so it cannot be a single parameterised SQL `~` comparison. JS and POSIX
 * agree on the escapes and the word-boundary classes used above, and both tests
 * cover the same two cases: an exact "@Name" and "@Name" followed by punctuation
 * or end of string, while "@Nameless" does not match "@Name".
 *
 * Matched against the unanchored pattern, so a mention anywhere in the text
 * counts — "@Name" mid-sentence is still a mention.
 *
 * Case-insensitive, to match the digest's `~*`. Case-sensitivity itself is
 * debatable — "Al" matching "@alice" is arguably fine, "@ALICE" less so — but it
 * is the digest's existing behaviour and the two matchers must not disagree.
 * Item H removes the question by matching on ids instead of text.
 */
function isMentioned(text, displayName) {
  if (!text || !displayName) return false;
  // The `i` flag is load-bearing, not a nicety. The digest matches mentions in
  // SQL with `content ~*`, which is case-INsensitive, so without this flag the
  // same text would appear in someone's digest but send them no notification.
  // Sharing the pattern string was not enough — the two matchers have to agree on
  // semantics too, or "@amina" and "@Amina" diverge between the two features.
  return new RegExp(mentionPattern(displayName), 'i').test(text);
}

module.exports = { mentionPattern, isMentioned };