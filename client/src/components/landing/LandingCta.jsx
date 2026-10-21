import { Link } from 'react-router-dom';
import IconArrow from '@/assets/icons/arrow-right.svg?react';

export default function LandingCta() {
  return (
    <section className="landing-section">
      <div className="rounded-2xl bg-ink px-6 py-14 text-center text-canvas md:rounded-[28px] md:px-16 md:py-20">
        <p className="text-metadata uppercase tracking-[0.18em] opacity-70">A place for your people</p>
        <h2 className="landing-heading mx-auto mt-5 max-w-2xl font-display">Your next good thing<br /> starts with a conversation.</h2>
        <p className="mx-auto mt-5 max-w-md text-base leading-relaxed opacity-75">Bring the people. Share the idea.<br />See where it takes you.</p>
        <Link to="/register" className="landing-button mt-8 bg-canvas text-ink hover:opacity-90">Get started with Conclave <IconArrow className="h-4 w-4" aria-hidden="true" /></Link>
        <p className="mt-5 text-metadata opacity-75">Already found your people here? <Link to="/login" className="underline underline-offset-4 hover:opacity-75">Sign in</Link></p>
      </div>
    </section>
  );
}
