import { Link } from 'react-router-dom';
import ThemeSwitch from '@/components/ui/ThemeSwitch';
import Logo from './Logo';

const LINKS = [
  { to: '/pricing', label: 'Pricing' },
  { to: '/privacy', label: 'Privacy' },
  { to: '/terms', label: 'Terms' },
];

export default function LandingFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto max-w-6xl px-5 py-10 md:px-10">
        <div className="flex flex-col justify-between gap-7 md:flex-row md:items-start">
          <div>
            <Link to="/" aria-label="Conclave home" className="inline-flex rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"><Logo /></Link>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted">A little more connected.<br />A lot more in sync.</p>
          </div>
          <nav className="flex flex-wrap gap-x-7 gap-y-4" aria-label="Footer">
            {LINKS.map(link => <Link key={link.to} to={link.to} className="rounded text-label text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">{link.label}</Link>)}
          </nav>
        </div>
        <div className="mt-9 flex flex-col gap-5 border-t border-line pt-6 md:flex-row md:items-center md:justify-between">
          <p className="text-metadata text-muted">© {new Date().getFullYear()} Conclave. A space for what’s next.</p>
          <div className="w-fit lg:hidden"><ThemeSwitch compact /></div>
          <p className="text-metadata text-muted">Made for conversations that matter.</p>
        </div>
      </div>
    </footer>
  );
}
