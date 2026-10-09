import IconDecisions from '@/assets/icons/decisions.svg?react';
import IconTasks from '@/assets/icons/tasks.svg?react';
import IconRecent from '@/assets/icons/recent.svg?react';

/**
 * The three product differentiators, in the order they happen in a thread:
 * something is decided, someone picks up the work, and anyone who was away
 * finds out later. Copy is deliberately about the outcome rather than the
 * feature — "it stops being something someone half-remembers" is the pitch,
 * not the button.
 */
const FEATURES = [
  {
    icon: IconDecisions,
    title: 'Decisions',
    body: 'Turn a thread into a decision without leaving it. The outcome is recorded against the room, so it stops being something someone half-remembers.',
  },
  {
    icon: IconTasks,
    title: 'Action items',
    body: 'Pull a task straight out of a message. It keeps its origin, so whoever picks it up can see exactly what it came from.',
  },
  {
    icon: IconRecent,
    title: 'Catch-up digest',
    body: 'Come back after a day away and read what actually changed — decisions, tasks, unread — instead of scrolling a wall of messages.',
  },
];

export default function FeatureBlocks() {
  return (
    <section id="features" className="mx-auto max-w-7xl scroll-mt-20 px-6 py-24 md:px-10 md:py-32 lg:px-16">
      <div className="max-w-2xl">
        <p className="text-label uppercase tracking-widest text-brand">What it is for</p>
        <h2 className="mt-4 font-display text-display-2 text-ink">
          The parts of a conversation that usually get lost
        </h2>
      </div>

      <div className="mt-14 grid gap-6 md:grid-cols-3">
        {FEATURES.map((feature) => (
          <div
            key={feature.title}
            className="rounded-xl border border-line bg-surface p-8 transition-colors hover:border-brand/40"
          >
            <span className="grid h-12 w-12 place-items-center rounded-lg bg-brand-soft text-brand">
              <feature.icon className="h-6 w-6" aria-hidden="true" />
            </span>
            <h3 className="mt-6 font-display text-display-3 text-ink">{feature.title}</h3>
            <p className="mt-3 text-body leading-relaxed text-muted">{feature.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
