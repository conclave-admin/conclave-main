import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import IconMenu from '@/assets/icons/menu.svg?react';
import IconClose from '@/assets/icons/close.svg?react';
import IconArrow from '@/assets/icons/arrow-right.svg?react';
import ThemeSwitch from '@/components/ui/ThemeSwitch';
import Logo from './Logo';

const LINKS = [
  { href: '#features', label: 'Why Conclave' },
  { href: '#product-preview', label: 'A look inside' },
  { href: '#how', label: 'Getting started' },
];

export default function LandingNav() {
  const [open, setOpen] = useState(false);
  const menuButton = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = event => {
      if (event.key === 'Escape') {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [open]);

  return (
    <header className="cl-nav">
      <nav className="cl-container cl-nav-inner" aria-label="Primary">
        <Link to="/" aria-label="Conclave home"><Logo /></Link>
        <div className="cl-nav-links">
          {LINKS.map(link => <a key={link.href} href={link.href}>{link.label}</a>)}
        </div>
        <div className="cl-nav-actions">
          <div className="cl-nav-theme"><ThemeSwitch compact /></div>
          <Link to="/login" className="cl-nav-signin">Sign in</Link>
          <Link to="/register" className="cl-button cl-button-primary">Get started <IconArrow aria-hidden="true" /></Link>
        </div>
        <button type="button" ref={menuButton} className="cl-nav-menu-button"
          onClick={() => setOpen(value => !value)} aria-expanded={open}
          aria-controls="landing-menu" aria-label={open ? 'Close menu' : 'Open menu'}>
          {open ? <IconClose aria-hidden="true" /> : <IconMenu aria-hidden="true" />}
        </button>
      </nav>
      {open && <div id="landing-menu" className="cl-mobile-menu">
        {LINKS.map(link => <a key={link.href} href={link.href} onClick={() => setOpen(false)}>{link.label}</a>)}
        <Link to="/login" onClick={() => setOpen(false)}>Sign in</Link>
        <div><ThemeSwitch compact /><Link to="/register" className="cl-button cl-button-primary" onClick={() => setOpen(false)}>Get started <IconArrow aria-hidden="true" /></Link></div>
      </div>}
    </header>
  );
}
