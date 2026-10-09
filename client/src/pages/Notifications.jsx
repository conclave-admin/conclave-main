import EmptyState from '@/components/ui/EmptyState';

/**
 * Placeholder for notifications.
 *
 * The page is a stub, but the state behind it is not: `NotificationsProvider`
 * and the drafted components in docs/frontend.md section 10 are waiting to be
 * mounted here. Until then this is an honest empty state rather than a
 * placeholder line that told a visitor nothing and used a grey that is not in
 * the palette.
 */
export default function Notifications() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-10 md:px-10 lg:px-16">
      <h1 className="text-h1 text-ink">Notifications</h1>
      <p className="mt-2 text-body leading-relaxed text-muted">
        Mentions, decisions and task changes will collect here.
      </p>

      <div className="mt-10 rounded-xl border border-line bg-surface">
        <EmptyState
          title="Nothing to catch up on"
          description="You are up to date. Mentions, new decisions in your rooms and tasks assigned to you will appear here as they happen."
        />
      </div>
    </div>
  );
}
