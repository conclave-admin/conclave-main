import IconMessage from "@/assets/icons/message.svg?react";
import IconDecisions from "@/assets/icons/decisions.svg?react";
import IconRecent from "@/assets/icons/recent.svg?react";

const STEPS = [
  {
    Icon: IconMessage,
    title: "Bring your people.",
    body: "A direct message for two. A room for the whole crew. Start with the people you want to talk to.",
  },
  {
    Icon: IconDecisions,
    title: "Make something happen.",
    body: "Share the thought, the photo, the first draft. Save a decision or give the next step an owner.",
  },
  {
    Icon: IconRecent,
    title: "Pick up where you left off.",
    body: "Life gets busy. Come back to the decisions, tasks and conversations that moved while you were away.",
  },
];

export default function HowItWorks() {
  return (
    <section id="how" className="cl-how cl-container">
      <div className="cl-how-heading">
        <p className="cl-eyebrow">Less setup. More connection.</p>
        <h2>
          Make yourself
          <br />
          <em>at home.</em>
        </h2>
      </div>
      <ol className="cl-steps">
        {STEPS.map(({ Icon, title, body }, index) => (
          <li key={title}>
            <span className="cl-step-icon">
              <Icon aria-hidden="true" />
            </span>
            <div>
              <span className="cl-step-number">0{index + 1}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
