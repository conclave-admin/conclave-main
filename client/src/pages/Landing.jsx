import FeatureBlocks from '@/components/landing/FeatureBlocks';
import HowItWorks from '@/components/landing/HowItWorks';
import LandingCta from '@/components/landing/LandingCta';
import LandingFooter from '@/components/landing/LandingFooter';
import LandingHero from '@/components/landing/LandingHero';
import LandingNav from '@/components/landing/LandingNav';

export default function Landing() {
  return (
    <div className="landing min-h-screen bg-canvas text-ink">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:p-4 focus:ring-2 focus:ring-brand">Skip to content</a>
      <LandingNav />
      <main id="main-content">
        <LandingHero />
        <FeatureBlocks />
        <HowItWorks />
        <LandingCta />
      </main>
      <LandingFooter />
    </div>
  );
}
