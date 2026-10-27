import { Link } from "react-router-dom";
import Logo from "../landing/Logo";
export default function ConversationWelcome() {
  return (
    <div className="conversation-canvas flex h-full items-center justify-center px-8">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-8 flex h-24 w-24 items-center justify-center rounded-[28px] border border-line bg-surface shadow-sm">
          <Logo withWordmark={false} className="scale-150" />
        </div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-[.2em] text-brand">Conclave messages</p>
        <h1 className="text-3xl font-bold tracking-tight text-ink">Select a conversation</h1>
        <p className="mx-auto mt-4 max-w-xs text-sm leading-6 text-muted">
          Choose a chat from the list to read and reply, or start a new conversation.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            to="/new"
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-brand px-5 text-sm font-semibold text-white"
          >
            Start a conversation
          </Link>
          <Link
            to="/discover"
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-line bg-surface px-5 text-sm font-semibold text-ink"
          >
            Explore rooms
          </Link>
        </div>
      </div>
    </div>
  );
}
