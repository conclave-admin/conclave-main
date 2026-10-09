import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import FeatureBlocks from '@/components/landing/FeatureBlocks';
import GridLines from '@/components/landing/GridLines';
import HowItWorks from '@/components/landing/HowItWorks';
import LandingCta from '@/components/landing/LandingCta';
import LandingFooter from '@/components/landing/LandingFooter';
import LandingHero from '@/components/landing/LandingHero';
import LandingNav from '@/components/landing/LandingNav';
import Marquee from '@/components/landing/Marquee';

/**
 * The public landing page.
 *
 * GSAP is imported here rather than in main.jsx, and this route is lazy-loaded
 * from App, so the library rides in this chunk and a signed-in user on the chat
 * list never downloads it. That is the whole reason for the split — "landing
 * page only" is a loading property, not just a usage one.
 *
 * The reveals are scroll-triggered, fire once, and are skipped entirely when
 * the visitor prefers reduced motion. Skipping matters more than it sounds:
 * `gsap.from` writes an inline style, so without the guard a reduced-motion
 * visitor would get elements pinned at opacity 0 by JavaScript and revealed by
 * JavaScript — motion they asked not to have.
 *
 * The hero is deliberately outside this: above-the-fold content that animates
 * in reads as a broken load rather than as intent.
 */
export default function Landing() {
  const rootRef = useRef(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    gsap.registerPlugin(ScrollTrigger);

    const context = gsap.context(() => {
      gsap.utils.toArray('[data-reveal]').forEach((element) => {
        gsap.from(element, {
          y: 28,
          opacity: 0,
          duration: 0.7,
          ease: 'power2.out',
          scrollTrigger: {
            trigger: element,
            start: 'top 85%',
            once: true,
          },
        });
      });
    }, rootRef);

    // Reverts the inline styles and kills the triggers. Without this, leaving
    // the route leaves orphaned ScrollTriggers pointing at unmounted nodes.
    return () => context.revert();
  }, []);

  return (
    <div ref={rootRef} className="relative min-h-screen bg-canvas">
      <GridLines className="z-0" />

      <div className="relative z-10">
        <LandingNav />
        <main>
          <LandingHero />
          <div data-reveal>
            <Marquee />
          </div>
          <div data-reveal>
            <FeatureBlocks />
          </div>
          <div data-reveal>
            <HowItWorks />
          </div>
          <div data-reveal>
            <LandingCta />
          </div>
        </main>
        <LandingFooter />
      </div>
    </div>
  );
}
