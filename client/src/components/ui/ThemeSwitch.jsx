import { useRef } from 'react';
import { useTheme } from '@/contexts/ThemeContext';

const OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/**
 * Light / Dark / System.
 *
 * A radiogroup rather than three independent buttons: these are three states
 * of one setting, not three actions, and a screen reader that announces
 * "Dark, radio button, selected" says that where three toggle buttons would
 * say nothing about the relationship between them.
 *
 * Arrow keys move AND select, per the radiogroup pattern, with roving tabindex
 * so the group is one tab stop. System is a real third option rather than a
 * fallback — selecting it clears the stored key, which is what makes the OS
 * preference keep tracking live instead of being frozen at the moment of the
 * click. `theme` is therefore the right value to read, not `resolved`: the
 * control has to show that the system is in charge while it is.
 *
 * Labels rather than icons, because no sun or moon glyph exists in the sprite
 * yet — see the asset list in docs/frontend.md.
 *
 * @param {boolean} [compact] - tighter padding for the landing nav
 */
export default function ThemeSwitch({ compact = false, className = '' }) {
  const { theme, setTheme } = useTheme();
  const buttons = useRef({});

  function onKeyDown(event) {
    const current = OPTIONS.findIndex((option) => option.value === theme);
    let next = null;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % OPTIONS.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + OPTIONS.length) % OPTIONS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = OPTIONS.length - 1;

    if (next === null) return;
    event.preventDefault();
    setTheme(OPTIONS[next].value);
    buttons.current[OPTIONS[next].value]?.focus();
  }

  const sizing = compact ? 'px-2.5 py-1 text-metadata' : 'px-3.5 py-1.5 text-label';

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onKeyDown}
      className={`inline-flex items-center gap-1 rounded-full border border-line bg-canvas p-1 ${className}`}
    >
      {OPTIONS.map((option) => {
        const selected = option.value === theme;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[option.value] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => setTheme(option.value)}
            className={`rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${sizing} ${
              selected
                ? 'bg-brand font-semibold text-surface'
                : 'text-muted hover:bg-surface hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
