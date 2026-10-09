import { Link } from 'react-router-dom';
import GridLines from '@/components/landing/GridLines';
import Logo from '@/components/landing/Logo';

/**
 * The shared frame for sign in and sign up.
 *
 * Uses the display face for the heading, which deliberately ties auth to the
 * landing rather than to the app: a visitor arrives from the marketing page,
 * passes through here, and lands in the chat list. Keeping the heading in the
 * same voice as the hero makes that a continuation rather than a hard cut.
 *
 * GridLines runs behind it for the same reason — it is the same page, one
 * step further along.
 *
 * @param {string} title
 * @param {string} description
 * @param {string} [alternateText]
 * @param {string} [alternateLink]
 * @param {string} [alternateLabel]
 */
export default function AuthLayout({ title, description, alternateText, alternateLink, alternateLabel, children }) {
  return (
    <main className="relative grid min-h-dvh place-items-center bg-canvas px-5 py-16">
      <GridLines className="z-0" />

      <div className="relative z-10 w-full max-w-md">
        <Link
          to="/"
          className="mb-8 inline-flex rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
        >
          <Logo />
        </Link>

        <section className="rounded-xl border border-line bg-surface p-8 shadow-modal">
          <h1 className="font-display text-display-3 text-ink">{title}</h1>
          <p className="mt-3 text-body leading-relaxed text-muted">{description}</p>

          <div className="mt-8">{children}</div>

          {alternateText && (
            <div className="mt-7 border-t border-line pt-7 text-body text-muted">
              <span>{alternateText}</span>
              {alternateLink && (
                <>
                  {' '}
                  <Link className="font-semibold text-brand hover:underline" to={alternateLink}>
                    {alternateLabel}
                  </Link>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
