import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import EmptyState from '../components/ui/EmptyState';
import Spinner from '../components/ui/Spinner';
import { getUserDigest } from '../services/digest.service';

// Type-to-label/colour mapping lives here, not in the fixtures — the backend
// sends a bare `type`, never display copy. Five types exist on the server
// (decision, task, mention, file, activity); an unknown one still renders
// rather than throwing, so a new server-side type cannot blank this page.
const ITEM_TYPES = {
  decision: { label: 'DECISION', color: 'text-success', dot: 'bg-success' },
  task: { label: 'TASK ASSIGNED', color: 'text-warning', dot: 'bg-warning' },
  mention: { label: 'MENTION', color: 'text-brand', dot: 'bg-brand' },
  file: { label: 'FILE SHARED', color: 'text-brand', dot: 'bg-brand' },
  activity: { label: 'HIGH ACTIVITY', color: 'text-brand', dot: 'bg-brand' },
};

function DigestItem({ type, title, metadata, room_name }) {
  const { label, color, dot } = ITEM_TYPES[type] || { label: 'UPDATE', color: 'text-muted', dot: 'bg-muted' };
  return (
    <article className="flex items-start gap-[14px] rounded-xl border border-line bg-surface px-4 pt-18 pb-[15px]">
      <span className={`h-7 w-7 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className={`text-label ${color}`}>{label}</p>
        <p className="mt-3 text-h2 text-ink [overflow-wrap:anywhere]">{title}</p>
        {/* metadata is authored by, or describes, the room — so it is never
            null for the four content types, and null for activity. The room
            name carries the "where" when there is no actor to name. */}
        <p className="mt-3 text-metadata text-muted">
          {[metadata, room_name].filter(Boolean).join(' · ')}
        </p>
      </div>
    </article>
  );
}

/**
 * The catch-up digest.
 *
 * Reads the same `GET /digest` the chat list's Catch-up card does, so the two
 * cannot disagree about what is new — they are two views of one payload rather
 * than two definitions of "unread". The card shows counts of decisions and
 * tasks; this page lists every category, because there is room here for
 * mentions, files and activity that a card can only count.
 *
 * The window is each room's OWN `last_seen_at`, read server-side, which is why
 * this page must not be paired with a room-open `markSeen`: opening a room
 * advances that room's pointer, and a digest fetched afterwards would find
 * nothing. That is why the in-room "since you were away" card was removed in
 * phase 6 and only the cross-room view remains.
 */
export default function CatchUpDigestPage() {
  const { setRoomHeader } = useOutletContext();
  const [digest, setDigest] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setRoomHeader('Catch-up digest');
    return () => setRoomHeader(null);
  }, [setRoomHeader]);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError('');

    getUserDigest()
      .then((value) => {
        if (active) setDigest(value);
      })
      .catch((err) => {
        if (active) setError(err.response?.data?.message || 'Could not load your digest.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  if (isLoading) return <Spinner label="Loading your digest" />;

  if (error) {
    return (
      <div className="h-full min-h-0 overflow-y-auto bg-surface px-4 pt-[22px] md:pt-7">
        <p role="alert" className="rounded-lg bg-error/10 p-4 text-body text-error">{error}</p>
      </div>
    );
  }

  const items = digest?.items || [];

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-surface px-4 pt-[22px] md:pt-7">
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line">
          <EmptyState
            title="Nothing to catch up on"
            description="Updates since your last visit to each room will appear here."
          />
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-line bg-surface px-5 pt-6 pb-7 md:px-6">
            <p className="text-label text-muted">SINCE YOU WERE AWAY</p>
            <p className="mt-3 text-h1 text-ink">{digest.summary.headline}</p>
            <p className="mt-3 text-body text-muted">{digest.summary.summary}</p>
          </div>
          <div className="mt-10 flex flex-col gap-5 pb-8">
            {items.map((item) => (
              <DigestItem key={item.id} {...item} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
