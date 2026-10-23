import { useEffect, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import Spinner from "@/components/ui/Spinner";
import Page from "@/components/layout/Page";
import { useToast } from "@/contexts/ToastContext";
import { discoverRooms, joinPublicRoom } from "@/services/rooms.service";

export default function DiscoverRooms() {
  const { setRoomHeader } = useOutletContext();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setRoomHeader("Discover rooms");
    return () => setRoomHeader(null);
  }, [setRoomHeader]);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(
      async () => {
        setLoading(true);
        setError("");
        try {
          const result = await discoverRooms({ q: query });
          if (active) setRooms(result.rooms || []);
        } catch (err) {
          if (active)
            setError(
              err.response?.data?.message || "Could not find public rooms.",
            );
        } finally {
          if (active) setLoading(false);
        }
      },
      query ? 200 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);

  async function join(room) {
    setJoining(room.id);
    try {
      const result=await joinPublicRoom(room.id);
      if(result.status==='pending'){toast({title:"Join request sent",description:"An admin must approve your request."});return;}
      toast({ title: `Joined ${room.name}`, tone: "success" });
      navigate(`/chats/${room.id}`);
    } catch (err) {
      toast({
        title: "Could not join this room",
        description: err.response?.data?.message || "Please try again.",
        tone: "error",
      });
    } finally {
      setJoining(null);
    }
  }

  return (
    <Page width="content">
      <h1 className="text-h1 text-ink">Discover public rooms</h1>
      <p className="mt-2 max-w-2xl text-body leading-relaxed text-muted">
        Public rooms can be found and joined by signed-in members. Their
        messages remain available to members only.
      </p>
      <label className="mt-6 block max-w-xl">
        <span className="mb-2 block text-label text-ink">Search rooms</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-h-12 w-full rounded-lg border border-line bg-surface px-3.5 text-body text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
          placeholder="Search by name or description"
        />
      </label>

      {loading && (
        <div className="mt-8">
          <Spinner label="Finding rooms" />
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="mt-6 rounded-lg bg-error/10 p-4 text-body text-error"
        >
          {error}
        </p>
      )}
      {!loading && !error && rooms.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-line">
          <EmptyState
            title={
              query ? "No public rooms match" : "No public rooms to discover"
            }
            description={
              query
                ? "Try another search."
                : "Public rooms created by your team will appear here."
            }
          />
        </div>
      )}
      {!loading && rooms.length > 0 && (
        <ul className="mt-6 grid gap-3 md:grid-cols-2">
          {rooms.map((room) => (
            <li key={room.id}>
              <article className="flex h-full flex-col rounded-xl border border-line bg-surface p-5">
                <h2 className="text-h2 text-ink [overflow-wrap:anywhere]">
                  {room.name}
                </h2>
                <p className="mt-2 flex-1 text-body leading-relaxed text-muted [overflow-wrap:anywhere]">
                  {room.description || "No description provided."}
                </p>
                <div className="mt-5 flex items-center justify-between gap-3">
                  <span className="text-metadata text-muted">
                    {room.member_count}{" "}
                    {room.member_count === 1 ? "member" : "members"}
                  </span>
                  <Button
                    disabled={joining !== null}
                    onClick={() => join(room)}
                  >
                    {joining === room.id ? "Joining…" : "Join room"}
                  </Button>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
