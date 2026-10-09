import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import IconClose from '@/assets/icons/close.svg?react';
import IconPin from '@/assets/icons/pin.svg?react';
import IconStar from '@/assets/icons/star.svg?react';
import { useToast } from '@/contexts/ToastContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import { listRoomDecisions, pinDecision, unpinDecision } from '@/services/decisions.service';

/**
 * Decisions pinned to this room, in a strip under the header.
 *
 * Two scopes are shown side by side and told apart by icon, because they are
 * different promises: a star is "I bookmarked this for myself", a pin is
 * "this is pinned for everyone". Collapsing them into one row would make a
 * personal note look like a room-wide agreement.
 *
 * The strip is driven by the `pins` object the server attaches to every
 * decision, and by the `decision:pinned` / `decision:unpinned` events, which
 * carry a full decision rather than a delta — so an unpin is a replace, not a
 * filter, and a 409 arriving on a stale read is corrected without a refetch.
 *
 * There is no per-decision detail route yet, so a chip links to /decisions
 * rather than inventing a URL that does not resolve. That is the weakest part
 * of this component and is recorded as a gap.
 */
export default function PinnedDecisionStrip({ roomId }) {
  const [decisions, setDecisions] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [menuFor, setMenuFor] = useState(null);
  const menuRef = useRef(null);
  const { toast } = useToast();
  const { socket } = useRealtime();

  const mergeDecision = useCallback((incoming) => {
    setDecisions((prev) => {
      const index = prev.findIndex((item) => item.id === incoming.id);
      const next = [...prev];
      if (index === -1) next.push(incoming);
      else next[index] = incoming;
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    listRoomDecisions(roomId)
      .then((rows) => {
        if (!cancelled) setDecisions(rows);
      })
      .catch(() => {
        if (!cancelled) setDecisions([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  useEffect(() => {
    if (!socket) return undefined;

    const onPinned = (payload) => {
      if (payload?.decision?.room_id === roomId) mergeDecision(payload.decision);
    };
    const onUnpinned = (payload) => {
      if (payload?.decision?.room_id !== roomId) return;
      const decision = payload.decision;
      const stillPinned =
        decision.pins?.room || (decision.pins?.mine || []).length > 0;
      if (stillPinned) mergeDecision(decision);
      else setDecisions((prev) => prev.filter((item) => item.id !== decision.id));
    };

    socket.on('decision:pinned', onPinned);
    socket.on('decision:unpinned', onUnpinned);
    return () => {
      socket.off('decision:pinned', onPinned);
      socket.off('decision:unpinned', onUnpinned);
    };
  }, [socket, roomId, mergeDecision]);

  useEffect(() => {
    if (!menuFor) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setMenuFor(null);
    };
    const onPointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuFor(null);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [menuFor]);

  const pinned = decisions
    .filter((decision) => decision.pins?.room || (decision.pins?.mine || []).length > 0)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (isLoading || pinned.length === 0) return null;

  const runPin = async (decision, scope) => {
    try {
      mergeDecision(await pinDecision(decision.id, scope));
    } catch (err) {
      const message = err.response?.data?.message || 'Could not pin this decision.';
      toast({ title: 'Pin failed', description: message, tone: 'error' });
      // A 409 means the room pin moved to somebody else. Refetching rather than
      // guessing at the new holder keeps the strip honest when two people race.
      if (err.response?.status === 409) {
        const rows = await listRoomDecisions(roomId).catch(() => []);
        setDecisions(rows);
      }
    }
  };

  const runUnpin = async (decision, scope) => {
    try {
      const updated = await unpinDecision(decision.id, scope);
      if (updated) mergeDecision(updated);
      else setDecisions((prev) => prev.filter((item) => item.id !== decision.id));
    } catch (err) {
      toast({
        title: 'Unpin failed',
        description: err.response?.data?.message || 'Could not remove this pin.',
        tone: 'error',
      });
    }
  };

  return (
    <div className="shrink-0 border-b border-line bg-surface px-4 py-2 md:px-7">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-metadata text-muted">Pinned</span>
        <ul className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          {pinned.map((decision) => {
            const isRoomPinned = Boolean(decision.pins?.room);
            const mineScopes = decision.pins?.mine || [];
            const isMineOnly = !isRoomPinned && mineScopes.includes('user');
            const canUnpinRoom = mineScopes.includes('room');

            return (
              <li key={decision.id} ref={menuFor === decision.id ? menuRef : null} className="relative">
                <div className="flex items-center gap-1 rounded-full border border-line bg-canvas pl-2.5 pr-1">
                  {isRoomPinned ? (
                    <IconPin className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden="true" />
                  ) : (
                    <IconStar className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                  )}

                  <Link
                    to="/decisions"
                    className="max-w-[14rem] truncate px-1.5 py-1 text-metadata text-ink transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                    title={decision.title}
                  >
                    {decision.title}
                  </Link>

                  <span className="sr-only">
                    {isRoomPinned
                      ? `Pinned to the room by ${decision.pins.room.display_name}`
                      : 'Bookmarked by you'}
                  </span>

                  {(isMineOnly || canUnpinRoom || isRoomPinned) && (
                    <button
                      type="button"
                      onClick={() => setMenuFor((open) => (open === decision.id ? null : decision.id))}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === decision.id}
                      aria-label={`Pin actions for ${decision.title}`}
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                    >
                      <IconClose className="h-3 w-3" aria-hidden="true" />
                    </button>
                  )}
                </div>

                {menuFor === decision.id && (
                  <div role="menu" className="absolute right-0 top-8 z-20 w-52 rounded-lg border border-line bg-surface p-1 shadow-modal">
                    {!isRoomPinned && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          runPin(decision, 'room');
                          setMenuFor(null);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body text-ink transition-colors hover:bg-canvas"
                      >
                        <IconPin className="h-4 w-4 text-muted" aria-hidden="true" />
                        Pin for everyone
                      </button>
                    )}
                    {!mineScopes.includes('user') && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          runPin(decision, 'user');
                          setMenuFor(null);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body text-ink transition-colors hover:bg-canvas"
                      >
                        <IconStar className="h-4 w-4 text-muted" aria-hidden="true" />
                        Bookmark for me
                      </button>
                    )}
                    {mineScopes.includes('user') && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          runUnpin(decision, 'user');
                          setMenuFor(null);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body text-ink transition-colors hover:bg-canvas"
                      >
                        <IconClose className="h-4 w-4 text-muted" aria-hidden="true" />
                        Remove my bookmark
                      </button>
                    )}
                    {canUnpinRoom && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          runUnpin(decision, 'room');
                          setMenuFor(null);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body text-ink transition-colors hover:bg-canvas"
                      >
                        <IconClose className="h-4 w-4 text-muted" aria-hidden="true" />
                        Unpin for everyone
                      </button>
                    )}
                    <p className="border-t border-line px-2.5 pb-1 pt-2 text-metadata text-muted">
                      {isRoomPinned && !canUnpinRoom
                        ? 'Only the pinner or a room admin can unpin this'
                        : 'Any member can pin'}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
