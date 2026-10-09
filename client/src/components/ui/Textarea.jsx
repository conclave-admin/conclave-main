import { useEffect, useRef } from 'react';

/**
 * A multi-line field that grows with its content up to `maxRows`.
 *
 * Visual treatment is copied from Input so the two are indistinguishable when
 * they sit next to each other, which is the case on the settings screens.
 *
 * Auto-grow only reacts to `value`, so it is a controlled component — the
 * composer and every form here already are.
 *
 * @param {string} [label]
 * @param {string} [error] - replaces the border colour and explains why
 * @param {string} [id]
 * @param {number} [rows]   - starting height
 * @param {number} [maxRows] - clamp; beyond this the box scrolls instead
 */
export default function Textarea({ label, error, id, rows = 1, maxRows = 5, value, className = '', ...props }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    // Reset before measuring: scrollHeight is taken against the current height,
    // so without this the box can shrink back after deleting a line.
    el.style.height = 'auto';

    const lineHeight = parseFloat(window.getComputedStyle(el).lineHeight);
    // `line-height: normal` parses to NaN. Clamping needs a number, so if the
    // computed value is a keyword the box is simply left to grow — a slightly
    // tall composer is better than a broken one.
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return undefined;

    el.style.height = `${Math.min(el.scrollHeight, lineHeight * maxRows)}px`;
    return undefined;
  }, [value, maxRows]);

  return (
    <label className="block" htmlFor={id}>
      {label && <span className="mb-2 block text-sm font-medium text-ink">{label}</span>}
      <textarea
        ref={ref}
        id={id}
        rows={rows}
        value={value}
        className={`block w-full resize-none overflow-y-auto rounded-lg border bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition-shadow placeholder:text-muted/70 focus:border-brand focus:ring-2 focus:ring-brand/15 ${error ? 'border-error' : 'border-line'} ${className}`}
        {...props}
      />
      {error && <span className="mt-1.5 block text-sm text-error">{error}</span>}
    </label>
  );
}
