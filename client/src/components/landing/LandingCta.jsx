import { Link } from "react-router-dom";
import IconArrow from "@/assets/icons/arrow-right.svg?react";

export default function LandingCta() {
  return (
    <section className="cl-cta-wrap cl-container">
      <div className="cl-cta">
        <span className="cl-cta-orbit cl-orbit-one" aria-hidden="true" />
        <span className="cl-cta-orbit cl-orbit-two" aria-hidden="true" />
        <span className="cl-cta-spark" aria-hidden="true">
          ✳
        </span>
        <p className="cl-eyebrow">Your people. Your space. Your Conclave.</p>
        <h2>
          Let’s see what
          <br />
          happens <em>together.</em>
        </h2>
        <p>
          Every good thing starts somewhere.
          <br />
          Start with a conversation.
        </p>
        <Link to="/register" className="cl-button cl-button-white">
          Get started with Conclave <IconArrow aria-hidden="true" />
        </Link>
        <p className="cl-cta-signin">
          Already here? <Link to="/login">Welcome back.</Link>
        </p>
      </div>
    </section>
  );
}
