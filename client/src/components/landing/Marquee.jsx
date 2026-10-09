const ITEMS = ['Decisions', 'Action items', 'Catch-up digest', 'Mentions', 'Rooms', 'Threads', 'Tasks'];

/**
 * The vocabulary strip between sections.
 *
 * Purely textural — it repeats words the feature section already says properly,
 * so it is hidden from assistive tech rather than read out a second time.
 *
 * Seamless because the track holds two identical groups and translates by
 * exactly half its own width. The spacing lives inside each item as trailing
 * padding rather than as a gap between the two groups: a `gap` sits between
 * them, which makes the track wider than two groups, and a 50% translate would
 * then land mid-gap and stutter once per loop.
 */
export default function Marquee() {
  return (
    <div className="overflow-hidden border-y border-line bg-surface py-5" aria-hidden="true">
      <div className="flex w-max animate-marquee motion-reduce:animate-none">
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0">
            {ITEMS.map((item) => (
              <span
                key={item}
                className="inline-flex shrink-0 items-center gap-6 pr-10 font-display text-display-3 text-muted"
              >
                {item}
                <span className="h-1.5 w-1.5 rounded-full bg-brand" />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
