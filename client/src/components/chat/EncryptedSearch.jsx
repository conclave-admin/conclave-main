import { conversationMessageVisible } from "../../lib/clearedConversations";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { localConversationMessages } from "../../services/messages.service";
import Input from "../ui/Input";
import Button from "../ui/Button";
export default function EncryptedSearch({ room }) {
  const { user } = useAuth();
  const [term, setTerm] = useState(""),
    [results, setResults] = useState([]),
    [searched, setSearched] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    setResults([]);
    setSearched(false);
    const cleared = (event) => {
      if (event.detail?.userId !== user.id || event.detail?.roomId !== room.id)
        return;
      generation.current++;
      setResults([]);
      setSearched(false);
    };
    window.addEventListener("conclave:conversation-cleared", cleared);
    return () => {
      generation.current++;
      window.removeEventListener("conclave:conversation-cleared", cleared);
    };
  }, [user.id, room.id]);
  if (room?.encryption_mode !== "e2ee-v1") return null;
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-5">
      <h2 className="text-h2 text-ink">Search on this device</h2>
      <p className="text-body text-muted">
        Search messages already available on this device. Search text stays
        here.
      </p>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const version = ++generation.current;
          setError("");
          try {
            const rows = await localConversationMessages(room.id);
            if (version !== generation.current) return;
            setResults(
              rows
                .filter(
                  (m) =>
                    conversationMessageVisible(m, user.id, room.id) &&
                    !m.is_deleted &&
                    !m.deleted_at &&
                    m._decrypted &&
                    m.content?.toLowerCase().includes(term.toLowerCase()),
                )
                .slice(0, 50),
            );
            setSearched(true);
          } catch (e) {
            if (version === generation.current) setError(e.message);
          }
        }}
      >
        <Input
          label="Search encrypted messages"
          value={term}
          required
          onChange={(e) => setTerm(e.target.value)}
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      {results.map((m) => (
        <Link
          className="block rounded-lg border border-line p-3 text-body text-ink"
          key={m.id}
          to={`/chats/${room.id}?message=${encodeURIComponent(m.id)}`}
        >
          {m.content.slice(0, 200)}
        </Link>
      ))}
      {searched && !results.length && (
        <p className="text-body text-muted">
          No matching messages are available on this device.
        </p>
      )}
      {error && (
        <p role="alert" className="text-body text-error">
          {error}
        </p>
      )}
    </section>
  );
}
