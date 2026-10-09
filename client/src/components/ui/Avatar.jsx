const SIZES = {
  // Sized against the existing primitives: sm is a chat-list row, md is a
  // message or a member row, lg is a profile header.
  sm: 'h-8 w-8 text-metadata',
  md: 'h-10 w-10 text-label',
  lg: 'h-16 w-16 text-h2',
};

export function initialsOf(name = '') {
  return (
    name
      .split(' ')
      .filter(Boolean)
      .map((part) => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

/**
 * @param {string} name    - used for the initials fallback
 * @param {string} [src]   - avatar_url; when present the image wins
 * @param {'sm'|'md'|'lg'} [size]
 * @param {'online'|'offline'|null} [presence] - draws the status dot; omit it
 *   and no wrapper is added at all, so a plain avatar costs nothing extra
 * @param {string} [className]
 */
export default function Avatar({ name = '', src, size = 'md', presence, className = '' }) {
  const box = `${SIZES[size] ?? SIZES.md} shrink-0 rounded-full ${className}`;

  const face = src ? (
    <img src={src} alt="" className={`${box} object-cover`} />
  ) : (
    // initials rather than a grey circle: the message list currently draws an
    // unlabelled placeholder, which says nothing about who is talking.
    <span className={`${box} grid place-items-center bg-brand-soft text-brand`} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );

  if (!presence) return face;

  return (
    <span className="relative inline-flex shrink-0">
      {face}
      {/* Decorative on purpose: presence is stated in words next to the avatar
          in the surfaces that show it (the sidebar status line), so narrating
          the dot as well would read it out twice. */}
      <span
        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface ${
          presence === 'online' ? 'bg-success' : 'bg-line'
        }`}
        aria-hidden="true"
      />
    </span>
  );
}
