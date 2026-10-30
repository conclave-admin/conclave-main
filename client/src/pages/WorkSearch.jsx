import { useEffect, useState } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import Page from "@/components/layout/Page";
import { searchWork } from "@/services/work.service";

function target(item) {
  if (item.type === "decision") return `/decisions/${item.id}`;
  if (item.type === "task") return `/tasks?task=${item.id}`;
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
  useEffect(() => { setRoomHeader("Search all"); return () => setRoomHeader(null); }, [setRoomHeader]);
  useEffect(() => { setDraft(query); }, [query]);
  useEffect(() => {
    if (query.trim().length < 2) { setResult(null); return; }
    let active = true;
    searchWork(query.trim()).then((data) => { if (active) { setResult(data); setError(""); } })
      .catch((e) => { if (active) setError(e.response?.data?.error?.message || "Search failed"); });
    return () => { active = false; };
  }, [query]);
  return <Page width="content"><h1 className="text-h1">Search all</h1>
    <p className="mt-2 text-body text-muted">Find messages, files, decisions, tasks, conversations and people you can access. Encrypted message content is excluded.</p>
    <form className="mt-5 flex gap-2" onSubmit={(event) => { event.preventDefault(); setParams({ q: draft.trim() }); }}>
      <input aria-label="Search all work" type="search" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={100} minLength={2}
        className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-body" placeholder="Search across your work" />
      <button className="rounded-lg bg-brand px-4 text-label text-white" disabled={draft.trim().length < 2}>Search</button>
    </form>
    {error && <p role="alert" className="mt-4 text-error">{error}</p>}
    {result && <div className="mt-6 space-y-2">{result.items.length === 0 && <p className="text-body text-muted">No results found.</p>}
      {result.items.map((item) => <Link key={`${item.type}:${item.id}`} to={target(item)} className="block rounded-xl border border-line bg-surface p-4 hover:border-brand">
        <span className="text-metadata uppercase text-brand">{item.type}{item.room_name ? ` · ${item.room_name}` : ""}</span>
        <strong className="mt-1 block break-words text-label text-ink">{item.title || "Untitled"}</strong>
      </Link>)}{result.hasMore && <p className="text-metadata text-muted">Showing the first 50 matches. Narrow your search for more.</p>}</div>}
  </Page>;
}
