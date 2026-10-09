import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import IconClose from '@/assets/icons/close.svg?react';

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-xl',
};

/**
 * A centred dialog. `Sheet` is the bottom-anchored sibling for narrow screens;
 * this one is centred at every width so a long-press menu and a confirmation
 * do not change shape as the layout crosses `md`.
 *
 * Handles the four things a dialog reliably gets wrong: Escape, the backdrop,
 * focus going in, and focus coming back. Body scroll is locked while open and
 * restored from the value that was there before, so a modal opened over an
 * already-locked page does not unlock it on close.
 *
 * Backdrop uses `onMouseDown` rather than `onClick`, with a target check: a
 * text selection dragged out of the dialog ends on the backdrop, and treating
 * that as a click would close the dialog under someone selecting text.
 *
 * @param {boolean} open
 * @param {() => void} [onClose]
 * @param {React.ReactNode} title
 * @param {'sm'|'md'|'lg'} [size]
 * @param {React.ReactNode} [footer]
 */
export default function Modal({ open, onClose, title, children, footer, size = 'md', className = '' }) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const restoreFocusTo = useRef(null);

  // Focus goes in on open and returns to whatever opened it on close, so the
  // next Tab continues from the trigger rather than the top of the document.
  useEffect(() => {
    if (!open) return undefined;
    restoreFocusTo.current = document.activeElement;
    dialogRef.current?.focus();
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 motion-safe:animate-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`w-full ${SIZES[size] ?? SIZES.md} max-h-[90vh] overflow-y-auto rounded-xl bg-surface shadow-modal outline-none ${className}`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
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

        <div className="px-6 py-5 text-body text-ink">{children}</div>

        {footer && (
          <div className="flex justify-end gap-3 border-t border-line px-6 py-4">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
