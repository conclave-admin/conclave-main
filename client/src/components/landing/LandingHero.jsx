import { Link } from "react-router-dom";
import IconArrow from "@/assets/icons/arrow-right.svg?react";
import IconMessage from "@/assets/icons/message.svg?react";
import IconSuccess from "@/assets/icons/success.svg?react";
import studio from "@/assets/landing/conclave-studio-v2-1536.webp";
import studioSmall from "@/assets/landing/conclave-studio-v2-768.webp";

export default function LandingHero() {
  return (
    <section className="cl-hero cl-container">
      <div className="cl-hero-copy">
        <p className="cl-eyebrow">
          <span /> A space for your kind of together
        </p>
        <h1>
          <span className="cl-title-line">
            <span className="cl-title-word">Good things</span>
          </span>
          <span className="cl-title-line">
            <span className="cl-title-word">happen</span>
          </span>
          <span className="cl-title-line">
            <em className="cl-title-word">together.</em>
          </span>
        </h1>
        <p className="cl-hero-description">
          The easy rhythm of a group chat. The clarity to turn an idea into a
          plan. Bring your people and your possibilities together with Conclave.
        </p>
        <div className="cl-hero-actions">
          <Link to="/register" className="cl-button cl-button-primary">
            Find your people <IconArrow aria-hidden="true" />
          </Link>
          <a href="#product-preview" className="cl-text-link">
            Meet Conclave <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="cl-hero-note">
          <span className="cl-note-icon">
            <IconMessage aria-hidden="true" />
          </span>
          <p>
            For the everyday catch-up.
            <br />
            <strong>And the next big thing.</strong>
          </p>
        </div>
      </div>

      <div className="cl-hero-scene">
        <div className="cl-photo-label">
          <span /> The best ideas start here.
        </div>
        <img
          src={studio}
          srcSet={`${studioSmall} 768w, ${studio} 1536w`}
          sizes="(min-width: 900px) 52vw, 100vw"
          width="1536"
          height="1024"
          alt="Friends sharing ideas around a sunny studio table"
          fetchPriority="high"
          className="cl-hero-photo"
        />
        <div className="cl-scene-caption">
          A little conversation.
          <br />
          <em>A world of possibility.</em>
        </div>
        <div className="cl-floating-message" aria-hidden="true">
          <span className="cl-person cl-person-peach">A</span>
          <div>
            <strong>
              Amara <small>just now</small>
            </strong>
            <p>What if we made it happen? ✨</p>
          </div>
          <span className="cl-reaction">💜</span>
        </div>
        <div className="cl-floating-decision" aria-hidden="true">
          <span>
            <IconSuccess />
          </span>
          <div>
            <strong>From an idea to a plan.</strong>
            <p>Decision saved. Everyone in the loop.</p>
          </div>
        </div>
        <span className="cl-hero-spark" aria-hidden="true">
          ✳
        </span>
      </div>
    </section>
  );
}
