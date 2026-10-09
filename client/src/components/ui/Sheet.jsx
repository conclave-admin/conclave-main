import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import IconClose from '@/assets/icons/close.svg?react';

/**
 * A bottom-anchored dialog — the mobile form of `Modal`.
 *
 * Anchored to the bottom edge rather than centred so the actions land in thumb
 * reach, and full-width below `md` so it does not float as a small box on a
 * phone. Same four responsibilities as `Modal` (Escape, backdrop, focus in,
 * focus back) and the same `onMouseDown` rationale: a drag-select that ends on
 * the backdrop must not close the sheet.
 *
 * @param {boolean} open
 * @param {() => void} [onClose]
 * @param {React.ReactNode} title
 * @param {React.ReactNode} [footer]
 */
export default function Sheet({ open, onClose, title, children, footer, className = '' }) {
  const titleId = useId();
  const panelRef = useRef(null);
  const restoreFocusTo = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    restoreFocusTo.current = document.activeElement;
    panelRef.current?.focus();
    return () => restoreFocusTo.current?.focus?.();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 motion-safe:animate-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`max-h-[85vh] w-full overflow-y-auto rounded-t-xl bg-surface shadow-modal outline-none motion-safe:animate-sheet-in md:mx-auto md:mb-6 md:max-w-md md:rounded-xl ${className}`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h2 id={titleId} className="text-h2 text-ink">
            {title}
          </h2>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-m-2 rounded-lg p-2 text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <IconClose className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="px-5 py-4 text-body text-ink">{children}</div>

        {footer && <div className="flex justify-end gap-3 border-t border-line px-5 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
