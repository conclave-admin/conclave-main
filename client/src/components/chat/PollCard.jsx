import { useEffect, useMemo, useState } from "react";
import IconSuccess from "@/assets/icons/success.svg?react";
import Avatar from "@/components/ui/Avatar";
import Modal from "@/components/ui/Modal";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/contexts/ToastContext";
import { closePoll, votePoll } from "@/services/polls.service";

const sameIds = (a, b) =>
  a.length === b.length && a.every((id) => b.includes(id));

// What the poll will look like once this person's vote lands. Applied locally
// so a tap feels instant; the server's own copy replaces it a moment later.
function withMyChoice(poll, viewer, ids) {
  const chosen = new Set(ids);
  const options = poll.options.map((option) => {
    const others = option.voters.filter((voter) => voter.id !== viewer.id);
    return {
      ...option,
      voters: chosen.has(option.id) ? [...others, viewer] : others,
    };
  });
  const voters = new Set(
    options.flatMap((option) => option.voters.map((voter) => voter.id)),
  );
  return { ...poll, options, voter_count: voters.size };
}

function voterSummary(voters, viewerId) {
  const names = voters
    .map((voter) =>
      voter.id === viewerId
        ? "You"
        : (voter.display_name || "Someone").split(" ")[0],
    )
    .sort((a, b) => (a === "You" ? -1 : b === "You" ? 1 : 0));
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/**
 * A poll in the timeline. Everyone can see who voted for what: each option
 * lists its voters, and "View votes" opens the full list.
 *
 * @param {object} message - a message with a `poll`
 * @param {string} viewerId
 * @param {boolean} canClose - the poll's creator or a room admin
 */
export default function PollCard({ message, viewerId, canClose }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const serverPoll = message.poll;

  const [choice, setChoice] = useState(null); // optimistic option ids, null follows the server
  const [busy, setBusy] = useState(false);
  const [showVotes, setShowVotes] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const viewer = useMemo(
    () => ({
      id: viewerId,
      display_name: user?.display_name || "You",
      avatar_url: user?.avatar_url || null,
    }),
    [viewerId, user],
  );

  const serverMine = useMemo(
    () =>
      serverPoll.options
        .filter((option) =>
          option.voters.some((voter) => voter.id === viewerId),
        )
        .map((option) => option.id),
    [serverPoll, viewerId],
  );

  // Drop the optimistic choice once the server agrees with it.
  useEffect(() => {
    if (choice && sameIds(serverMine, choice)) setChoice(null);
  }, [serverMine, choice]);

  const poll = useMemo(
    () => (choice ? withMyChoice(serverPoll, viewer, choice) : serverPoll),
    [serverPoll, choice, viewer],
  );

  const myIds = poll.options
    .filter((option) => option.voters.some((voter) => voter.id === viewerId))
    .map((option) => option.id);
  const closed = Boolean(poll.closed_at);

  const toggle = async (optionId) => {
    if (closed || busy) return;
    let next;
    if (poll.allow_multiple) {
      next = myIds.includes(optionId)
        ? myIds.filter((id) => id !== optionId)
        : [...myIds, optionId];
    } else {
      next = myIds.includes(optionId) ? [] : [optionId];
    }

    setChoice(next);
    setBusy(true);
    try {
      await votePoll(poll.id, next);
    } catch (err) {
      setChoice(null);
      toast({
        title: "Vote not saved",
        description: err.response?.data?.message || "Please try again.",
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleClose = async () => {
    if (!confirmClose) {
      setConfirmClose(true);
      return;
    }
    try {
      await closePoll(poll.id);
    } catch (err) {
      toast({
        title: "Could not close the poll",
        description: err.response?.data?.message || "Please try again.",
        tone: "error",
      });
    } finally {
      setConfirmClose(false);
    }
  };

  return (
    <div className="w-72 max-w-full rounded-2xl bg-canvas p-3 text-ink">
      <p className="text-label [overflow-wrap:anywhere]">{poll.question}</p>
      <p className="mt-0.5 text-metadata text-muted">
        {closed
          ? "Poll closed"
          : poll.allow_multiple
            ? "Select one or more"
            : "Select one"}
      </p>

      <ul className="mt-3 flex flex-col gap-2">
        {poll.options.map((option) => {
          const selected = myIds.includes(option.id);
          const count = option.voters.length;
          const percent = poll.voter_count
            ? Math.round((count / poll.voter_count) * 100)
            : 0;

          return (
            <li key={option.id}>
              <button
                type="button"
                role={poll.allow_multiple ? "checkbox" : "radio"}
                aria-checked={selected}
                disabled={closed}
                onClick={() => toggle(option.id)}
                className="relative w-full overflow-hidden rounded-lg border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-default disabled:hover:border-line"
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 bg-brand-soft transition-[width] duration-300"
                  style={{ width: `${percent}%` }}
                />
                <span className="relative flex items-center gap-2.5">
                  <span
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${
                      selected
                        ? "border-brand bg-brand text-surface"
                        : "border-line"
                    }`}
                  >
                    {selected && (
                      <IconSuccess className="h-3 w-3" aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 text-body [overflow-wrap:anywhere]">
                    {option.label}
                  </span>
                  <span className="shrink-0 text-metadata text-muted">
                    {count}
                  </span>
                </span>
              </button>
              {count > 0 && (
                <p className="mt-1 truncate px-1 text-metadata text-muted">
                  {voterSummary(option.voters, viewerId)}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setShowVotes(true)}
          disabled={!poll.voter_count}
          className="text-metadata text-brand hover:underline disabled:text-muted disabled:no-underline"
        >
          {poll.voter_count} {poll.voter_count === 1 ? "vote" : "votes"}
          {poll.voter_count > 0 ? " · View votes" : ""}
        </button>

        {canClose && !closed && (
          <button
            type="button"
            onClick={handleClose}
            onBlur={() => setConfirmClose(false)}
            className="text-metadata text-muted transition-colors hover:text-ink"
          >
            {confirmClose ? "Tap again to close" : "Close poll"}
          </button>
        )}
      </div>

      <Modal open={showVotes} onClose={() => setShowVotes(false)} title="Votes">
        <div className="flex flex-col gap-5">
          {poll.options.map((option) => (
            <section key={option.id}>
              <h3 className="flex items-baseline justify-between gap-3 text-label text-ink">
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {option.label}
                </span>
                <span className="shrink-0 text-metadata text-muted">
                  {option.voters.length}
                </span>
              </h3>
              {option.voters.length === 0 ? (
                <p className="mt-1 text-metadata text-muted">No votes</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {option.voters.map((voter) => (
                    <li key={voter.id} className="flex items-center gap-2.5">
                      <Avatar
                        name={voter.display_name || ""}
                        src={voter.avatar_url}
                        size="sm"
                      />
                      <span className="min-w-0 truncate text-body text-ink">
                        {voter.id === viewerId
                          ? "You"
                          : voter.display_name || "Someone"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </Modal>
    </div>
  );
}
