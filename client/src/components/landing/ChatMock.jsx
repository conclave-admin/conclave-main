import Avatar from '@/components/ui/Avatar';
import IconSend from '@/assets/icons/send.svg?react';

/**
 * The hero's chat mock.
 *
 * Not a screenshot and not an iframe: real markup, so it inherits dark mode,
 * respects the type scale, and costs no image bytes. It cannot be interacted
 * with and is labelled as such, because a mock that looks tappable and is not
 * is a small daily insult.
 *
 * Bubbles arrive in sequence on first paint rather than rendering finished.
 * That is the one piece of motion here that earns its place — a static
 * screenshot of a chat says nothing about a chat, and the arrival is the whole
 * point. Driven by CSS with a staggered delay rather than GSAP, because it
 * needs to run once on mount and never again; pulling in a scroll library for
 * that would be the wrong tool.
 *
 * `motion-safe:` gates every one of them, so with reduced motion the mock is
 * simply already there.
 */
const MESSAGES = [
  { id: 1, from: 'them', name: 'Amara Okafor', initials: 'AO', text: 'Can we ship the digest on Friday?' },
  { id: 2, from: 'me', text: 'Yes — catch-up is done, just needs your review.' },
  { id: 3, from: 'them', name: 'Amara Okafor', initials: 'AO', text: 'Reviewed. Marking it decided.', decided: true },
];

export default function ChatMock() {
  return (
    <div
      className="overflow-hidden rounded-xl border border-line bg-surface shadow-modal"
      aria-hidden="true"
    >
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Avatar name="Amara Okafor" size="sm" presence="online" />
        <div className="min-w-0">
          <p className="truncate text-label text-ink">Design decisions</p>
          <p className="text-metadata text-muted">4 members</p>
        </div>
      </div>

      <div className="flex flex-col gap-3 px-4 py-5">
        {MESSAGES.map((message, index) => (
          <div
            key={message.id}
            className={`flex ${message.from === 'me' ? 'justify-end' : 'justify-start'} motion-safe:animate-message-in`}
            style={{ animationDelay: `${180 + index * 220}ms` }}
          >
            <div className="flex max-w-[80%] items-end gap-2">
              {message.from === 'them' && <Avatar name={message.name} size="sm" />}
              <div
                className={`rounded-2xl px-3.5 py-2.5 text-body ${
                  message.from === 'me' ? 'bg-brand text-surface' : 'bg-canvas text-ink'
                }`}
              >
                <p>{message.text}</p>
                {message.decided && (
                  <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-brand-soft px-2 py-1 text-metadata text-brand">
                    Decision recorded
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}

        <div
          className="flex justify-start motion-safe:animate-message-in"
          style={{ animationDelay: '900ms' }}
        >
          <div className="flex items-end gap-2">
            <Avatar name="Amara Okafor" size="sm" />
            <div className="flex items-center gap-1 rounded-2xl bg-canvas px-3.5 py-3">
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className="h-1.5 w-1.5 rounded-full bg-muted motion-safe:animate-typing-dot"
                  style={{ animationDelay: `${dot * 160}ms` }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-line px-4 py-3">
        <div className="min-h-10 flex-1 rounded-full bg-canvas px-4 py-2.5 text-body text-muted">
          Write a message…
        </div>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand text-surface">
          <IconSend className="h-4 w-4" />
        </span>
      </div>
    </div>
  );
}
