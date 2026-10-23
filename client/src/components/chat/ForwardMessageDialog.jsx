import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import { listRooms } from "../../services/rooms.service";
import { useAuth } from "../../contexts/AuthContext";
import { readRoomMetadata, saveRoomMetadata } from "../../lib/fileCache";
import { useOutbox } from "../../contexts/OutboxContext";
import { createClientId } from "../../lib/outbox";

export default function ForwardMessageDialog({ message, onClose }) {
  const [rooms, setRooms] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { user } = useAuth();
  const outbox = useOutbox();
  const navigate = useNavigate();
  useEffect(() => {
    if (!message) return;
    let active = true;
    setQuery("");
    setError("");
    setLoading(true);
    listRooms()
      .then((rows) => {
        if (active) setRooms(rows);
      })
      .catch(() => {
        if (active)
          setError(
            "Could not load conversations. Close this dialog and try again.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [message?.id]);
  async function forward(roomId) {
    setBusy(true);
    setError("");
    try {
      const files = message.attachments || [];
      const albumId = files.length > 1 ? createClientId() : undefined;
      const items = (files.length ? files : [null]).map((attachment) => ({
        content: message.content || "",
        attachments: [],
        mentionedUserIds: [],
        albumId,
        forwardSource: {
          messageId: message.id,
          ...(attachment ? { attachmentId: attachment.id } : {}),
        },
        forwardPreview: attachment ? [attachment] : [],
      }));
      const known = rooms.find((room) => room.id === roomId);
      if (known && !(await readRoomMetadata(user.id, roomId)))
        await saveRoomMetadata(user.id, roomId, {
          ...known,
          members: known.members || [],
        });
      await outbox.enqueue(roomId, items);
      onClose();
      navigate(`/chats/${roomId}`);
    } catch (err) {
      setError(err.message || "Could not save the forward on this device.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={Boolean(message)}
      onClose={onClose}
      closeDisabled={busy}
      title="Forward message"
    >
      <p className="mb-3 text-metadata text-muted">
        Choose a conversation. Media is shared without uploading another copy.
        Access is checked when the message sends.
      </p>
      <label className="block text-label text-ink">
        Search conversations
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="mt-2 min-h-11 w-full rounded-lg border border-line bg-surface px-3"
        />
      </label>
      {loading && <Spinner label="Loading conversations" />}
      {error && (
        <p role="alert" className="mt-3 text-metadata text-error">
          {error}
        </p>
      )}
      {!loading && (
        <ul className="mt-3 max-h-80 space-y-2 overflow-auto">
          {rooms
            .filter((room) =>
              (room.display_name || room.name || "")
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((room) => (
              <li key={room.id}>
                <Button
                  variant="secondary"
                  className="w-full justify-start truncate"
                  disabled={busy}
                  onClick={() => forward(room.id)}
                  aria-label={`Forward to ${room.display_name || room.name}`}
                >
                  {room.display_name || room.name}
                </Button>
              </li>
            ))}
        </ul>
      )}
      {!loading && !rooms.length && !error && (
        <p className="mt-3 text-metadata text-muted">
          No conversations are available. Open a conversation first.
        </p>
      )}
    </Modal>
  );
}
