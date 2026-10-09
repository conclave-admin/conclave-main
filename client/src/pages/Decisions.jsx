import { useEffect, useState } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import IconPin from '@/assets/icons/pin.svg?react';
import IconStar from '@/assets/icons/star.svg?react';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import Spinner from '@/components/ui/Spinner';
import { listDecisions, searchDecisions } from '@/services/decisions.service';

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function DecisionCard({ decision }) {
  const isRoomPinned = Boolean(decision.pins?.room);
  const isBookmarked = (decision.pins?.mine || []).includes('user');

  return (
    <article className="rounded-xl border border-line bg-surface px-5 pt-18 pb-[21px]">
      <div className="flex items-center gap-2">
        <p className="text-label text-success">DECISION</p>
        {/* Pin state is on the card, not only in the strip: a decision reached
            from search or from the board has no strip beside it, and "pinned
            for the room" is a fact about the decision rather than about one
            surface it appears on. */}
        {isRoomPinned && (
          <span className="flex items-center gap-1 text-metadata text-brand">
            <IconPin className="h-3.5 w-3.5" aria-hidden="true" />
            Pinned for the room
          </span>
        )}
        {isBookmarked && (
          <span className="flex items-center gap-1 text-metadata text-muted">
            <IconStar className="h-3.5 w-3.5" aria-hidden="true" />
            Bookmarked
          </span>
        )}
      </div>

      {/* 14px/22px gaps measured on the Decisions boards — not on the Foundations
          spacing scale, kept as the measured arbitrary values. Combined with
          pt-18/pb-[21px] they reproduce the board's 130px card height for a
          one-line title, without hardcoding the height itself. */}
      <Link
        to={`/decisions/${decision.id}`}
        className="mt-[14px] block text-h2 text-ink transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        {decision.title}
      </Link>

      <p className="mt-[22px] text-metadata text-muted">
        {decision.author_name} · {formatDate(decision.created_at)} · #
        {decision.room_slug ?? decision.room_name}
      </p>
    </article>
  );
}

/**
 * The decisions board.
 *
 * Cross-room by default, because this is a top-level page: a decision is
 * retrievable by title long after anyone remembers which room it came from,
 * so filtering to one room up front would hide most of the value.
 *
 * Search writes `?q=` to the URL rather than to component state, for the same
 * reason the chat list does — a search a colleague can be handed is worth more
 * than one that evaporates on reload, and it keeps list and search from being
 * two different answers to the same question.
 *
 * "New decision" goes to the chat list. Decisions are promoted from messages,
 * and that is where the message is. The endpoint does accept a decision with
 * no source message, but a standalone create form is a second flow the design
 * does not show, so it is not invented here.
 */
export default function Decisions() {
  const { setRoomHeader } = useOutletContext();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [decisions, setDecisions] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const query = params.get('q') || '';

  useEffect(() => {
    setRoomHeader('Decisions');
    return () => setRoomHeader(null);
  }, [setRoomHeader]);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError('');

    const request = query.trim()
      ? searchDecisions(query.trim()).then((rows) => rows)
      : listDecisions().then(({ decisions: rows }) => rows);

    request
      .then((rows) => {
        if (active) setDecisions(rows);
      })
      .catch((err) => {
        if (active) setError(err.response?.data?.message || 'Could not load decisions.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [query]);

  const setQuery = (value) => {
    const next = new URLSearchParams();
    if (value) next.set('q', value);
    setParams(next);
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-surface px-4 pt-6 md:pt-9">
      <div className="flex items-start justify-between gap-4">
        <label className="block w-[300px]">
          <span className="mb-2 block text-label text-ink">Search</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search decisions"
            className="h-12 w-full rounded-lg border border-line bg-surface px-3.5 text-body text-ink outline-none placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/15"
          />
        </label>
        {/* Absent from the Mobile board entirely (not just resized) — hidden below md.
            md:mt-6 aligns the button with the search input box itself: the "Search"
            label above the input has no counterpart next to the button, so the
            button needs the same 24px push to line up with the input's top edge. */}
        <Button
          variant="primary"
          onClick={() => navigate('/chats')}
          className="hidden h-[42px] w-[160px] md:mt-6 md:inline-flex"
        >
          New decision
        </Button>
      </div>

      {isLoading && (
        <div className="mt-10">
          <Spinner label="Loading decisions" />
        </div>
      )}

      {error && (
        <p role="alert" className="mt-10 rounded-lg bg-error/10 p-4 text-body text-error">
          {error}
        </p>
      )}

      {!isLoading && !error && decisions.length === 0 && (
        <div className="mt-10 rounded-xl border border-dashed border-line">
          <EmptyState
            title={query ? 'No decisions match' : 'No decisions yet'}
            description={
              query
                ? `Nothing matches "${query}". Try a different term, or clear the search to see every decision.`
                : 'Decisions promoted from room messages will appear here.'
            }
          />
        </div>
      )}

      {!isLoading && !error && decisions.length > 0 && (
        <div className="mt-10 flex flex-col gap-5">
          {decisions.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} />
          ))}
        </div>
      )}
    </div>
  );
}
