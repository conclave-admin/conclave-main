import IconChevronDown from '@/assets/icons/chevron-down.svg?react';

/**
 * A native `<select>` with the app's field styling.
 *
 * Native rather than a custom listbox: the OS picker is keyboard- and
 * screen-reader-correct for free, and the two places this is needed (theme,
 * room filters) have short option lists where nothing is gained by replacing
 * it. The chevron is drawn because `appearance-none` removes it.
 *
 * @param {string} [label]
 * @param {string} [error]
 * @param {string} [id]
 * @param {React.ReactNode} children - the `<option>`s
 */
export default function Select({ label, error, id, children, className = '', ...props }) {
  return (
    <label className="block" htmlFor={id}>
      {label && <span className="mb-2 block text-sm font-medium text-ink">{label}</span>}
      <span className="relative block">
        <select
          id={id}
          className={`min-h-12 w-full appearance-none rounded-lg border bg-surface pl-3.5 pr-10 text-sm text-ink outline-none transition-shadow focus:border-brand focus:ring-2 focus:ring-brand/15 ${error ? 'border-error' : 'border-line'} ${className}`}
          {...props}
        >
          {children}
        </select>
        <IconChevronDown
          className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted"
          aria-hidden="true"
        />
      </span>
      {error && <span className="mt-1.5 block text-sm text-error">{error}</span>}
    </label>
  );
}
