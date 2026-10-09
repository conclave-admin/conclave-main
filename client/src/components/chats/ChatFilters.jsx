import { useNavigate, useSearchParams } from 'react-router-dom';
import IconSearch from '@/assets/icons/search.svg?react';

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
 * The search field is `?q=` on the same URL, and is shown below `md` only.
 * Above that the header carries the same field; two inputs bound to one
 * parameter is two controls, but two pieces of independent search state would
 * be two different answers to the same question.
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
  const navigate = useNavigate();

  const active = params.get('filter') || '';
  const query = params.get('q') || '';

  const setQuery = (value) => {
    const next = new URLSearchParams(params);
    if (value) next.set('q', value);
    else next.delete('q');
    setParams(next, { replace: true });
  };

  const FILTERS = [
    { value: '', label: 'All' },
    { value: 'unread', label: 'Unread' },
    { value: 'groups', label: 'Groups' },
    { value: 'dms', label: 'DMs' },
  ];

  return (
    <div className="sticky top-0 z-10 border-b border-line bg-surface px-3 pb-3 pt-4">
      <label className="relative block md:hidden">
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
          className="min-h-10 w-full rounded-lg border border-line bg-canvas pl-9 pr-3 text-body text-ink outline-none transition-shadow placeholder:text-muted/70 focus:border-brand focus:ring-2 focus:ring-brand/15"
        />
      </label>

      <div className="flex gap-1.5 overflow-x-auto">
        {FILTERS.map((filter) => {
          const selected = filter.value === active;
          return (
            <button
              key={filter.value || 'all'}
              type="button"
              aria-pressed={selected}
              onClick={() => navigate(filter.value ? `/chats?filter=${filter.value}` : '/chats')}
              className={`min-h-8 shrink-0 rounded-full px-3 text-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                selected
                  ? 'bg-brand font-semibold text-surface'
                  : 'bg-canvas text-muted hover:text-ink'
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
