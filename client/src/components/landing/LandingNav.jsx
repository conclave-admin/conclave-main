import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import IconMenu from '@/assets/icons/menu.svg?react';
import IconClose from '@/assets/icons/close.svg?react';
import ThemeSwitch from '@/components/ui/ThemeSwitch';
import Logo from './Logo';

const LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#how', label: 'How it works' },
];

/**
 * The landing header.
 *
 * Sticky and translucent so the grid lines read through it, rather than a
 * solid bar that severs the page at the top. Below `md` the links collapse
 * into a menu — a hamburger that does nothing is worse than no hamburger, so
 * this one actually opens a panel, closes on Escape and on link click, and
 * reports its state through `aria-expanded`.
 */
export default function LandingNav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-line/60 bg-canvas/80 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 md:px-10 lg:px-16" aria-label="Primary">
        <Link to="/" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
          <Logo />
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-label text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="hidden items-center gap-3 md:flex">
          {/* lg and up only: at md the header already carries two links plus
              Sign in and Get started, and a third three-way control makes it
              wrap. Below lg it lives in the collapsed menu instead, so the
              control is never unreachable — only relocated. */}
          <ThemeSwitch compact className="hidden lg:inline-flex" />
          <Link
            to="/login"
            className="rounded-lg px-3 py-2 text-label text-ink transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
          >
            Sign in
          </Link>
          <Link
            to="/register"
            className="inline-flex min-h-10 items-center justify-center rounded-lg bg-brand px-4 text-sm font-semibold text-surface transition-colors hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
          >
            Get started
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="landing-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          className="rounded-lg p-2 text-ink transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 md:hidden"
        >
          {open ? <IconClose className="h-5 w-5" aria-hidden="true" /> : <IconMenu className="h-5 w-5" aria-hidden="true" />}
        </button>
      </nav>

      {open && (
        <div id="landing-menu" className="border-t border-line/60 bg-canvas px-6 py-4 md:hidden">
          <div className="flex flex-col gap-1">
            {LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-body text-ink transition-colors hover:bg-canvas"
              >
                {link.label}
              </a>
            ))}
          </div>
          <div className="mt-3 border-t border-line/60 pt-4">
            <p className="mb-2 px-3 text-metadata text-muted">Theme</p>
            <ThemeSwitch compact />

            <div className="mt-4 flex flex-col gap-2">
              <Link
                to="/login"
                onClick={() => setOpen(false)}
                className="inline-flex min-h-10 items-center justify-center rounded-lg border border-line px-4 text-sm font-semibold text-ink transition-colors hover:bg-canvas"
              >
                Sign in
              </Link>
              <Link
                to="/register"
                onClick={() => setOpen(false)}
                className="inline-flex min-h-10 items-center justify-center rounded-lg bg-brand px-4 text-sm font-semibold text-surface transition-colors hover:bg-brand/90"
              >
                Get started
              </Link>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
