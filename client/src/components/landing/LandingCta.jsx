import { Link } from 'react-router-dom';

/**
 * The closing call to action.
 *
 * Reuses the tagline rather than inventing a second one — a landing page that
 * says something different in its hero and its closer is harder to remember
 * than one that says it once, twice.
 */
export default function LandingCta() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-24 md:px-10 md:py-32 lg:px-16">
      <div className="rounded-2xl border border-line bg-brand-soft px-8 py-16 text-center md:px-16 md:py-24">
        <h2 className="mx-auto max-w-3xl font-display text-display-2 text-ink">
          Messaging that survives the scroll
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-body leading-relaxed text-muted">
          Decisions, action items and a catch-up digest, built into the conversation instead of
          bolted onto it. Free while it is in beta.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 md:flex-row">
          <Link
            to="/register"
            className="inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-brand px-6 text-sm font-semibold text-surface transition-colors hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 md:w-auto"
          >
            Get started
          </Link>
          <Link
            to="/login"
            className="inline-flex min-h-12 w-full items-center justify-center rounded-lg border border-line bg-surface px-6 text-sm font-semibold text-ink transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 md:w-auto"
          >
            Sign in
          </Link>
        </div>
      </div>
    </section>
  );
}
