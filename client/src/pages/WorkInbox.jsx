import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import Page from "@/components/layout/Page";
import Spinner from "@/components/ui/Spinner";
import { getWorkInbox, setWorkInboxState } from "@/services/work.service";

const target = (item) => item.type === "mention"
  ? `/chats/${item.room_id}?message=${item.id}` : `/tasks?task=${item.id}`;
const label = { assignment: "Assigned to you", mention: "Mentioned you", blocked: "Blocked task", overdue: "Overdue task" };

export default function WorkInbox() {
  const { setRoomHeader } = useOutletContext();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const refresh = useCallback(async () => {
    try { const result = await getWorkInbox(); setItems(result.items); setHasMore(result.hasMore); setError(""); }
    catch (e) { setError(e.response?.data?.error?.message || "Could not load your work"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { setRoomHeader("My work"); void refresh(); return () => setRoomHeader(null); }, [refresh, setRoomHeader]);
  async function change(item, state) {
    setBusy(item.event_key); setError("");
    try {
      const until = state === "snoozed" ? new Date(Date.now() + 86400000).toISOString() : undefined;
      await setWorkInboxState({ eventKey: item.event_key, state, until });
      await refresh();
    } catch (e) { setError(e.response?.data?.error?.message || "Could not update item"); }
    finally { setBusy(""); }
  }
  return <Page width="content">
    <h1 className="text-h1">My work</h1>
    <p className="mt-2 text-body text-muted">Assignments, mentions, blockers and deadlines across your conversations.</p>
    {error && <p role="alert" className="mt-4 text-body text-error">{error}</p>}
    {loading ? <Spinner label="Loading your work" /> : <div className="mt-6 space-y-3">
      {items.length === 0 && <p className="rounded-xl border border-dashed border-line p-6 text-body text-muted">You are caught up.</p>}
      {items.map((item) => <article key={item.event_key} className="rounded-xl border border-line bg-surface p-4">
        <p className="text-metadata font-semibold text-brand">{label[item.type]} · {item.room_name}</p>
        <Link to={target(item)} className="mt-2 block text-h2 text-ink hover:text-brand">{item.title || label[item.type]}</Link>
        <p className="mt-1 text-metadata text-muted">{item.due_date ? `Due ${item.due_date} · ` : ""}{new Date(item.occurred_at).toLocaleString()}</p>
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={!!busy} onClick={() => void change(item, "done")} className="rounded-lg border border-line px-3 py-2 text-label hover:border-brand">Done</button>
          <button type="button" disabled={!!busy} onClick={() => void change(item, "snoozed")} className="rounded-lg border border-line px-3 py-2 text-label hover:border-brand">Snooze 1 day</button>
        </div>
      </article>)}
      {hasMore && <p className="text-metadata text-muted">Showing the 100 most recent items.</p>}
    </div>}
  </Page>;
}
