// Only IDs recorded on the message can become links. Ambiguous display names
// remain text rather than taking the reader to the wrong person's profile.
export function mentionSegments(text, members = [], mentionedIds = []) {
  const allowed = new Set(mentionedIds);
  const candidates = members.filter(
    (member) => allowed.has(member.id) && member.display_name,
  );
  const names = [
    ...new Set(candidates.map((member) => member.display_name)),
  ].sort((a, b) => b.length - a.length);
  const parts = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (
      text[index] !== "@" ||
      (index > 0 && /[\p{L}\p{N}_@]/u.test(text[index - 1]))
    )
      continue;
    const name = names.find(
      (name) =>
        text.startsWith(`@${name}`, index) &&
        !/[\p{L}\p{N}_]/u.test(text[index + name.length + 1] || ""),
    );
    if (!name) continue;
    const matches = candidates.filter((member) => member.display_name === name);
    if (matches.length !== 1) continue;
    if (index > start) parts.push({ text: text.slice(start, index) });
    parts.push({ text: `@${name}`, userId: matches[0].id });
    index += name.length;
    start = index + 1;
  }
  if (start < text.length) parts.push({ text: text.slice(start) });
  return parts;
}
