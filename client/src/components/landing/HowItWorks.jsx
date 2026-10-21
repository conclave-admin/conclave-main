const STEPS = [
  { title: 'Make yourself at home.', body: 'Create your account and bring your people along. Start with a direct message or a room for the whole group.' },
  { title: 'Let the conversation flow.', body: 'Share the thought, the photo, the first draft. Keep replies connected and useful things pinned.' },
  { title: 'Keep the good parts moving.', body: 'Capture a decision, pick up a task, or catch up after some time away. Your context comes with you.' },
];

export default function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-24 border-y border-line bg-surface/50">
      <div className="landing-section">
        <div className="mx-auto max-w-xl text-center"><p className="landing-eyebrow">Settle in. Start something.</p><h2 className="landing-heading mt-4 font-display">It starts with a hello.</h2><p className="mt-5 text-base leading-relaxed text-muted">No complicated setup. Just a place for your people and whatever comes next.</p></div>
        <ol className="mt-12 grid gap-8 md:grid-cols-3 md:gap-10">
          {STEPS.map((step,index) => <li key={step.title} className="border-t border-line pt-5"><span className="font-display text-3xl italic text-brand" aria-hidden="true">0{index+1}</span><h3 className="mt-5 text-base font-semibold">{step.title}</h3><p className="mt-3 text-sm leading-relaxed text-muted">{step.body}</p></li>)}
        </ol>
      </div>
    </section>
  );
}
