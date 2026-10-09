import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import IconArrow from '@/assets/icons/arrow-right.svg?react';
import IconDecisions from '@/assets/icons/decisions.svg?react';
import IconTasks from '@/assets/icons/tasks.svg?react';
import { getUserDigest } from '@/services/digest.service';

/**
 * The "Catch up" card at the top of the chat list.
 *
 * Reads the same `GET /digest` response the /digest page does, so the card
 * and the page cannot disagree about what is new — they are two views of one
 * payload rather than two definitions of "unread".
 *
 * Only decisions and tasks are shown, per section 6. The digest also carries
 * mentions, files and per-room activity; those belong on the digest page,
 * where there is room to list them. Collapsing five categories into a card
 * that can only show a count would either hide most of the signal or turn the
 * card into the page it links to.
 *
 * Renders nothing at all when there is nothing to catch up on, and swallows
 * its own failure. A card that says "could not load" at the top of the list
 * is worse than no card, because the list below it is still fine.
 */
export default function CatchUpCard() {
  const [counts, setCounts] = useState(null);

  useEffect(() => {
    let active = true;

    getUserDigest()
      .then(({ items }) => {
        if (!active) return;
        setCounts({
          decision: items.filter((item) => item.type === 'decision').length,
          task: items.filter((item) => item.type === 'task').length,
        });
      })
      .catch(() => {
        /* leave the card absent rather than show an error at the top of the list */
      });

    return () => {
      active = false;
    };
  }, []);

  if (!counts) return null;
  const total = counts.decision + counts.task;
  if (total === 0) return null;

  return (
    <Link
      to="/digest"
      className="mx-3 mb-2 flex items-center gap-3 rounded-lg border border-brand/30 bg-brand-soft/50 px-3 py-3 transition-colors hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-label text-ink">
          {total} thing{total === 1 ? '' : 's'} to catch up on
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-metadata text-muted">
          {counts.decision > 0 && (
            <span className="inline-flex items-center gap-1">
              <IconDecisions className="h-3.5 w-3.5" aria-hidden="true" />
              {counts.decision} decision{counts.decision === 1 ? '' : 's'}
            </span>
          )}
          {counts.task > 0 && (
            <span className="inline-flex items-center gap-1">
              <IconTasks className="h-3.5 w-3.5" aria-hidden="true" />
              {counts.task} task{counts.task === 1 ? '' : 's'}
            </span>
          )}
        </span>
      </span>
      <IconArrow className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
    </Link>
  );
}
