import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import EmptyState from "../components/ui/EmptyState";
import Button from "../components/ui/Button";
import Spinner from "../components/ui/Spinner";
import { getUserDigest, markDigestRead } from "../services/digest.service";
import { useRealtime } from "../contexts/RealtimeContext";
import Page from "@/components/layout/Page";

const TYPE_STYLES = {
  decision: "text-success", task: "text-warning", mention: "text-brand",
  file: "text-brand", pin: "text-success",
};
const ACTION_LABELS = {
  decision: { recorded: "Decision recorded", edited: "Decision edited", retracted: "Decision retracted" },
  task: { created: "Task created", assigned: "Task assigned to you", reassigned: "Task reassigned",
    progress: "Task in progress", completed: "Task completed", reopened: "Task reopened",
    note: "Progress note", edited: "Task edited" },
  mention: { mentioned: "Mentioned you" },
  file: { shared: "File shared" },
  pin: { pinned: "Pinned for the room" },
};
const VIEWS = [
  { id: "all", label: "All updates" },
  { id: "direct", label: "For you" },
  { id: "work", label: "Decisions & tasks" },
  { id: "shared", label: "Shared items" },
];

function itemTarget(item) {
  if (item.type === "decision") return `/decisions/${item.id}`;
  if (item.type === "task") return `/tasks?task=${item.id}`;
  if ((item.type === "mention" || item.type === "file" || item.type === "pin") && item.message_id)
    return `/chats/${item.room_id}?message=${item.message_id}`;
  return `/chats/${item.room_id}`;
}

function when(value) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium", timeStyle: "short",
  });
}

function DigestItem({ item }) {
  const label = ACTION_LABELS[item.type]?.[item.action] || item.type || "Update";
  return (
    <article className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-metadata text-muted">
        <span className={`text-label ${TYPE_STYLES[item.type] || "text-muted"}`}>{label}</span>
        <time dateTime={item.occurred_at || item.created_at}>{when(item.occurred_at || item.created_at)}</time>
      </div>
      <Link to={itemTarget(item)} className="mt-3 block line-clamp-3 text-h2 text-ink hover:text-brand focus-visible:rounded focus-visible:outline-2 focus-visible:outline-brand [overflow-wrap:anywhere]">
        {item.title}
      </Link>
      {item.preview && <p className="mt-2 line-clamp-2 text-body text-muted [overflow-wrap:anywhere]">{item.preview}</p>}
      {item.actor_name && <p className="mt-3 text-metadata text-muted">By {item.actor_name} · {item.room_name}</p>}
    </article>
  );
}

