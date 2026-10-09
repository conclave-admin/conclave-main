/**
 * A pulsing placeholder for content that is still loading.
 *
 * Always decorative: the shape of a thing that has not arrived yet carries no
 * information a screen reader could use, so it is hidden from the accessibility
 * tree. The loading message belongs to the surface around it — Spinner already
 * renders `role="status"`, and that is where a skeleton's caller should put one.
 *
 * No size is built in. The placeholder has to match what it is standing in for,
 * so that is the caller's to give.
 *
 * @param {string} [className] - dimensions, e.g. `h-4 w-40`
 * @param {boolean} [circle]   - for avatars
 */
export default function Skeleton({ className = '', circle = false }) {
  return (
    <div
      className={`animate-pulse bg-line/70 ${circle ? 'rounded-full' : 'rounded-lg'} ${className}`}
      aria-hidden="true"
    />
  );
}
