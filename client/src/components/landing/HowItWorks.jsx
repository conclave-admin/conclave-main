const STEPS = [
  {
    title: 'Start a room',
    body: 'Bring the people who need to be there. A direct message is two clicks; a group takes a name.',
  },
  {
    title: 'Decide in the thread',
    body: 'When the conversation lands somewhere, record it as a decision where it was said — not in a document nobody opens.',
  },
  {
    title: 'Catch up on the rest',
    body: 'The digest carries the decisions, the new tasks and the unread, so returning costs a minute rather than an afternoon.',
  },
];

/**
 * The "how it works" strip.
 *
 * Numbers rather than icons: the steps are a sequence, and a numeral says that
 * in a way three unrelated pictograms cannot. The connecting rule between them
 * is decorative and hidden from assistive tech; the ordered list carries the
 * structure instead.
 */
export default function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-20 border-y border-line bg-surface">
      <div className="mx-auto max-w-7xl px-6 py-24 md:px-10 md:py-28 lg:px-16">
        <div className="max-w-2xl">
          <p className="text-label uppercase tracking-widest text-brand">How it works</p>
          <h2 className="mt-4 font-display text-display-2 text-ink">Three steps, and none of them are a migration</h2>
        </div>

        <ol className="mt-14 grid gap-10 md:grid-cols-3 md:gap-8">
          {STEPS.map((step, index) => (
            <li key={step.title} className="relative">
              <span className="font-display text-display-3 text-brand" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="mt-3 text-h2 text-ink">{step.title}</h3>
              <p className="mt-2 max-w-sm text-body leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
