import { Link } from "react-router-dom";
import Logo from "@/components/landing/Logo";

export default function AuthLayout({
  title,
  description,
  alternateText,
  alternateLink,
  alternateLabel,
  children,
}) {
  return (
    <main className="grid min-h-dvh bg-surface lg:grid-cols-2">
      <aside
        className="auth-art relative hidden flex-col justify-between overflow-hidden p-14 lg:flex"
        aria-label="About Conclave"
      >
        <Link to="/" className="w-fit rounded-xl bg-white p-3">
          <Logo />
        </Link>
        <div className="relative z-10 max-w-lg py-16">
          <p className="mb-6 text-xs font-semibold uppercase tracking-[.22em] text-white/60">
            Your people. Your space.
          </p>
          <h2 className="text-5xl font-semibold leading-[1.12] tracking-tight">
            Good conversations.
            <br />
            Closer connections.
          </h2>
          <p className="mt-6 max-w-sm text-base leading-7 text-white/70">
            From a quick hello to the next big idea. Keep your people, plans,
            and conversations together.
          </p>
          <div aria-hidden="true" className="mt-12 space-y-4">
            <div className="w-4/5 rounded-2xl rounded-bl-md border border-white/10 bg-white/10 p-5">
              <span className="mb-3 block h-2 w-20 rounded bg-white/40" />
              <span className="block h-2 w-4/5 rounded bg-white/20" />
              <span className="mt-2 block h-2 w-2/3 rounded bg-white/20" />
            </div>
            <div className="ml-auto w-3/5 rounded-2xl rounded-br-md bg-white/90 p-5">
              <span className="block h-2 w-4/5 rounded bg-purple-400/60" />
              <span className="mt-2 block h-2 w-2/3 rounded bg-purple-300/60" />
            </div>
          </div>
        </div>
        <p className="text-sm text-white/50">
          Conclave · Make room for connection.
        </p>
      </aside>
      <div className="flex min-w-0 flex-col items-center justify-center px-6 py-12 md:px-12">
        <div className="w-full max-w-md">
          <Link
            to="/"
            className="mb-10 inline-flex rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 lg:hidden"
          >
            <Logo />
          </Link>
          <section>
            {title && (
              <h1 className="text-3xl font-bold tracking-tight text-ink">
                {title}
              </h1>
            )}
            {description && (
              <p className="mt-3 text-sm leading-6 text-muted">{description}</p>
            )}
            <div className="mt-8">{children}</div>
            {alternateText && (
              <p className="mt-8 border-t border-line pt-6 text-sm text-muted">
                {alternateText}{" "}
                {alternateLink && (
                  <Link
                    className="font-semibold text-brand hover:underline"
                    to={alternateLink}
                  >
                    {alternateLabel}
                  </Link>
                )}
              </p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
