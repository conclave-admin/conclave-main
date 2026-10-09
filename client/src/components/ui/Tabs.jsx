/**
 * A row of filters. Driven by an array rather than child `<Tab>` elements so
 * the same call site can render a dynamic set (unread count changes the tabs,
 * not the component), and so a caller can put a Badge inside a label without
 * the tab primitive needing to know what a badge is.
 *
 * @param {{ value: string, label: React.ReactNode }[]} tabs
 * @param {string} value
 * @param {(value: string) => void} [onChange]
 * @param {string} [ariaLabel] - required in practice: a tab strip with no
 *   accessible name is an unlabelled group of buttons
 */
export default function Tabs({ tabs, value, onChange, ariaLabel, className = '' }) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={`flex gap-1 overflow-x-auto border-b border-line ${className}`}>
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange?.(tab.value)}
            className={`min-h-10 shrink-0 border-b-2 px-3 text-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
              selected ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
