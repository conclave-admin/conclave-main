import { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import Page from "@/components/layout/Page";
import { searchWork } from "@/services/work.service";
import { listRooms } from "@/services/rooms.service";

function target(item) {
  if (item.type === "decision") return `/decisions/${item.id}`;
  if (item.type === "task") return `/tasks?task=${item.id}`;
  if (item.type === "person") return `/profile/${item.id}`;
  if (item.type === "message" || item.type === "file") return `/chats/${item.room_id}?message=${item.message_id || item.id}`;
  if (item.type === "room") return `/chats/${item.id}`;
  return `/new?q=${encodeURIComponent(item.title)}`;
}
export default function WorkSearch() {
  const { setRoomHeader } = useOutletContext();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") || "";
  const [draft, setDraft] = useState(query);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [rooms, setRooms] = useState([]);
  const type = params.get("type") || "all";
  const roomId = params.get("roomId") || "";
  const authorId = params.get("authorId") || "";
  const after = params.get("after") || "";
  const before = params.get("before") || "";
  const sort = params.get("sort") || "relevance";
  const page = Math.max(1, Number.parseInt(params.get("page"), 10) || 1);
  useEffect(() => { setRoomHeader("Search all"); return () => setRoomHeader(null); }, [setRoomHeader]);
  useEffect(() => { setDraft(query); }, [query]);
  useEffect(() => { listRooms().then(setRooms).catch(() => setRooms([])); }, []);
  useEffect(() => {
    if (query.trim().length < 2) { setResult(null); return; }
    let active = true;
    searchWork(query.trim(), { type, roomId: roomId || undefined, authorId: authorId || undefined, after: after || undefined, before: before || undefined, sort, page })
      .then((data) => { if (active) { setResult(data); setError(""); } })
      .catch((e) => { if (active) setError(e.response?.data?.error?.message || "Search failed"); });
    return () => { active = false; };
  }, [query, type, roomId, authorId, after, before, sort, page]);
  const authors = useMemo(() => [...new Map((result?.items || []).filter((item) => item.type !== "person" && item.author_id && item.author_name).map((item) => [item.author_id, { id: item.author_id, name: item.author_name }])).values()], [result]);
  const updateFilters = (updates) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(updates)) {
      if (!value || value === "all" || value === "relevance") next.delete(key);
      else next.set(key, value);
    }
    if (!("page" in updates)) next.delete("page");
    setParams(next);
  };
  return <Page width="content"><h1 className="text-h1">Search all</h1>
    <p className="mt-2 text-body text-muted">Search conversations, messages, files and shared work.</p>
    <form className="mt-5 flex gap-2" onSubmit={(event) => { event.preventDefault(); const next = new URLSearchParams(params); next.set("q", draft.trim()); next.delete("page"); setParams(next); }}>
      <input aria-label="Search all work" type="search" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={100} minLength={2}
        className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-body" placeholder="Search across your work" />
      <button className="rounded-lg bg-brand px-4 text-label text-white" disabled={draft.trim().length < 2}>Search</button>
    </form>
    <div className="mt-4 grid gap-3 rounded-xl border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="grid gap-1 text-metadata text-muted">Content type<select value={type} onChange={(e) => updateFilters({ type: e.target.value, authorId: e.target.value === "person" ? "" : authorId })} className="min-h-10 rounded-lg border border-line bg-surface px-2 text-body text-ink"><option value="all">All results</option><option value="message">Messages</option><option value="file">Files</option><option value="decision">Decisions</option><option value="task">Tasks</option><option value="room">Rooms</option><option value="person">People</option></select></label>
      <label className="grid gap-1 text-metadata text-muted">Conversation<select value={roomId} onChange={(e) => updateFilters({ roomId: e.target.value })} className="min-h-10 rounded-lg border border-line bg-surface px-2 text-body text-ink"><option value="">All conversations</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.display_name || room.name}</option>)}</select></label>
      <label className="grid gap-1 text-metadata text-muted">From person<select value={authorId} onChange={(e) => updateFilters({ authorId: e.target.value })} className="min-h-10 rounded-lg border border-line bg-surface px-2 text-body text-ink"><option value="">Anyone</option>{authors.map((author) => <option key={author.id} value={author.id}>{author.name}</option>)}</select></label>
      <label className="grid gap-1 text-metadata text-muted">Order<select value={sort} onChange={(e) => updateFilters({ sort: e.target.value })} className="min-h-10 rounded-lg border border-line bg-surface px-2 text-body text-ink"><option value="relevance">Most relevant</option><option value="recent">Most recent</option></select></label>
      <label className="grid gap-1 text-metadata text-muted">From date<input aria-label="From date" type="date" value={after} onChange={(e) => updateFilters({ after: e.target.value })} className="min-h-10 rounded-lg border border-line bg-surface px-2 text-body text-ink" /></label>
      <label className="grid gap-1 text-metadata text-muted">Through date<input aria-label="Through date" type="date" value={before} onChange={(e) => updateFilters({ before: e.target.value })} className="min-h-10 rounded-lg border border-line bg-surface px-2 text-body text-ink" /></label>
      {(type !== "all" || roomId || authorId || after || before || sort !== "relevance") && <button type="button" onClick={() => updateFilters({ type: "all", roomId: "", authorId: "", after: "", before: "", sort: "relevance" })} className="self-end justify-self-start rounded-lg px-3 py-2 text-label text-brand hover:bg-brand-soft">Clear filters</button>}
    </div>
    {query.trim().length < 2 && <p className="mt-6 text-body text-muted">Enter at least two characters to search.</p>}
    {error && <p role="alert" className="mt-4 text-error">{error}</p>}
    {result && <div className="mt-6 space-y-2">{result.items.length === 0 && <p className="text-body text-muted">No results found.</p>}
      {result.items.map((item) => <Link key={`${item.type}:${item.id}`} to={target(item)} className="block rounded-xl border border-line bg-surface p-4 hover:border-brand">
        <span className="text-metadata uppercase text-brand">{item.type}{item.room_name ? ` · ${item.room_name}` : ""}{item.author_name ? ` · ${item.author_name}` : ""}</span>
        <strong className="mt-1 block break-words text-label text-ink">{item.title || "Untitled"}</strong>
        {item.type === "message" && <span className="mt-1 block text-metadata text-muted">Message</span>}
      </Link>)}<div className="flex items-center justify-between pt-2"><button type="button" disabled={page <= 1} onClick={() => updateFilters({ page: String(page - 1) })} className="rounded-lg border border-line px-3 py-2 text-label text-ink disabled:opacity-40">Previous</button><span className="text-metadata text-muted">Page {page}</span><button type="button" disabled={!result.hasMore} onClick={() => { const next = new URLSearchParams(params); next.set("page", String(page + 1)); setParams(next); }} className="rounded-lg border border-line px-3 py-2 text-label text-ink disabled:opacity-40">Next</button></div></div>}
  </Page>;
}
