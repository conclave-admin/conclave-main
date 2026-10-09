import { useEffect, useRef } from 'react';
import Avatar from '@/components/ui/Avatar';

/**
 * Autocomplete for @mentions.
 *
 * Selecting somebody records their id, not their name. The server infers
 * mentions from display names only when `mentionedUserIds` is omitted, and
 * that path is documented as temporary and wrong for two members who share a
 * name — display_name is not unique, only email is. Sending ids is what makes a
 * mention mean one person.
 *
 * The list is room members only, because the server silently drops ids that are
 * not in the room. Offering someone outside it would look like it worked and
 * quietly notify nobody.
 *
 * @param {Array} members
 * @param {string} query - the text after the @, already stripped
 * @param {(member: object) => void} onSelect
 * @param {() => void} onDismiss
 */
export default function MentionPicker({ members = [], query = '', onSelect, onDismiss }) {
  const listRef = useRef(null);

  const needle = query.trim().toLowerCase();
  const matches = members
    .filter((member) => member.display_name?.toLowerCase().includes(needle))
    .slice(0, 6);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  if (matches.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Mention a member"
      className="absolute bottom-full left-0 mb-2 w-72 overflow-hidden rounded-lg border border-line bg-surface shadow-modal"
    >
      {matches.map((member) => (
        <button
          key={member.id}
          type="button"
          role="option"
          aria-selected="false"
          onMouseDown={(event) => {
            // mousedown, not click: the composer's textarea blurs on click and
            // would close this before the selection lands.
            event.preventDefault();
            onSelect(member);
          }}
          className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-none"
        >
          <Avatar name={member.display_name} src={member.avatar_url} size="sm" />
          <span className="min-w-0">
            <span className="block truncate text-body text-ink">{member.display_name}</span>
            {member.role === 'admin' && (
              <span className="block text-metadata text-muted">Admin</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
