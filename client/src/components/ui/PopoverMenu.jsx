import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const EDGE = 8;
const GAP = 4;

/**
 * An anchored menu, portalled to `document.body`.
 *
 * Every dropdown in this app used to be an absolutely positioned box inside the
 * element that triggered it. That is fine while the trigger sits in open
 * layout, and wrong the moment it does not:
 *
 *   - A per-message menu anchored `right-0` on a right-aligned bubble grows
 *     leftward off the screen — measured at 164px of a 208px menu on a 390px
 *     viewport, so four fifths of it was unreachable.
 *   - Any menu opening downward from the lower third of an `overflow-y-auto`
 *     scroller is cut by that scroller, by up to 145px, and the timeline hides
 *     its scrollbar so the cut cannot be scrolled away.
 *
 * A portal removes the menu from the scroller entirely, and measuring the
 * trigger lets it flip and clamp into the viewport instead of trusting a
 * single side. The alternative — reasoning about each of the five call sites
 * and hoping a sixth never appears — is what produced this file.
 *
 * Closes on scroll rather than tracking the trigger. Tracking is possible but
 * costs a rAF-throttled listener per open menu and reads as the menu chasing
 * the cursor down the transcript; closing is what Slack and Discord do and is
 * the cheaper of the two.
 *
 * @param {boolean} open
 * @param {() => void} onClose
 * @param {{ current: HTMLElement | null }} triggerRef - the control to anchor to
 * @param {'top'|'bottom'} [side] - preferred opening direction
 * @param {'start'|'end'} [align] - align the menu's start or end edge to the trigger's
 * @param {string} [label] - accessible name for the menu itself
 * @param {string} [className] - width and any extra styling
 * @param {React.ReactNode} children
 */
export default function PopoverMenu({
  open,
  onClose,
  triggerRef,
  side = 'bottom',
  align = 'end',
  label,
  className = '',
  children,
}) {
  const menuRef = useRef(null);
  // Held off-screen and hidden until measured, so the first paint is never a
  // flash of a menu at the top-left corner of the window.
  const [position, setPosition] = useState({ top: -9999, left: -9999, hidden: true });

  const place = useCallback(() => {
    const trigger = triggerRef?.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const triggerBox = trigger.getBoundingClientRect();
    const menuBox = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Vertical. Start on the preferred side, flip to the other if it does not
    // fit, then clamp as a last resort for a menu taller than the viewport.
    const below = triggerBox.bottom + GAP + menuBox.height;
    const above = triggerBox.top - GAP - menuBox.height;
    let top;
    if (side === 'top') {
      top = above < EDGE ? triggerBox.bottom + GAP : triggerBox.top - GAP - menuBox.height;
    } else {
      top = below > viewportHeight - EDGE ? triggerBox.top - GAP - menuBox.height : triggerBox.bottom + GAP;
    }
    top = Math.min(Math.max(EDGE, top), viewportHeight - menuBox.height - EDGE);

    // Horizontal. The clamp is what fixes the off-screen case: it holds
    // whatever the alignment works out to inside the window.
    const start = align === 'end' ? triggerBox.right - menuBox.width : triggerBox.left;
    const left = Math.min(Math.max(EDGE, start), viewportWidth - menuBox.width - EDGE);

    setPosition({ top, left, hidden: false });
  }, [triggerRef, side, align]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition({ top: -9999, left: -9999, hidden: true });
      return undefined;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };

    // Capture phase, and both nodes treated as inside. Capture matters because
    // the menu is no longer a descendant of the trigger's wrapper, and listing
    // the trigger separately matters because toggling it shut is the trigger's
    // own job — a plain outside-click check would fire first and race it.
    const onPointerDown = (event) => {
      if (menuRef.current?.contains(event.target)) return;
      if (triggerRef?.current?.contains(event.target)) return;
      onClose?.();
    };

    const dismiss = () => onClose?.();

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', dismiss, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', dismiss, true);
    };
  }, [open, onClose, triggerRef]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      role={label ? 'menu' : undefined}
      aria-label={label}
      className={`fixed z-50 rounded-lg border border-line bg-surface p-1 shadow-modal ${className}`}
      style={{ top: position.top, left: position.left, visibility: position.hidden ? 'hidden' : 'visible' }}
    >
      {children}
    </div>,
    document.body,
  );
}
