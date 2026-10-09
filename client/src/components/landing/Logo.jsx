/**
 * The Conclave mark.
 *
 * Placeholder, and deliberately an obviously unfinished one. There is no logo
 * asset in `client/src/assets/` — only the icon sprite — and inventing a
 * monogram is a design decision that is not mine to make. So the slot is drawn
 * as a dashed, empty box: recognisable as "asset pending" to anyone reading
 * the nav, and trivially replaced.
 *
 * When the file lands, the slot becomes an `<img>` (or an svgr import) and
 * nothing else in this component changes. The wordmark stays until then so the
 * nav does not read as broken next to an empty box.
 *
 * @param {boolean} [withWordmark]
 * @param {string} [className]
 */
export default function Logo({ withWordmark = true, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span
        aria-hidden="true"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-dashed border-line"
      />
      {withWordmark && (
        <span className="font-display text-h2 tracking-tight text-ink">Conclave</span>
      )}
    </span>
  );
}
