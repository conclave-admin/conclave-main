import { Link } from 'react-router-dom';
import ChatMock from './ChatMock';

/**
 * The hero.
 *
 * The tagline is italicised on "survives" — Instrument Serif's italic is the
 * reason that face was chosen over a second grotesque, and a display face with
 * an unused italic is half a typeface.
 *
 * Deliberately not `data-reveal` animated: everything above the fold should be
 * there on first paint. Scroll-triggered reveals that also fire for content
 * already on screen read as a page that failed to load, then recovered.
 */
export default function LandingHero() {
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto max-w-7xl px-6 pb-24 pt-16 md:px-10 md:pb-32 md:pt-24 lg:px-16">
        <div className="grid items-center gap-14 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-7">
            <p className="text-label uppercase tracking-widest text-brand">Private team messaging</p>

            <h1 className="mt-5 font-display text-display-1 text-ink">
              Messaging that <em className="italic text-brand">survives</em> the scroll
            </h1>

            <p className="mt-7 max-w-xl text-body leading-relaxed text-muted md:text-base">
              Conclave keeps decisions, action items and the catch-up digest inside the
              conversation, so the important part does not get pushed a thousand messages up
              the list by lunchtime.
            </p>

            <div className="mt-9 flex flex-col gap-3 md:flex-row">
              <Link
                to="/register"
                className="inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-brand px-6 text-sm font-semibold text-surface transition-colors hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 md:w-auto"
              >
                Get started
              </Link>
              <a
                href="#features"
                className="inline-flex min-h-12 w-full items-center justify-center rounded-lg border border-line bg-surface px-6 text-sm font-semibold text-ink transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 md:w-auto"
              >
                See what it does
              </a>
            </div>

            <p className="mt-6 text-metadata text-muted">
              Free while in beta · No card, no trial timer
            </p>
          </div>

          <div className="lg:col-span-5">
            <ChatMock />
          </div>
        </div>
      </div>
    </section>
  );
}
