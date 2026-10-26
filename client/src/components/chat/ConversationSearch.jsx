import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { localConversationMessages } from "../../services/messages.service";
import Modal from "../ui/Modal";
import Input from "../ui/Input";
import Button from "../ui/Button";
export default function ConversationSearch({ room, open, onClose }) {
  const [query, setQuery] = useState(""),
    [rows, setRows] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [searched, setSearched] = useState(false),
    [sender, setSender] = useState(""),
    [after, setAfter] = useState("");
  const revision = useRef(0),
    navigate = useNavigate();
  useEffect(
    () => () => {
      revision.current++;
    },
    [open, room.id],
  );
  const encrypted = room.encryption_mode === "e2ee-v1";
  return (
    <Modal open={open} onClose={onClose} title="Search conversation" size="lg">
      <p className="mb-4 text-body text-muted">
        {encrypted
          ? "Searches decrypted messages available on this device. Older history may not be included. Search words stay on your device."
          : "Search visible messages in this conversation."}
      </p>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const version = ++revision.current;
          setBusy(true);
          setError("");
          try {
            let found = encrypted
              ? await localConversationMessages(room.id)
              : (
                  await api.get(`/messages/room/${room.id}/search`, {
                    params: { q: query.trim() },
                  })
                ).data.data.messages;
            if (encrypted)
              found = found.filter(
                (m) =>
                  m._decrypted &&
                  !m.is_deleted &&
                  !m.deleted_at &&
                  m.content
                    ?.toLocaleLowerCase()
                    .includes(query.trim().toLocaleLowerCase()),
              );
            found = found.filter(
              (m) =>
                (!sender || m.sender_id === sender) &&
                (!after || new Date(m.created_at) >= new Date(after)),
            );
            if (version !== revision.current) return;
            setRows(found.slice(0, 50));
            setSearched(true);
          } catch (e) {
            if (version === revision.current)
              setError(
                e.response?.data?.message ||
                  "Could not search. Check your connection and try again.",
              );
          } finally {
            if (version === revision.current) setBusy(false);
          }
        }}
      >
        <Input
          label="Search messages"
          type="search"
          required
          minLength={1}
          maxLength={200}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-label">
            From
            <select
              className="mt-2 min-h-11 w-full rounded-xl border border-line bg-surface px-3"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
            >
              <option value="">Anyone</option>
              {room.members?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </label>
          <Input
            label="On or after"
            type="date"
            value={after}
            onChange={(e) => setAfter(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "Searching…" : "Search"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-4 text-body text-error">
          {error}
        </p>
      )}
      <div className="mt-5 max-h-[45dvh] space-y-2 overflow-y-auto">
        {rows.map((m) => (
          <button
            key={m.id}
            type="button"
            className="block w-full rounded-xl border border-line p-3 text-left hover:bg-canvas"
            onClick={() => {
              onClose();
              navigate(
                `/chats/${room.id}?message=${m.id}&q=${encodeURIComponent(query.trim())}`,
              );
            }}
          >
            <span className="block text-label text-brand">
              {m.sender_name || "Message"} ·{" "}
              {new Date(m.created_at).toLocaleString()}
            </span>
            <span className="mt-1 line-clamp-3 block break-words text-body">
              {m.content}
            </span>
          </button>
        ))}
      </div>
      {searched && !rows.length && (
        <p role="status" className="mt-4 text-body text-muted">
          No matching messages. Try different words or filters.
        </p>
      )}
      {rows.length === 50 && (
        <p className="mt-3 text-metadata text-muted">
          Showing up to 50 results. Refine your search for more specific
          matches.
        </p>
      )}
    </Modal>
  );
}
