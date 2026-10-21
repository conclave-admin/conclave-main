import { Link } from 'react-router-dom';
import IconArrow from '@/assets/icons/arrow-right.svg?react';
import ChatMock from './ChatMock';

export default function LandingHero() {
  return (
    <section className="landing-hero px-5 pb-14 pt-14 md:px-10 md:pb-20 md:pt-20">
      <div className="mx-auto max-w-4xl text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-2 text-metadata text-muted"><span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" /> A little more connected. A lot more in sync.</p>
        <h1 className="landing-headline mt-7 font-display">Where conversations<br className="hidden md:block" /> become <em className="text-brand">what’s next.</em></h1>
        <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted md:text-lg">A quick hello. A shared idea. A plan coming together. Bring your people, messages and next steps into one place with Conclave.</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 md:flex-row">
          <Link to="/register" className="landing-button bg-brand text-surface hover:bg-brand/90">Get started <IconArrow className="h-4 w-4" aria-hidden="true" /></Link>
          <a href="#product-preview" className="landing-button border border-line bg-surface text-ink hover:border-brand/50">Take a look inside <span aria-hidden="true">↘</span></a>
        </div>
        <p className="mt-4 text-metadata text-muted">Personal conversations. Room for teamwork.</p>
      </div>
      <figure id="product-preview" className="mx-auto mt-12 max-w-6xl scroll-mt-28 md:mt-16">
        <ChatMock />
        <figcaption className="mt-5 text-center text-metadata leading-relaxed text-muted">An illustrative look at Conclave. Messages, decisions and the next step, together.</figcaption>
      </figure>
      <div className="mx-auto mt-10 flex max-w-4xl flex-wrap items-center justify-center gap-x-8 gap-y-4 border-y border-line py-5 text-label text-muted md:gap-x-12">
        {['Direct messages', 'Group conversations', 'Shared media', 'Decisions & tasks'].map(label => <span key={label} className="inline-flex items-center gap-2"><span className="h-1 w-1 rounded-full bg-brand" aria-hidden="true" />{label}</span>)}
      </div>
    </section>
  );
}
