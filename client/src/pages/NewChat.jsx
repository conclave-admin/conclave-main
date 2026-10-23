import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import IconGroup from "@/assets/icons/group.svg?react";
import IconSearch from "@/assets/icons/search.svg?react";
import IconThread from "@/assets/icons/thread.svg?react";
import Avatar from "@/components/ui/Avatar";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import Input from "@/components/ui/Input";
import Spinner from "@/components/ui/Spinner";
import { useToast } from "@/contexts/ToastContext";
import { createRoom } from "@/services/rooms.service";
import { searchUsers } from "@/services/users.service";
import Page from "@/components/layout/Page";

// Long enough that typing a name is not a request per keystroke, short enough
// that the list feels attached to the keyboard rather than lagging behind it.
const SEARCH_DEBOUNCE_MS = 250;

/**
 * New chat — find a person, or start a group. `/new`.
 *
 * This is where the rail's "Invite members" entry, the mobile compose button and
 * every "start a conversation" call to action land.
 *
 * Both actions go through `POST /rooms`. A DM is the same call with one member
 * and `type: 'dm'`, and it is idempotent server-side: asking twice returns 200
 * and the room that already exists rather than 201 and a duplicate. Both
 * responses carry the room to open, so the caller does not branch on it — the
 * only thing worth surfacing is that it already existed.
 *
 * Email is matched by the search endpoint but never returned, so nobody can read
 * the workspace's address book by typing into this box. See users.service.js.
 */
