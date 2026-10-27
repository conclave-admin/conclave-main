import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useOutletContext,
  useSearchParams,
} from "react-router-dom";
import IconPin from "@/assets/icons/pin.svg?react";
import IconStar from "@/assets/icons/star.svg?react";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import Spinner from "@/components/ui/Spinner";
import { getDecisionOverview, listDecisions, searchDecisions } from "@/services/decisions.service";
import Page from "@/components/layout/Page";
import { useChats } from "@/contexts/ChatsContext";
import { useRealtime } from "@/contexts/RealtimeContext";
import PromoteToDecisionDialog from "@/components/chat/PromoteToDecisionDialog";
const MANUAL_DECISION = { manual: true };

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function DecisionCard({ decision }) {
  const isRoomPinned = Boolean(decision.pins?.room);
  const isBookmarked = (decision.pins?.mine || []).includes("user");

  return (
    <article className="group flex h-full flex-col rounded-2xl border border-line bg-surface p-5 shadow-sm transition hover:border-brand/40 hover:shadow-md md:p-6">
      <div className="flex items-center gap-2">
        <p className="text-label text-success">DECISION</p>
        {decision.status === "retracted" && (
          <span className="text-metadata text-error">Retracted</span>
        )}
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
      <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-body text-muted [overflow-wrap:anywhere]">
        {decision.body}
      </p>

      {decision.follow_up?.total > 0 && (
        <div className="mt-5 rounded-xl bg-canvas p-3">
          <div className="flex items-center justify-between gap-2 text-metadata text-muted">
            <span>Follow-up work</span><span>{decision.follow_up.done} of {decision.follow_up.total} done</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" role="progressbar"
            aria-label="Follow-up task progress" aria-valuenow={decision.follow_up.done}
            aria-valuemin={0} aria-valuemax={decision.follow_up.total}>
            <div className="h-full rounded-full bg-brand" style={{ width: `${100 * decision.follow_up.done / decision.follow_up.total}%` }} />
          </div>
        </div>
      )}

      <p className="mt-auto pt-5 text-metadata text-muted">
        Recorded by {decision.author_name} · {formatDate(decision.created_at)} · {decision.room_slug ?? decision.room_name}
        {decision.version > 1 && ` · Updated ${formatDate(decision.updated_at)}`}
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
 * A decision can be created here or promoted from a message in a conversation.
 */
export default function Decisions() {
  const { setRoomHeader } = useOutletContext();
  const navigate = useNavigate();
  const { rooms } = useChats();
  const { socket } = useRealtime();
  const [params, setParams] = useSearchParams();
  const [decisions, setDecisions] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [loadMoreError, setLoadMoreError] = useState("");
  const [next, setNext] = useState(null);
  const [creating, setCreating] = useState(false);
  const [revision, setRevision] = useState(0);
  const [overview, setOverview] = useState(null);
  const [searchInput, setSearchInput] = useState(params.get("q") || "");
  const requestVersion = useRef(0);

  const query = params.get("q") || "";
  const roomId = params.get("room") || "";
  const status = ["active", "retracted", "all"].includes(params.get("status"))
    ? params.get("status") : "active";
  const eligibleRooms = useMemo(
    () => rooms.filter((room) => room.encryption_mode !== "e2ee-v1" && !room.superseded_by),
    [rooms],
  );

  useEffect(() => {
    setRoomHeader("Decisions");
    return () => setRoomHeader(null);
  }, [setRoomHeader]);
  useEffect(() => { setSearchInput(query); }, [query]);
  useEffect(() => {
    if (searchInput === query) return undefined;
    const timer = setTimeout(() => {
      setParams((previous) => {
        const nextParams = new URLSearchParams(previous);
        if (searchInput.trim()) nextParams.set("q", searchInput.trim());
        else nextParams.delete("q");
        return nextParams;
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, query, setParams]);

  useEffect(() => {
    let active = true;
    const version = ++requestVersion.current;
    setIsLoading(true);
    setError("");
    setLoadMoreError("");
    setNext(null);

    const request = query.trim()
      ? searchDecisions(query.trim(), roomId || undefined, undefined, status)
      : listDecisions({ roomId: roomId || undefined, status });

    request
      .then((result) => {
        if (active && version === requestVersion.current) {
          setDecisions(result.decisions);
          setNext(result.nextCursor);
        }
      })
      .catch((err) => {
        if (active && version === requestVersion.current)
          setError(err.response?.data?.message || "Could not load decisions.");
      })
      .finally(() => {
        if (active && version === requestVersion.current) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [query, roomId, status, revision]);

  useEffect(() => {
    let active = true;
    getDecisionOverview().then((value) => { if (active) setOverview(value); }).catch(() => {});
    return () => { active = false; };
  }, [revision]);

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    socket?.on("decision:changed", refresh);
    socket?.on("decision:pinned", refresh);
    socket?.on("decision:unpinned", refresh);
    socket?.on("task:updated", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      socket?.off("decision:changed", refresh);
      socket?.off("decision:pinned", refresh);
      socket?.off("decision:unpinned", refresh);
      socket?.off("task:updated", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [socket]);

  const loadMore = async () => {
    if (!next || isLoadingMore) return;
    const version = requestVersion.current;
    setIsLoadingMore(true);
    setLoadMoreError("");
    try {
      const result = query.trim()
        ? await searchDecisions(query.trim(), roomId || undefined, next, status)
        : await listDecisions({ roomId: roomId || undefined, before: next, status });
      if (version !== requestVersion.current) return;
      setDecisions((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...result.decisions.filter((item) => !known.has(item.id))];
      });
      setNext(result.nextCursor);
    } catch (err) {
      if (version === requestVersion.current)
        setLoadMoreError(err.response?.data?.message || "Could not load more decisions.");
    } finally {
      setIsLoadingMore(false);
    }
  };

  return (
    <Page width="board">
      <header className="mb-7 overflow-hidden rounded-2xl border border-line bg-surface p-6 shadow-sm md:p-8">
        <p className="text-label uppercase tracking-widest text-brand">Conclave decisions</p>
        <div className="mt-3 flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div><h1 className="max-w-2xl text-h1 text-ink">Know what was decided. See what happens next.</h1>
            <p className="mt-3 max-w-xl text-body text-muted">A shared record of choices, context, and the work that follows them.</p></div>
          <Button variant="primary" onClick={() => setCreating(true)} disabled={!eligibleRooms.length} className="h-12 shrink-0">New decision</Button>
        </div>
        {overview && <div className="mt-7 grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Decision overview across all conversations">
          {[["Active", overview.active], ["Work in progress", overview.with_open_tasks], ["Follow-ups done", overview.follow_ups_done], ["Retracted", overview.retracted]].map(([label, value]) =>
            <div key={label} className="rounded-xl border border-line bg-canvas p-3.5"><p className="text-h2 text-ink">{value}</p><p className="mt-1 text-metadata text-muted">{label}</p></div>)}
        </div>}
      </header>
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <label className="block w-full md:max-w-sm">
          <span className="mb-2 block text-label text-ink">Search</span>
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search decisions"
            className="h-12 w-full rounded-lg border border-line bg-surface px-3.5 text-body text-ink outline-none placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/15"
          />
        </label>
        <label className="block w-full md:max-w-xs text-label text-ink">
          Conversation
          <select
            value={roomId}
            onChange={(event) => {
              const selectedRoom = event.target.value;
              setParams((previous) => {
                const nextParams = new URLSearchParams(previous);
                if (selectedRoom) nextParams.set("room", selectedRoom);
                else nextParams.delete("room");
                return nextParams;
              });
            }}
            className="mt-2 h-12 w-full rounded-lg border border-line bg-surface px-3 text-body text-ink"
          >
            <option value="">All conversations</option>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.display_name || room.name || "Conversation"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-4 flex flex-wrap gap-2" aria-label="Decision status">
        {[["active", "Active"], ["retracted", "Retracted"], ["all", "All"]].map(([value, label]) => (
          <Button key={value} variant={status === value ? "primary" : "secondary"}
            onClick={() => setParams((previous) => {
              const nextParams = new URLSearchParams(previous);
              if (value === "active") nextParams.delete("status");
              else nextParams.set("status", value);
              return nextParams;
            })}>{label}</Button>
        ))}
      </div>
      {!eligibleRooms.length && !isLoading && (
        <p className="mt-3 text-body text-muted">
          Decisions can be created in server-readable collaboration rooms. Encrypted conversations do not support shared decisions yet.
        </p>
      )}

      {isLoading && (
        <div className="mt-10">
          <Spinner label="Loading decisions" />
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-10 rounded-lg bg-error/10 p-4 text-body text-error"
        >
          {error}
        </p>
      )}

      {!isLoading && !error && decisions.length === 0 && (
        <div className="mt-10 rounded-xl border border-dashed border-line">
          <EmptyState
            title={query ? "No decisions match" : "No decisions yet"}
            description={
              query
                ? `Nothing matches "${query}". Try a different term, or clear the search to see every decision.`
                : "Create a decision or promote a conversation message to keep it here."
            }
          />
        </div>
      )}

      {!isLoading && !error && decisions.length > 0 && (
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {decisions.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} />
          ))}
        </div>
      )}
      {next && !isLoading && (
        <Button
          variant="secondary"
          disabled={isLoadingMore}
          onClick={loadMore}
          className="mt-6"
        >
          {isLoadingMore ? "Loading…" : "Load more decisions"}
        </Button>
      )}
      {loadMoreError && (
        <p role="alert" className="mt-3 text-body text-error">{loadMoreError}</p>
      )}
      <PromoteToDecisionDialog
        open={creating}
        onClose={() => setCreating(false)}
        message={MANUAL_DECISION}
        roomId={roomId && eligibleRooms.some((room) => room.id === roomId)
          ? roomId : undefined}
        rooms={eligibleRooms}
        onPromoted={(decision) => navigate(`/decisions/${decision.id}`)}
      />
    </Page>
  );
}
