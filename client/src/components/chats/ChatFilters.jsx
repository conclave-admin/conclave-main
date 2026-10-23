import { Link, useSearchParams } from "react-router-dom";
import IconCompose from "@/assets/icons/compose.svg?react";
import IconSearch from "@/assets/icons/search.svg?react";

/**
 * The four chips are navigation, not local state.
 *
 * Each one writes `?filter=` on `/chats`, so the URL is the single source of
 * truth for what the list is showing. That is what makes the sidebar's DMs
 * item work without a second implementation: `/dms` is a redirect into
 * `/chats?filter=dms`, and from that point the chip and the route agree by
 * construction. With chips as React state, `/dms` and the chips would be two
 * competing answers to "what am I looking at", and the list could render
 * unread rows while the sidebar highlighted DMs.
 *
 * Both the filter and the search update the parameters in place rather than
 * navigating: navigating rebuilt the URL from scratch, which dropped `?q=` on
 * every chip press and threw away the open room, so filtering by Unread
 * silently discarded the search being typed alongside it.
 *
 * The search field is `?q=` on the same URL. It lives here, next to the list it
 * filters and the chips that narrow it, at every width — the header used to
 * carry a second copy for `md` and up, and two inputs bound to one parameter
 * meant two controls answering one question.
 *
 * Search matches room name only. Message search is a different endpoint —
 * `GET /messages/room/:roomId/search` — and it is scoped to a room you are
 * already inside, so nothing here can search across rooms. Wiring it to this
 * box would mean either one request per room or implying a capability the API
 * does not have.
 *
 * History is replaced rather than pushed as you type: a back button that walks
 * one character at a time is worse than no history at all.
 */
export default function ChatFilters() {
  const [params, setParams] = useSearchParams();

  const active = params.get("filter") || "";
  const query = params.get("q") || "";

  const setQuery = (value) => {
    const next = new URLSearchParams(params);
    if (value) next.set("q", value);
    else next.delete("q");
    setParams(next, { replace: true });
  };

  const selectFilter = (value) => {
    const next = new URLSearchParams(params);
    if (value) next.set("filter", value);
    else next.delete("filter");
    setParams(next, { replace: true });
  };

  const FILTERS = [
    { value: "", label: "All" },
    { value: "unread", label: "Unread" },
    { value: "groups", label: "Groups" },
    { value: "dms", label: "Direct" },
    { value: "archived", label: "Archived" },
  ];

  return (
    <div className="sticky top-0 z-10 border-b border-line/60 bg-surface px-4 pb-4 pt-4">
      <div className="flex items-center gap-2">
        <label className="relative block min-w-0 flex-1">
          <span className="sr-only">Search chats</span>
          <IconSearch
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            className="min-h-10 w-full rounded-xl border border-transparent bg-canvas pl-9 pr-3 text-body text-ink outline-none transition-shadow placeholder:text-muted/70 focus:border-brand focus:ring-2 focus:ring-brand/15"
          />
        </label>

        <Link
          to="/new"
          aria-label="New chat"
          title="New chat"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
        >
          <IconCompose className="h-5 w-5" aria-hidden="true" />
        </Link>
      </div>

      <div className="scrollbar-none mt-3 flex gap-1.5 overflow-x-auto">
        {FILTERS.map((filter) => {
          const selected = filter.value === active;
          return (
            <button
              key={filter.value || "all"}
              type="button"
              aria-pressed={selected}
              onClick={() => selectFilter(filter.value)}
              className={`min-h-10 shrink-0 rounded-full px-3 text-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                selected
                  ? "bg-brand font-semibold text-surface"
                  : "bg-canvas text-muted hover:text-ink"
              }`}
            >
              {filter.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
