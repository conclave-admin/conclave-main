import { useRef } from "react";
import useLandingMotion from "@/hooks/useLandingMotion";
import FeatureBlocks from "@/components/landing/FeatureBlocks";
import ChatMock from "@/components/landing/ChatMock";
import HowItWorks from "@/components/landing/HowItWorks";
import LandingCta from "@/components/landing/LandingCta";
import LandingFooter from "@/components/landing/LandingFooter";
import LandingHero from "@/components/landing/LandingHero";
import LandingNav from "@/components/landing/LandingNav";
import "@/styles/landing.css";

export default function Landing() {
  const rootRef = useRef(null);
  useLandingMotion(rootRef);

  return (
    <div ref={rootRef} className="landing cl-landing">
      <a href="#main-content" className="cl-skip-link">
        Skip to content
      </a>
      <LandingNav />
      <main id="main-content">
        <LandingHero />
        <FeatureBlocks />
        <ChatMock />
        <HowItWorks />
        <LandingCta />
      </main>
      <LandingFooter />
    </div>
  );
}
