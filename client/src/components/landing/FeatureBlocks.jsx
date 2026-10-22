import { Link } from 'react-router-dom';
import IconArrow from '@/assets/icons/arrow-right.svg?react';
import IconMessage from '@/assets/icons/message.svg?react';
import IconTasks from '@/assets/icons/tasks.svg?react';
import IconDecisions from '@/assets/icons/decisions.svg?react';
import IconRecent from '@/assets/icons/recent.svg?react';
import coast from '@/assets/landing/conclave-coast-v2-1536.webp';
import coastSmall from '@/assets/landing/conclave-coast-v2-768.webp';
import studio from '@/assets/landing/conclave-studio-v2-1536.webp';
import studioSmall from '@/assets/landing/conclave-studio-v2-768.webp';

const CAPABILITIES = [
  { Icon: IconMessage, label: 'Conversations that connect' },
  { Icon: IconDecisions, label: 'Decisions that stay' },
  { Icon: IconTasks, label: 'Plans that move forward' },
  { Icon: IconRecent, label: 'Catch-ups without the scroll' },
];

export default function FeatureBlocks() {
  return (
    <>
      <div className="cl-capabilities" aria-label="What you can do with Conclave">
        <div className="cl-container">
          {CAPABILITIES.map(({Icon, label}) => <p key={label}><Icon aria-hidden="true" />{label}</p>)}
        </div>
      </div>
      <section id="features" className="cl-container cl-features">
        <div className="cl-section-intro">
          <p className="cl-eyebrow">Life doesn’t fit in one kind of chat.</p>
          <h2>Neither should<br /><em>your conversations.</em></h2>
          <p>For the people you make memories with.<br />And the people you make things with.</p>
        </div>
        <div className="cl-feature-row">
          <div className="cl-life-photo">
            <img src={coast} srcSet={`${coastSmall} 768w, ${coast} 1536w`}
              sizes="(min-width: 900px) 48vw, 100vw" width="1536" height="1024"
              loading="lazy" decoding="async" alt="Three friends enjoying a sunset picnic by the coast" />
            <div className="cl-photo-chat" aria-hidden="true">
              <div className="cl-chat-group"><span className="cl-person">W</span><div><strong>The weekend crew</strong><small>One very good group chat.</small></div><span>☀️</span></div>
              <p>Same time, same people, new adventure?</p>
              <div className="cl-chat-answer">Already packing. 💜 <small>✓✓</small></div>
            </div>
          </div>
          <div className="cl-feature-copy">
            <span className="cl-feature-icon"><IconMessage aria-hidden="true" /></span>
            <p className="cl-eyebrow">A little closer, wherever you are</p>
            <h3>The group chat.<br /><em>With room for more.</em></h3>
            <p>The big news, the tiny updates, the photos you’ll talk about for years. Give your favourite people a place to share it all.</p>
            <ul className="cl-feature-list">
              <li>Direct messages for the personal stuff</li>
              <li>Rooms that bring the whole group together</li>
              <li>Photos, files and replies that keep the story going</li>
            </ul>
            <Link to="/register" className="cl-text-link">Start a conversation <IconArrow aria-hidden="true" /></Link>
          </div>
        </div>
        <div className="cl-feature-row cl-feature-reverse">
          <div className="cl-work-scene">
            <img src={studio} srcSet={`${studioSmall} 768w, ${studio} 1536w`}
              sizes="(min-width: 900px) 48vw, 100vw" width="1536" height="1024"
              loading="lazy" decoding="async" alt="Creative collaborators developing an idea together" />
            <div className="cl-work-card" aria-hidden="true">
              <p><span className="cl-status-dot" /> A good idea, going somewhere</p>
              <h4>Let’s make Friday happen.</h4>
              <div><IconDecisions /><span>Launch direction agreed</span><strong>Decided</strong></div>
              <div><IconTasks /><span>Put the first draft together</span><strong>Friday</strong></div>
              <div className="cl-work-person"><span className="cl-person cl-person-peach">J</span> Jamie’s on it. <span>✓</span></div>
            </div>
          </div>
          <div className="cl-feature-copy">
            <span className="cl-feature-icon"><IconDecisions aria-hidden="true" /></span>
            <p className="cl-eyebrow">Less “where was that?”</p>
            <h3>Give your ideas<br /><em>somewhere to go.</em></h3>
            <p>Great conversations deserve a next chapter. Capture the decision, give the next step an owner, and keep the context right where it belongs.</p>
            <ul className="cl-feature-list">
              <li>Save decisions alongside the conversation</li>
              <li>Turn a message into someone’s next step</li>
              <li>Return to a digest of what changed</li>
            </ul>
            <a href="#product-preview" className="cl-text-link">See how it comes together <IconArrow aria-hidden="true" /></a>
          </div>
        </div>
      </section>
    </>
  );
}
