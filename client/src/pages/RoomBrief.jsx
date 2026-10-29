import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import Page from "@/components/layout/Page";
import Spinner from "@/components/ui/Spinner";
import { getRoomBrief, saveRoomBrief } from "@/services/work.service";

export default function RoomBrief() {
  const { roomId } = useParams();
  const { setRoomHeader } = useOutletContext();
  const [data, setData] = useState(null);
  const [body, setBody] = useState("");
  const [source, setSource] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { const result = await getRoomBrief(roomId); setData(result); setBody(result.brief?.body || ""); setSource(result.brief?.source_message_id || ""); setError(""); }
    catch (e) { setError(e.response?.data?.error?.message || "Could not load brief"); }
  }, [roomId]);
  useEffect(() => { setRoomHeader("Conversation brief"); void refresh(); return () => setRoomHeader(null); }, [refresh, setRoomHeader]);
  async function save(event) {
    event.preventDefault(); setSaving(true); setError("");
    try { await saveRoomBrief(roomId, { body, sourceMessageId: source || null, version: data.brief?.version || null }); await refresh(); setEditing(false); }
    catch (e) { setError(e.response?.data?.error?.message || "Could not save brief"); }
    finally { setSaving(false); }
  }
  return <Page width="content"><Link to={`/chats/${roomId}`} className="text-label text-brand hover:underline">← Conversation</Link>
    <h1 className="mt-4 text-h1">Conversation brief</h1>
    <p className="mt-2 text-body text-muted">A durable summary maintained by room admins. It is not generated automatically.</p>
    {error && <p role="alert" className="mt-4 text-body text-error">{error}</p>}
    {!data ? <Spinner label="Loading brief" /> : <>
      {!editing ? <section className="mt-6 rounded-xl border border-line bg-surface p-5">
        {data.brief ? <><p className="whitespace-pre-wrap break-words text-body text-ink">{data.brief.body || "No brief text yet."}</p>
          <p className="mt-4 text-metadata text-muted">Version {data.brief.version} · Updated by {data.brief.editor_name} · {new Date(data.brief.updated_at).toLocaleString()}</p>
          {data.brief.source_message_id && <Link to={`/chats/${roomId}?message=${data.brief.source_message_id}`} className="mt-2 block text-label text-brand hover:underline">Open source message</Link>}</>
          : <p className="text-body text-muted">No brief has been written yet.</p>}
        <button type="button" onClick={() => setEditing(true)} className="mt-4 rounded-lg bg-brand px-4 py-2 text-label text-white">Edit brief</button>
      </section> : <form onSubmit={save} className="mt-6 space-y-3 rounded-xl border border-line bg-surface p-5">
        <label className="block text-label">Brief<textarea className="mt-2 min-h-48 w-full rounded-lg border border-line bg-surface p-3 text-body" value={body} maxLength={10000} onChange={(e) => setBody(e.target.value)} /></label>
        <label className="block text-label">Source message ID (optional)<input className="mt-2 w-full rounded-lg border border-line bg-surface p-3 text-body" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Paste a message ID" /></label>
        <div className="flex gap-2"><button disabled={saving} className="rounded-lg bg-brand px-4 py-2 text-label text-white">{saving ? "Saving…" : "Save brief"}</button>
          <button type="button" onClick={() => setEditing(false)} className="rounded-lg border border-line px-4 py-2 text-label">Cancel</button></div>
      </form>}
      {data.revisions.length > 0 && <section className="mt-6"><h2 className="text-h2">Revision history</h2><ul className="mt-3 space-y-2">{data.revisions.map((revision) =>
        <li key={revision.version} className="rounded-lg border border-line bg-surface p-3 text-body"><details><summary className="cursor-pointer">Version {revision.version} · {revision.editor_name} · {new Date(revision.changed_at).toLocaleString()}</summary>
          <p className="mt-3 whitespace-pre-wrap break-words text-body">{revision.body || "Empty brief"}</p></details></li>)}</ul></section>}
    </>}
  </Page>;
}
