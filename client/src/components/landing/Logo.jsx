import logoUrl from '@/assets/brand/logo.svg';

/**
 * The Conclave mark.
 *
 * Full-colour, so it is imported as a URL rather than through svgr: the file is
 * 34KB across 53 paths, and inlining that into the JS bundle would ship it on
 * every route including the landing page, which is the one page where first
 * paint matters most. Vite emits it as a separate hashed asset instead.
 *
 * The artwork carries its own opaque near-white plate with rounded corners, so
 * no CSS rounding is added here — rounding the square <img> as well would
 * double-round the corners and clip them. It reads as a mark on the light
 * surface and as an app-icon tile on the dark one, which is the intended
 * behaviour for a full-colour logo rather than a defect to hide.
 *
 * The wordmark carries the name, so the image is decorative while it is
 * present. `alt` only takes the name in the mark-only case, where there is
 * nothing else for a screen reader to read.
 *
 * @param {boolean} [withWordmark]
 * @param {string} [className]
 */
export default function Logo({ withWordmark = true, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <img src={logoUrl} alt={withWordmark ? '' : 'Conclave'} width={32} height={32} className="h-8 w-8 shrink-0" />
      {withWordmark && (
        <span className="text-lg font-semibold tracking-tight text-ink">Conclave</span>
      )}
    </span>
  );
}
