import { Link } from 'react-router-dom';
import Logo from '@/components/landing/Logo';

/**
 * The shell behind the footer's Pricing, Privacy and Terms links.
 *
 * An honest empty state rather than placeholder prose. Those three pages need
 * copy that has not been written, and inventing pricing or privacy terms —
 * even as filler — is the kind of thing that survives an accidental deploy.
 */
export default function StaticPage({ title }) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-7xl items-center px-6 md:px-10 lg:px-16">
          {/* Link, not an anchor: an `<a href="/">` unloads the document and
              re-downloads the bundle for a route that is already mounted. */}
          <Link to="/" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
            <Logo />
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-24 md:px-10 lg:px-16">
        <h1 className="font-display text-display-2 text-ink">{title}</h1>
        <p className="mt-5 max-w-xl text-body leading-relaxed text-muted">
          This page is a placeholder. It has not been written yet, and nothing here should be
          read as a commitment.
        </p>
      </main>
    </div>
  );
}
