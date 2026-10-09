import IconSuccess from '@/assets/icons/success.svg?react';
import IconWarning from '@/assets/icons/warning.svg?react';
import IconInfo from '@/assets/icons/info.svg?react';
import IconClose from '@/assets/icons/close.svg?react';

const TONES = {
  success: { icon: IconSuccess, edge: 'border-success/50' },
  warning: { icon: IconWarning, edge: 'border-warning/50' },
  // The sprite has no dedicated error glyph. The warning triangle is the
  // closest conventional error mark, and pairing it with the error border
  // keeps the two distinguishable.
  error: { icon: IconWarning, edge: 'border-error/50' },
  info: { icon: IconInfo, edge: 'border-brand/50' },
  neutral: { icon: null, edge: 'border-line' },
};

/**
 * One transient message. Positioned and stacked by the provider — a caller
 * only ever asks for a toast, it never places one.
 *
 * Errors use `role="alert"` so they interrupt; everything else is `status`,
 * which queues. That distinction is the whole reason the two roles exist, and
 * getting it backwards is how a chat ends up reading every "message sent" out
 * loud over the top of what someone is actually saying.
 *
 * @param {string} title
 * @param {string} [description]
 * @param {keyof TONES} [tone]
 * @param {() => void} [onDismiss]
 */
export default function Toast({ title, description, tone = 'neutral', onDismiss }) {
  const { icon: Icon, edge } = TONES[tone] ?? TONES.neutral;
  const isError = tone === 'error';

  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border-l-4 border bg-surface p-4 shadow-modal ${edge}`}
    >
      {Icon && <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />}

      <div className="min-w-0 flex-1">
        <p className="text-label text-ink">{title}</p>
        {description && <p className="mt-1 text-metadata text-muted">{description}</p>}
      </div>

      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-m-1 shrink-0 rounded-lg p-1 text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
        >
          <IconClose className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
