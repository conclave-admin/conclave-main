import EmptyState from '@/components/ui/EmptyState';
import ThemeSwitch from '@/components/ui/ThemeSwitch';

/**
 * Settings.
 *
 * Appearance is the only section that exists so far; the rest is an empty
 * state rather than a set of disabled rows, for the same reason the other
 * placeholder pages are: half a settings screen reads as broken, not as
 * in-progress.
 *
 * The switch persists through ThemeContext, which writes the choice to
 * localStorage and keeps the class on <html> in sync. Nothing on this page
 * touches the DOM directly.
 */
export default function Settings() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-10 md:px-10 lg:px-16">
      <h1 className="text-h1 text-ink">Settings</h1>
      <p className="mt-2 text-body leading-relaxed text-muted">
        Account, appearance and workspace preferences.
      </p>

      <section className="mt-10 rounded-xl border border-line bg-surface p-6 md:p-8">
        <h2 className="text-h2 text-ink">Appearance</h2>
        <p className="mt-2 max-w-xl text-body leading-relaxed text-muted">
          Conclave follows your system appearance by default. Choosing Light or Dark overrides it
          for this device only; choosing System hands control back and keeps tracking as your
          system changes.
        </p>
        <div className="mt-5">
          <ThemeSwitch />
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-line bg-surface">
        <EmptyState
          title="The rest is on its way"
          description="Profile editing, notification preferences and workspace membership are being built. Until then, your profile is where you can see your own details."
        />
      </section>
    </div>
  );
}
