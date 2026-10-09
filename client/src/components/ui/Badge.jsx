const TONES = {
  // The surface behind the badge changes per theme, so every tone picks its
  // pairing from the tokens rather than a hex — a dark-surface badge and a
  // light-surface badge both stay legible from one class list.
  brand: 'bg-brand text-surface',
  neutral: 'bg-line text-ink',
  success: 'bg-success text-surface',
  warning: 'bg-warning text-surface',
  error: 'bg-error text-surface',
};

/**
 * A count or a short status pill.
 *
 * `tabular-nums` matters more than it looks: an unread badge re-renders on
 * every message, and proportional digits make the pill change width as the
 * count ticks over, so the row it sits in visibly jitters.
 *
 * @param {React.ReactNode} children
 * @param {keyof TONES} [tone]
 * @param {string} [className]
 */
export default function Badge({ children, tone = 'brand', className = '' }) {
  return (
    <span
      className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-metadata font-medium tabular-nums ${
        TONES[tone] ?? TONES.neutral
      } ${className}`}
    >
      {children}
    </span>
  );
}
