import { Link } from 'react-router-dom';
import Logo from './Logo';

/**
 * Landing footer.
 *
 * Pricing, Privacy and Terms are placeholders by decision: they render an
 * empty shell rather than a written page. Pricing especially needs copy that
 * does not exist yet, and a link to a page full of lorem ipsum is a worse
 * first impression than an honest shell.
 */
const LEGAL = [
  { to: '/pricing', label: 'Pricing' },
  { to: '/privacy', label: 'Privacy' },
  { to: '/terms', label: 'Terms' },
];

export default function LandingFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-6 py-12 md:flex-row md:items-center md:justify-between md:px-10 lg:px-16">
        <Logo />

        <nav className="flex flex-wrap gap-x-8 gap-y-3" aria-label="Footer">
          {LEGAL.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="text-label text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <p className="text-metadata text-muted">© {new Date().getFullYear()} Conclave</p>
      </div>
    </footer>
  );
}
