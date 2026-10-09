import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useOutletContext } from 'react-router-dom';
import IconArrowLeft from '@/assets/icons/arrow-left.svg?react';
import IconArrowRight from '@/assets/icons/arrow-right.svg?react';
import IconClose from '@/assets/icons/close.svg?react';
import IconPin from '@/assets/icons/pin.svg?react';
import IconStar from '@/assets/icons/star.svg?react';
import Spinner from '@/components/ui/Spinner';
import { useToast } from '@/contexts/ToastContext';
import { getDecision, pinDecision, unpinDecision } from '@/services/decisions.service';

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * One decision, in full.
 *
 * Reached from a pinned chip in a room header, from the board, or from search.
 * All three previously had nowhere to go: there was no GET for a single
 * decision and no route, so a pin could only ever point at the board and leave
 * the reader hunting for the row they clicked.
 *
 * Pin controls live here as well as in the strip, because a decision opened
 * from the board has no strip beside it — and "pin this for the room" is most
 * useful exactly when you have just re-read the thing you want to pin.
 */
export default function DecisionDetail() {
  const { decisionId } = useParams();
  const { setRoomHeader } = useOutletContext();
  const { toast } = useToast();

  const [decision, setDecision] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError('');
    setDecision(null);

    getDecision(decisionId)
      .then((value) => {
        if (active) setDecision(value);
      })
      .catch((err) => {
        // 403 covers both "not in that room" and "does not exist" — the server
        // does not distinguish them, so the message has to be readable either way.
        if (active) {
          setError(err.response?.data?.message || 'Could not load this decision.');
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [decisionId]);

  useEffect(() => {
    setRoomHeader(decision ? decision.title : 'Decision');
    return () => setRoomHeader(null);
  }, [setRoomHeader, decision]);

  const isRoomPinned = Boolean(decision?.pins?.room);
  const mineScopes = decision?.pins?.mine || [];
  const isBookmarked = mineScopes.includes('user');
  const canUnpinRoom = mineScopes.includes('room');

  const runPin = useCallback(
    async (scope) => {
      try {
        setDecision(await pinDecision(decisionId, scope));
      } catch (err) {
        // A 409 means somebody else took the room pin; the server names them,
        // and the fresher payload below puts the strip and this page back in step.
        const message = err.response?.data?.message || 'Could not pin this decision.';
        toast({ title: 'Pin failed', description: message, tone: 'error' });
        if (err.response?.status === 409) {
          getDecision(decisionId).then(setDecision).catch(() => {});
        }
      }
    },
    [decisionId, toast],
  );

  const runUnpin = useCallback(
    async (scope) => {
      try {
        const updated = await unpinDecision(decisionId, scope);
        // The server answers a removed-but-absent pin with a sentinel
        // `{ decisionId, scope, unpinned: false }` rather than a 404, so a
        // retried unpin does not look like a failure. That sentinel is not a
        // decision, so the previous payload is kept rather than replacing this
        // page with an empty article.
        if (updated?.pins) setDecision(updated);
      } catch (err) {
        toast({
          title: 'Unpin failed',
          description: err.response?.data?.message || 'Could not remove this pin.',
          tone: 'error',
        });
      }
    },
    [decisionId, toast],
  );

  if (isLoading) return <Spinner label="Loading decision" />;

  if (error || !decision) {
    return (
      <div className="h-full min-h-0 overflow-y-auto bg-surface px-4 pt-6 md:px-7">
        <p role="alert" className="rounded-lg bg-error/10 p-4 text-body text-error">
          {error || 'Decision not found.'}
        </p>
        <Link
          to="/decisions"
          className="mt-4 inline-flex items-center gap-2 text-label text-brand hover:underline"
        >
          <IconArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to decisions
        </Link>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-surface px-4 pt-6 md:px-7">
      <Link
        to="/decisions"
        className="inline-flex items-center gap-2 text-label text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        <IconArrowLeft className="h-4 w-4" aria-hidden="true" />
        All decisions
      </Link>

      <article className="mt-5 rounded-xl border border-line bg-surface px-5 py-6 md:px-8 md:py-8">
        <p className="text-label text-success">DECISION</p>
        <h1 className="mt-3 text-h1 text-ink">{decision.title}</h1>

        {decision.body && (
          <p className="mt-5 whitespace-pre-wrap text-body text-ink [overflow-wrap:anywhere]">
            {decision.body}
          </p>
        )}

        {decision.tags?.length > 0 && (
          <ul className="mt-5 flex flex-wrap gap-2">
            {decision.tags.map((tag) => (
              <li
                key={tag}
                className="rounded-full bg-canvas px-2.5 py-1 text-metadata text-muted"
              >
                #{tag}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-6 text-metadata text-muted">
          {decision.author_name} · {formatDate(decision.created_at)} · #
          {decision.room_slug ?? decision.room_name}
        </p>

        {decision.room_id && (
          <Link
            to={`/chats/${decision.room_id}`}
            className="mt-4 inline-flex items-center gap-2 text-label text-brand hover:underline"
          >
            Open #{decision.room_slug ?? decision.room_name}
            <IconArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-line pt-5">
          {!isRoomPinned && (
            <button
              type="button"
              onClick={() => runPin('room')}
              className="inline-flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-label text-ink transition-colors hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <IconPin className="h-4 w-4" aria-hidden="true" />
              Pin for everyone
            </button>
          )}

          {canUnpinRoom && (
            <button
              type="button"
              onClick={() => runUnpin('room')}
              className="inline-flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-label text-ink transition-colors hover:border-error hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <IconClose className="h-4 w-4" aria-hidden="true" />
              Unpin for everyone
            </button>
          )}

          {isBookmarked ? (
            <button
              type="button"
              onClick={() => runUnpin('user')}
              className="inline-flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-label text-ink transition-colors hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <IconStar className="h-4 w-4" aria-hidden="true" />
              Remove my bookmark
            </button>
          ) : (
            <button
              type="button"
              onClick={() => runPin('user')}
              className="inline-flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-label text-ink transition-colors hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <IconStar className="h-4 w-4" aria-hidden="true" />
              Bookmark for me
            </button>
          )}
        </div>

        <p className="mt-3 text-metadata text-muted">
          {isRoomPinned && !canUnpinRoom
            ? `Pinned for the room by ${decision.pins.room.display_name}. Only they or a room admin can unpin it.`
            : 'Any member can pin a decision for the room.'}
        </p>
      </article>
    </div>
  );
}