export default function NewChat() {
  const navigate = useNavigate();
  const { setRoomHeader } = useOutletContext();
  const { toast } = useToast();

  const [mode, setMode] = useState("dm");
  const [term, setTerm] = useState("");
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selected, setSelected] = useState([]);
  const [groupName, setGroupName] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [isCreating, setIsCreating] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    setRoomHeader("New chat");
    return () => setRoomHeader(null);
  }, [setRoomHeader]);

  // Search runs on a timer, and every pending timer is cancelled on the way out.
  // Without the cleanup, navigating away mid-debounce sets state on an unmounted
  // component and can land a stale result list on the next mount.
  useEffect(() => {
    const q = term.trim();
    if (!q) {
      setResults([]);
      setIsSearching(false);
      return undefined;
    }
    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const found = await searchUsers(q);
        setResults(found);
      } catch {
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(debounceRef.current);
  }, [term]);

  // Switching mode resets the form. A group selection carried into DM mode would
  // silently become a second member of what should have been a one-to-one chat.
  function switchMode(next) {
    setMode(next);
    setSelected([]);
    if (next === "dm") setGroupName("");
  }

  const selectedUsers = useMemo(
    () =>
      selected
        .map((id) => results.find((person) => person.id === id))
        .filter(Boolean),
    [selected, results],
  );

  function toggleSelected(person) {
    setSelected((prev) =>
      prev.includes(person.id)
        ? prev.filter((id) => id !== person.id)
        : [...prev, person.id],
    );
  }

  async function startDm(person) {
    setIsCreating(true);
    try {
      const room = await createRoom({ type: "dm", memberIds: [person.id] });
      if (room.existing) {
        toast({
          title: `Opening your existing chat with ${person.display_name}`,
        });
      }
      navigate(`/chats/${room.id}`);
    } catch (err) {
      toast({
        title: "Could not start the conversation",
        description: err.response?.data?.message || "Please try again.",
        tone: "error",
      });
    } finally {
      setIsCreating(false);
    }
  }

  async function createGroup(event) {
    event.preventDefault();
    if (selected.length === 0) return;
    setIsCreating(true);
    try {
      const room = await createRoom({
        type: visibility,
        name: groupName.trim(),
        memberIds: selected,
      });
      navigate(`/chats/${room.id}`);
    } catch (err) {
      toast({
        title: "Could not create the room",
        description: err.response?.data?.message || "Please try again.",
        tone: "error",
      });
    } finally {
      setIsCreating(false);
    }
  }

  const canCreateGroup = groupName.trim().length > 0 && selected.length > 0;

  return (
    <Page width="form">
      <h1 className="text-h1 text-ink">New chat</h1>
      <p className="mt-2 text-body leading-relaxed text-muted">
        Message someone directly, or gather several people into a new room.
      </p>
      <Link
        to="/discover"
        className="mt-3 inline-flex text-label text-brand hover:underline"
      >
        Browse public rooms
      </Link>

      <div
        role="tablist"
        aria-label="Conversation type"
        className="mt-6 inline-flex gap-1 rounded-full border border-line bg-canvas p-1"
      >
        {[
          { value: "dm", label: "Direct message", Icon: IconThread },
          { value: "group", label: "New room", Icon: IconGroup },
        ].map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => switchMode(value)}
            className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
              mode === value
                ? "bg-brand font-semibold text-surface"
                : "text-muted hover:bg-surface hover:text-ink"
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      <div className="relative mt-6">
        <IconSearch
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
          aria-hidden="true"
        />
        <input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search by name"
          aria-label="Search people"
          className="min-h-12 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-body text-ink outline-none transition-shadow placeholder:text-muted/70 focus:border-brand focus:ring-2 focus:ring-brand/15"
        />
      </div>

      {mode === "group" && selected.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {selectedUsers.map((person) => (
            <button
              key={person.id}
              type="button"
              onClick={() => toggleSelected(person)}
              className="inline-flex items-center gap-2 rounded-full border border-line bg-canvas py-1 pl-1 pr-3 text-metadata text-ink transition-colors hover:border-brand"
            >
              <Avatar
                name={person.display_name}
                src={person.avatar_url}
                size="sm"
              />
              {person.display_name}
              <span aria-hidden="true" className="text-muted">
                ×
              </span>
              <span className="sr-only">Remove {person.display_name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-4 min-h-16">
        {isSearching && <Spinner label="Searching" />}

        {!isSearching && !term.trim() && (
          <EmptyState
            title="Find someone"
            description="Search by name to start a direct message, or pick several to make a room."
          />
        )}

        {!isSearching && term.trim() && results.length === 0 && (
          <EmptyState
            title="Nobody found"
            description={`No one matches “${term.trim()}”.`}
          />
        )}

        {!isSearching && results.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {results.map((person) => (
              <li key={person.id}>
                {mode === "dm" ? (
                  <button
                    type="button"
                    disabled={isCreating}
                    onClick={() => startDm(person)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/30"
                  >
                    <Avatar
                      name={person.display_name}
                      src={person.avatar_url}
                    />
                    <span className="min-w-0 flex-1 truncate text-body text-ink">
                      {person.display_name}
                    </span>
                    <span className="shrink-0 text-metadata text-brand">
                      Message
                    </span>
                  </button>
                ) : (
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-canvas">
                    <input
                      type="checkbox"
                      checked={selected.includes(person.id)}
                      onChange={() => toggleSelected(person)}
                      className="h-4 w-4 shrink-0 rounded border-line text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                    />
                    <Avatar
                      name={person.display_name}
                      src={person.avatar_url}
                    />
                    <span className="min-w-0 flex-1 truncate text-body text-ink">
                      {person.display_name}
                    </span>
                  </label>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {mode === "group" && (
        <form
          onSubmit={createGroup}
          className="mt-6 space-y-4 border-t border-line pt-6"
        >
          <label className="block text-label text-ink">
            Room visibility
            <select
              value={visibility}
              onChange={(event) => setVisibility(event.target.value)}
              className="mt-2 block min-h-12 w-full rounded-lg border border-line bg-surface px-3.5 text-body text-ink"
            >
              <option value="private">Private — invitation required</option>
              <option value="public">
                Public — members can discover and join
              </option>
            </select>
          </label>
          <Input
            label="Room name"
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            placeholder="Design Crit"
            maxLength={100}
            required
          />
          <Button type="submit" disabled={!canCreateGroup || isCreating}>
            {isCreating
              ? "Creating…"
              : selected.length === 0
                ? "Pick at least one person"
                : `Create room with ${selected.length} ${selected.length === 1 ? "person" : "people"}`}
          </Button>
        </form>
      )}
    </Page>
  );
}