export default function CatchUpDigestPage() {
  const { setRoomHeader } = useOutletContext();
  const { socket } = useRealtime();
  const [digest, setDigest] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [marking, setMarking] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedRooms, setExpandedRooms] = useState(() => new Set());
  const [view, setView] = useState("all");
  const [hasLoadedOlder, setHasLoadedOlder] = useState(false);
  const [newAvailable, setNewAvailable] = useState(false);
  const refreshId = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++refreshId.current;
    try {
      const value = await getUserDigest();
      if (current !== refreshId.current) return;
      setDigest(value);
      setHasLoadedOlder(false);
      setNewAvailable(false);
      setError("");
    } catch (err) {
      if (current !== refreshId.current) return;
      setError(err.response?.data?.message || "Could not load your digest.");
    } finally {
      if (current === refreshId.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    setRoomHeader("Catch-up digest");
    return () => setRoomHeader(null);
  }, [setRoomHeader]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const update = () => {
      if (hasLoadedOlder) setNewAvailable(true);
      else void refresh();
    };
    const events = ["decision:changed", "task:updated", "chat:updated", "receive-message", "room:members"];
    events.forEach((event) => socket?.on(event, update));
    window.addEventListener("focus", update);
    window.addEventListener("conclave:digest-changed", update);
    return () => {
      events.forEach((event) => socket?.off(event, update));
      window.removeEventListener("focus", update);
      window.removeEventListener("conclave:digest-changed", update);
    };
  }, [socket, refresh, hasLoadedOlder]);

  const groups = useMemo(() => {
    const byRoom = new Map();
    for (const item of digest?.items || []) {
      if (view === "direct" && item.priority !== 0) continue;
      if (view === "work" && item.type !== "decision" && item.type !== "task") continue;
      if (view === "shared" && item.type !== "file" && item.type !== "pin") continue;
      if (!byRoom.has(item.room_id)) byRoom.set(item.room_id, {
        roomId: item.room_id, name: item.room_name, items: [], latest: item.sort_at || item.created_at,
      });
      const group = byRoom.get(item.room_id);
      group.items.push(item);
      if ((item.sort_at || item.created_at) > group.latest) group.latest = item.sort_at || item.created_at;
    }
    return [...byRoom.values()].map((group) => ({ ...group,
      items: group.items.sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1) ||
        (b.sort_at || b.created_at).localeCompare(a.sort_at || a.created_at)),
    })).sort((a, b) =>
      Math.min(...a.items.map((item) => item.priority ?? 1)) -
      Math.min(...b.items.map((item) => item.priority ?? 1)) ||
      b.latest.localeCompare(a.latest));
  }, [digest, view]);

  async function mark(roomId = null) {
    setMarking(roomId || "all");
    setError("");
    try {
      await markDigestRead({ roomId: roomId || undefined,
        roomIds: roomId ? undefined : digest.rooms.map((room) => room.room_id),
        observedAt: digest.snapshot_at });
      setStatus(roomId ? "Room catch-up marked as read." : "Catch-up marked as read.");
      setDigest((current) => current && {
        ...current,
        items: roomId ? current.items.filter((item) => item.room_id !== roomId) : [],
      });
      await refresh();
    } catch (err) {
      setError(err.response?.data?.message || "Could not mark the digest as read.");
    } finally {
      setMarking(null);
    }
  }

  async function loadOlder() {
    const cursor = digest?.next_cursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const older = await getUserDigest(cursor);
      setHasLoadedOlder(true);
      setDigest((current) => {
        if (!current || current.next_cursor !== cursor || current.snapshot_at !== older.snapshot_at) return current;
        const seen = new Set(current.items.map((item) => item.event_id));
        return { ...current,
          items: [...current.items, ...older.items.filter((item) => !seen.has(item.event_id))],
          next_cursor: older.next_cursor,
        };
      });
      setError("");
    } catch (err) {
      setError(err.response?.data?.message || "Could not load older updates.");
    } finally {
      setLoadingMore(false);
    }
  }

  if (isLoading) return <Spinner label="Loading your digest" />;

  return (
    <Page width="content">
      <p className="sr-only" role="status" aria-live="polite">{status}</p>
      {error && <p role="alert" className="mb-5 rounded-lg bg-error/10 p-4 text-body text-error">{error}</p>}
      {newAvailable && <div className="mb-5 rounded-lg border border-brand/30 bg-brand-soft p-4 text-body text-ink">
        New updates are available. <button type="button" className="text-label text-brand underline focus-visible:outline-2 focus-visible:outline-brand" onClick={() => void refresh()}>Show latest</button>
      </div>}
      {!digest?.items.length ? (
        <div className="rounded-xl border border-dashed border-line">
          <EmptyState title="Nothing to catch up on" description="New updates in your conversations will appear here." />
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-line bg-surface px-5 py-6 md:px-6">
            <p className="text-label text-muted">CATCH UP AT A GLANCE</p>
            <h1 className="mt-3 text-h1 text-ink">{digest.summary.headline}</h1>
            <p className="mt-3 text-body text-muted">{digest.summary.summary}</p>
            <p className="mt-2 text-metadata text-muted">Direct mentions and assignments appear first. Opening an item keeps it here until you mark it as read.</p>
            <Button variant="secondary" onClick={() => void mark()} disabled={Boolean(marking)} className="mt-5">
              {marking === "all" ? "Marking…" : "Mark all as read"}
            </Button>
          </div>
          <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Filter catch-up updates">
            {VIEWS.map((option) => <button key={option.id} type="button" aria-pressed={view === option.id}
              onClick={() => setView(option.id)}
              className={`rounded-full border px-3 py-2 text-label focus-visible:outline-2 focus-visible:outline-brand ${view === option.id ? "border-brand bg-brand-soft text-brand" : "border-line text-muted hover:text-ink"}`}>
              {option.label}
            </button>)}
          </div>
          {groups.length === 0 && <p className="mt-6 text-body text-muted">No updates in this filter.</p>}
          <div className="mt-8 space-y-8 pb-8">
            {groups.map((group) => (
              <section key={group.roomId} aria-label={group.name}>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <Link to={`/chats/${group.roomId}`} className="text-h2 text-ink hover:text-brand">{group.name}</Link>
                  <Button variant="secondary" onClick={() => void mark(group.roomId)} disabled={Boolean(marking)}>
                    {marking === group.roomId ? "Marking…" : "Mark room as read"}
                  </Button>
                </div>
                {(() => {
                  const direct = group.items.filter((item) => item.priority === 0);
                  const others = group.items.filter((item) => item.priority !== 0);
                  const visible = expandedRooms.has(group.roomId) ? others : others.slice(0, 5);
                  return <div className="space-y-5">
                    {direct.length > 0 && <div>
                      <h3 className="mb-3 text-label text-brand">Needs your attention · {direct.length}</h3>
                      <div className="space-y-3">{direct.map((item) => <DigestItem key={item.event_id} item={item} />)}</div>
                    </div>}
                    {others.length > 0 && <div>
                      <h3 className="mb-3 text-label text-muted">Team updates · {others.length}</h3>
                      <div className="space-y-3">{visible.map((item) => <DigestItem key={item.event_id} item={item} />)}</div>
                      {others.length > 5 && <button type="button" className="mt-3 text-label text-brand hover:underline focus-visible:outline-2 focus-visible:outline-brand"
                        onClick={() => setExpandedRooms((current) => {
                          const next = new Set(current);
                          if (next.has(group.roomId)) next.delete(group.roomId);
                          else next.add(group.roomId);
                          return next;
                        })}>{expandedRooms.has(group.roomId) ? "Show fewer" : `Show ${others.length - 5} more in this room`}</button>}
                    </div>}
                  </div>;
                })()}
              </section>
            ))}
            {digest.next_cursor && <Button variant="secondary" onClick={() => void loadOlder()} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load older updates"}
            </Button>}
          </div>
        </>
      )}
    </Page>
  );
}
