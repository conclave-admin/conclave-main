import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import IconArrow from "@/assets/icons/arrow-right.svg?react";
import IconClose from "@/assets/icons/close.svg?react";
import { getUserDigest } from "@/services/digest.service";
import { useAuth } from "@/contexts/AuthContext";
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
  const [dismissedSignature, setDismissedSignature] = useState("");
  const { user } = useAuth();
  const { socket } = useRealtime();

  const dismissalKey = user?.id
    ? `conclave:catch-up-dismissed:${user.id}`
    : null;

  useEffect(() => {
    setDismissedSignature(
      dismissalKey ? window.sessionStorage.getItem(dismissalKey) || "" : "",
    );
  }, [dismissalKey]);

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
            signature: `${summary.headline}|${summary.summary}|${items.map((item) => item.id || item.event_id).join(",")}`,
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
  if (dismissedSignature === counts.signature) return null;

  return (
    <div className="mx-4 my-2 flex items-center rounded-xl bg-brand-soft/50 transition-colors hover:bg-brand-soft">
      <Link
        to="/digest"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-l-xl px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/30"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-label text-ink">
            {counts.headline}
          </span>
          <span className="mt-0.5 block truncate text-metadata text-muted">{counts.summary}</span>
        </span>
        <IconArrow className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
      </Link>
      <button
        type="button"
        aria-label="Dismiss catch-up summary"
        onClick={() => {
          if (dismissalKey)
            window.sessionStorage.setItem(dismissalKey, counts.signature);
          setDismissedSignature(counts.signature);
        }}
        className="mr-1 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface/70 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        <IconClose className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
