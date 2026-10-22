import { useLayoutEffect } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

// Imported only by the lazy public route. Every tween, listener and trigger
// belongs to this mount; matchMedia also reverts them on preference changes.
export default function useLandingMotion(rootRef) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    gsap.registerPlugin(ScrollTrigger);
    const media = gsap.matchMedia();

    media.add({
      motion: '(prefers-reduced-motion: no-preference)',
      desktop: '(min-width: 900px)',
      pointer: '(hover: hover) and (pointer: fine)',
    }, context => {
      if (!context.conditions.motion) return undefined;
      const desktop = context.conditions.desktop;
      const select = gsap.utils.selector(root);
      const distance = desktop ? 30 : 16;
      const duration = desktop ? 0.7 : 0.48;
      const listeners = [];

      const hero = gsap.timeline({ defaults: { ease: 'power3.out' } });
      hero.from(select('.cl-hero-copy > .cl-eyebrow'), { y: 10, opacity: 0, duration: 0.45 })
        .from(select('.cl-title-word'), {
          yPercent: 105, opacity: 0, duration: desktop ? 0.95 : 0.65,
          stagger: 0.1, clearProps: 'transform,opacity',
        }, 0.08)
        .from(select('.cl-hero-description, .cl-hero-actions, .cl-hero-note'), {
          y: 16, opacity: 0, duration: 0.6, stagger: 0.1,
          clearProps: 'transform,opacity',
        }, 0.38)
        .from(select('.cl-hero-photo'), {
          opacity: 0.25, y: distance, duration: 1,
          clearProps: 'transform,opacity',
        }, 0.12)
        .from(select('.cl-photo-label, .cl-scene-caption'), {
          y: 12, opacity: 0, duration: 0.6, stagger: 0.12,
          clearProps: 'transform,opacity',
        }, 0.48)
        .from(select('.cl-floating-message, .cl-floating-decision'), {
          y: 28, rotation: '-=5', opacity: 0, duration: 0.8,
          stagger: 0.17, ease: 'back.out(1.2)', clearProps: 'transform,opacity',
        }, 0.65)
        .from(select('.cl-hero-spark'), { scale: 0.4, opacity: 0, duration: 0.8 }, 0.55);

      function reveal(trigger, targets, options = {}) {
        return gsap.from(targets, {
          y: distance, opacity: 0, duration, ease: 'power3.out',
          stagger: 0.09, clearProps: 'transform,opacity', ...options,
          scrollTrigger: { trigger, start: 'top 88%', once: true },
        });
      }

      reveal(select('.cl-capabilities')[0], select('.cl-capabilities p'), { y: 12 });
      reveal(select('.cl-section-intro')[0], select('.cl-section-intro > *'));
      select('.cl-feature-row').forEach(row => {
        reveal(row, row.querySelectorAll('.cl-feature-copy > *'), { stagger: 0.07 });
        const scene = row.querySelector('.cl-life-photo, .cl-work-scene');
        reveal(scene, scene.querySelector('img'), { y: desktop ? 24 : 12, duration: 0.85 });
        reveal(scene, scene.querySelector('.cl-photo-chat, .cl-work-card'), {
          y: 30, rotation: desktop ? '+=3' : '+=1', duration: 0.9,
        });
      });
      reveal(select('.cl-product-intro')[0], select('.cl-product-intro > *'));
      reveal(select('.cl-product-tabs')[0], select('.cl-product-tabs button'), { y: 12 });
      reveal(select('.cl-product-window')[0], select('.cl-product-window'), {
        y: desktop ? 50 : 20, duration: 0.9,
      });
      reveal(select('.cl-how-heading')[0], select('.cl-how-heading > *'));
      select('.cl-steps li').forEach(step => reveal(step, step));
      reveal(select('.cl-cta')[0], select('.cl-cta > .cl-eyebrow, .cl-cta h2, .cl-cta > p:not(.cl-eyebrow), .cl-cta > a'));

      if (desktop) {
        // Decoration tracks scroll only on larger screens. No continuous loops,
        // scroll interception or pinned sections; mobile keeps short entrances.
        gsap.to(select('.cl-hero-spark'), {
          rotation: '+=100', y: 45, ease: 'none',
          scrollTrigger: { trigger: select('.cl-hero')[0], start: 'top top', end: 'bottom top', scrub: 0.8 },
        });
        gsap.fromTo(select('.cl-orbit-one'), { x: -35 }, {
          x: 20, ease: 'none',
          scrollTrigger: { trigger: select('.cl-cta')[0], start: 'top bottom', end: 'bottom top', scrub: 1 },
        });
        gsap.fromTo(select('.cl-orbit-two'), { x: 35 }, {
          x: -20, ease: 'none',
          scrollTrigger: { trigger: select('.cl-cta')[0], start: 'top bottom', end: 'bottom top', scrub: 1 },
        });
      }

      if (desktop && context.conditions.pointer) {
        const cta = select('.cl-cta')[0];
        const rotate = gsap.quickTo(select('.cl-cta-spark')[0], 'rotation', { duration: 0.85, ease: 'power3.out' });
        const enter = () => rotate(105);
        const leave = () => rotate(15);
        cta.addEventListener('pointerenter', enter);
        cta.addEventListener('pointerleave', leave);
        listeners.push(() => {
          cta.removeEventListener('pointerenter', enter);
          cta.removeEventListener('pointerleave', leave);
        });
      }

      let active = true;
      const refresh = () => { if (active) ScrollTrigger.refresh(); };
      // Font metrics and lazy images can settle after ScrollTrigger initializes.
      root.addEventListener('load', refresh, true);
      document.fonts?.ready.then(refresh);
      return () => {
        active = false;
        root.removeEventListener('load', refresh, true);
        listeners.forEach(remove => remove());
      };
    }, root);

    return () => media.revert();
  }, [rootRef]);
}
