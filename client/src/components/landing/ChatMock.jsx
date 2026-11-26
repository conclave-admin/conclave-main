import { useId, useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import IconSend from "@/assets/icons/send.svg?react";
import IconDecisions from "@/assets/icons/decisions.svg?react";
import IconTasks from "@/assets/icons/tasks.svg?react";
import IconSuccess from "@/assets/icons/success.svg?react";
import coast from "@/assets/landing/conclave-coast-v2-768.webp";

const TABS = ["Conversations", "Decisions", "Tasks"];

export default function ChatMock() {
  const [tab, setTab] = useState(0);
  const id = useId();
  const tabRefs = useRef([]);
  const demoRef = useRef(null);

  useLayoutEffect(() => {
    const media = gsap.matchMedia();
    media.add(
      "(prefers-reduced-motion: no-preference)",
      () => {
        const panel = demoRef.current?.querySelector(
          ".cl-demo-panel:not([hidden])",
        );
        if (!panel) return;
        const parts = panel.querySelectorAll(
          [
            ".cl-demo-message",
            ".cl-demo-outgoing",
            ".cl-demo-composer",
            ".cl-organized-icon",
            ".cl-demo-organized > .cl-eyebrow",
            ".cl-demo-organized > h4",
            ".cl-demo-organized > p:not(.cl-eyebrow)",
            ".cl-demo-decision",
            ".cl-demo-task-list > div",
          ].join(", "),
        );
        gsap.from(parts, {
          y: 12,
          opacity: 0,
          duration: 0.42,
          stagger: 0.045,
          ease: "power2.out",
          clearProps: "transform,opacity",
        });
      },
      demoRef,
    );
    return () => media.revert();
  }, [tab]);

  function moveTab(event) {
    let next;
    if (event.key === "ArrowRight") next = (tab + 1) % TABS.length;
    if (event.key === "ArrowLeft") next = (tab + TABS.length - 1) % TABS.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = TABS.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <section id="product-preview" className="cl-product">
      <div className="cl-container">
        <div className="cl-product-intro">
          <div>
            <p className="cl-eyebrow">A closer look at Conclave</p>
            <h2>
              In the chat.
              <br />
              <em>Out in the world.</em>
            </h2>
          </div>
          <p>
            A plan for the weekend. A project taking shape. Keep the
            conversation and what comes next in the same place.
          </p>
        </div>
        <div
          className="cl-product-tabs"
          role="tablist"
          aria-label="Explore Conclave"
          onKeyDown={moveTab}
        >
          {TABS.map((label, index) => (
            <button
              key={label}
              type="button"
              role="tab"
              id={`${id}-tab-${index}`}
              aria-selected={tab === index}
              aria-controls={`${id}-panel-${index}`}
              tabIndex={tab === index ? 0 : -1}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              onClick={() => setTab(index)}
            >
              <span className="cl-tab-number">0{index + 1}</span>
              {label}
            </button>
          ))}
        </div>
        <div className="cl-product-window">
          <div className="cl-window-bar">
            <span>
              <i />
              <i />
              <i />
            </span>
            <p>Conclave · A place for your people</p>
            <span />
          </div>
          <div className="cl-product-layout">
            <aside className="cl-demo-sidebar" aria-hidden="true">
              <p className="cl-demo-brand">
                c<span>Conclave</span>
              </p>
              <span className="cl-demo-category">YOUR ROOMS</span>
              <p className="cl-demo-selected">
                # The weekend crew <b>3</b>
              </p>
              <p># Studio collective</p>
              <p># Ideas worth keeping</p>
              <span className="cl-demo-category">DIRECT MESSAGES</span>
              <p>
                <span className="cl-person cl-person-peach">A</span> Amara
                Okafor
              </p>
              <p>
                <span className="cl-person">J</span> Jamie Lee
              </p>
              <div className="cl-demo-profile">
                <span className="cl-person">Y</span>
                <div>
                  You<small>A little more connected.</small>
                </div>
                <span>↗</span>
              </div>
            </aside>
            <div ref={demoRef} className="cl-demo-main">
              <div className="cl-demo-header">
                <div>
                  <h3>
                    The weekend crew <span>☀️</span>
                  </h3>
                  <p>Good people. Excellent plans.</p>
                </div>
                <span className="cl-member-stack" aria-hidden="true">
                  <i>A</i>
                  <i>J</i>
                  <i>+2</i>
                </span>
              </div>
              {TABS.map((label, index) => (
                <div
                  key={label}
                  id={`${id}-panel-${index}`}
                  role="tabpanel"
                  aria-labelledby={`${id}-tab-${index}`}
                  hidden={tab !== index}
                  tabIndex={0}
                  className="cl-demo-panel"
                >
                  {index === 0 && (
                    <>
                      <p className="cl-demo-day">
                        Today · A new adventure in the making
                      </p>
                      <div className="cl-demo-message">
                        <span
                          className="cl-person cl-person-peach"
                          aria-hidden="true"
                        >
                          A
                        </span>
                        <div>
                          <p>
                            <strong>Amara</strong>
                            <small>10:24 AM</small>
                          </p>
                          <p>Found our spot for Saturday. Who’s in?</p>
                          <img
                            src={coast}
                            width="768"
                            height="512"
                            loading="lazy"
                            alt="A sunset picnic beside the sea, shared in the example conversation"
                          />
                          <span className="cl-demo-reaction">
                            💜 3 &nbsp; ☀️ 2
                          </span>
                        </div>
                      </div>
                      <div className="cl-demo-outgoing">
                        A view like that? Count me in.
                        <small>You · 10:26 AM · ✓✓</small>
                      </div>
                      <div className="cl-demo-composer" aria-hidden="true">
                        <span>+</span> Message the crew…
                        <IconSend />
                      </div>
                    </>
                  )}
                  {index === 1 && (
                    <div className="cl-demo-organized">
                      <span className="cl-organized-icon">
                        <IconDecisions aria-hidden="true" />
                      </span>
                      <p className="cl-eyebrow">
                        Less searching. More knowing.
                      </p>
                      <h4>Everyone on the same page.</h4>
                      <p>
                        The important part of the conversation, saved for later.
                      </p>
                      <div className="cl-demo-decision">
                        <span>
                          <IconSuccess aria-hidden="true" /> Decision recorded
                        </span>
                        <h5>Saturday belongs to the coast.</h5>
                        <p>
                          Meet at 9, take the scenic route, bring something to
                          share.
                        </p>
                        <footer>
                          Saved by Amara <span>The weekend crew</span>
                        </footer>
                      </div>
                    </div>
                  )}
                  {index === 2 && (
                    <div className="cl-demo-organized">
                      <span className="cl-organized-icon">
                        <IconTasks aria-hidden="true" />
                      </span>
                      <p className="cl-eyebrow">Good plans have a next step.</p>
                      <h4>From “we should” to “on it.”</h4>
                      <p>
                        Give the next step an owner, with the conversation
                        attached.
                      </p>
                      <div className="cl-demo-task-list">
                        {[
                          ["Book the train tickets", "Jamie", "Friday"],
                          ["Put together the playlist", "You", "Saturday"],
                          ["Bring the picnic essentials", "Amara", "Saturday"],
                        ].map(([task, person, day]) => (
                          <div key={task}>
                            <span
                              className="cl-demo-check"
                              aria-hidden="true"
                            />
                            <div>
                              <strong>{task}</strong>
                              <small>{person} · The weekend crew</small>
                            </div>
                            <span>{day}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <p className="cl-product-footnote">
          An interactive illustration of Conclave. Your people, your
          conversations, your next steps.
        </p>
      </div>
    </section>
  );
}
