import IconMessage from '@/assets/icons/message.svg?react';
import IconDecisions from '@/assets/icons/decisions.svg?react';
import IconTasks from '@/assets/icons/tasks.svg?react';
import IconRecent from '@/assets/icons/recent.svg?react';

const FEATURES = [
  { icon: IconDecisions, number: '01', title: 'Give good ideas somewhere to land.', body: 'Record the decision where the conversation happened. Keep the outcome and its context together, ready when someone needs it.', tag: 'Decisions with context' },
  { icon: IconTasks, number: '02', title: 'From “we should” to “on it.”', body: 'Turn a message into an action item. Give the next step an owner, without losing the conversation that started it.', tag: 'Tasks from messages' },
  { icon: IconRecent, number: '03', title: 'Come back without catching up all day.', body: 'Find decisions, tasks and unread conversations in your catch-up digest. Get your bearings, then get on with your day.', tag: 'A clearer catch-up' },
];

export default function FeatureBlocks() {
  return (
    <section id="features" className="landing-section scroll-mt-24">
      <div className="grid items-end gap-6 md:grid-cols-2">
        <div><p className="landing-eyebrow">Close to your people. Clear on the plan.</p><h2 className="landing-heading mt-4 font-display">More room for the<br /> good stuff.</h2></div>
        <p className="max-w-md text-base leading-relaxed text-muted md:justify-self-end">Conversations should bring you closer to people and ideas. Conclave gives the important parts a place to stay.</p>
      </div>
      <article className="mt-10 grid gap-8 overflow-hidden rounded-2xl border border-line bg-surface p-6 md:grid-cols-2 md:gap-12 md:p-10">
        <div className="self-center"><IconMessage className="h-6 w-6 text-brand" aria-hidden="true" /><h3 className="mt-5 font-display text-display-3">For the everyday hello.<br />And everything after.</h3><p className="mt-4 max-w-md text-sm leading-relaxed text-muted">Talk one to one, bring everyone into a room, or share a photo that says it better. Replies, reactions and shared media keep it all connected.</p><div className="mt-6 flex flex-wrap gap-2">{['Direct messages','Rooms','Photos & files'].map(label => <span key={label} className="rounded-full border border-line px-3 py-1.5 text-metadata text-muted">{label}</span>)}</div></div>
        <div className="rounded-xl bg-canvas p-5 md:p-8" aria-hidden="true"><p className="text-[11px] font-semibold uppercase tracking-wider text-muted">The weekend crew</p><div className="mt-5 max-w-64 rounded-xl rounded-tl-none bg-surface p-3 text-sm leading-relaxed">Same place on Saturday? ☀️<span className="mt-2 block text-[10px] text-muted">Amara · 4:12 PM</span></div><div className="ml-auto mt-4 max-w-64 rounded-xl rounded-br-none bg-brand p-3 text-sm leading-relaxed text-surface">Wouldn’t miss it. Bringing the playlist.<span className="mt-2 block text-right text-[10px] opacity-80">4:14 PM · ✓✓</span></div><span className="ml-auto mr-3 mt-1 block w-fit rounded-full border border-line bg-surface px-2.5 py-1 text-xs">💜 3</span></div>
      </article>
      <div className="mt-5 grid gap-5 md:grid-cols-3">
        {FEATURES.map(({icon: Icon, ...feature}) => <article key={feature.number} className="flex flex-col rounded-2xl border border-line bg-surface p-6 md:p-7"><div className="flex items-center justify-between"><Icon className="h-5 w-5 text-brand" aria-hidden="true" /><span className="text-metadata text-muted">{feature.number}</span></div><h3 className="mt-8 font-display text-display-3">{feature.title}</h3><p className="mb-8 mt-4 text-sm leading-relaxed text-muted">{feature.body}</p><p className="mt-auto border-t border-line pt-4 text-metadata font-medium text-brand">{feature.tag}</p></article>)}
      </div>
    </section>
  );
}
