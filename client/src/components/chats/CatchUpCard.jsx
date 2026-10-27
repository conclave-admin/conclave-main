import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import IconArrow from "@/assets/icons/arrow-right.svg?react";
import { getUserDigest } from "@/services/digest.service";
import { useRealtime } from "@/contexts/RealtimeContext";

/**
 * The "Catch up" card at the top of the chat list.
 *
 * Reads the same `GET /digest` response the /digest page does, so the card
 * and the page cannot disagree about what is new — they are two views of one
 * payload rather than two definitions of "unread".
 *
 * Renders nothing at all when there is nothing to catch up on, and swallows
 * its own failure. A card that says "could not load" at the top of the list
 * is worse than no card, because the list below it is still fine.
 */
export default function CatchUpCard() {
  const [counts, setCounts] = useState(null);
  const { socket } = useRealtime();

  useEffect(() => {
    let active = true;
    let request = 0;
    let refreshTimer = null;
    const refresh = () => {
      const current = ++request;
      return getUserDigest()
        .then(({ items, summary }) => {
          if (!active || current !== request) return;
          setCounts({
            total: items.length,
            headline: summary.headline,
            summary: summary.summary,
          });
        })
        .catch(() => {
          /* leave the card absent rather than show an error at the top of the list */
        });
    };
    void refresh();
    const scheduleRefresh = () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => { refreshTimer = null; void refresh(); }, 400);
    };
    const events = ["decision:changed", "task:updated", "chat:updated", "receive-message", "room:members"];
    events.forEach((event) => socket?.on(event, scheduleRefresh));
    window.addEventListener("focus", scheduleRefresh);
    window.addEventListener("conclave:digest-changed", scheduleRefresh);

    return () => {
      active = false;
      if (refreshTimer) window.clearTimeout(refreshTimer);
      events.forEach((event) => socket?.off(event, scheduleRefresh));
      window.removeEventListener("focus", scheduleRefresh);
      window.removeEventListener("conclave:digest-changed", scheduleRefresh);
    };
  }, [socket]);

  if (!counts) return null;
  if (counts.total === 0) return null;

  return (
    <Link
      to="/digest"
      className="mx-3 mb-2 flex items-center gap-3 rounded-lg border border-brand/30 bg-brand-soft/50 px-3 py-3 transition-colors hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-label text-ink">
          {counts.headline}
        </span>
        <span className="mt-1 block text-metadata text-muted">{counts.summary}</span>
      </span>
      <IconArrow className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
    </Link>
  );
}
