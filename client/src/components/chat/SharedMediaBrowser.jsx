import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listRoomMedia } from "../../services/messages.service";
import { getConversationClearTime } from "../../lib/clearedConversations";
import AttachmentCard from "./AttachmentCard";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";

const sections = [
  {
    kind: "media",
    label: "Media",
    empty: "No photos or videos have been shared yet.",
  },
  {
    kind: "documents",
    label: "Documents",
    empty: "No documents have been shared yet.",
  },
  { kind: "audio", label: "Audio", empty: "No audio has been shared yet." },
];
export default function SharedMediaBrowser({ roomId, userId }) {
  const [kind, setKind] = useState("media");
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [clearedAt, setClearedAt] = useState(() =>
    getConversationClearTime(userId, roomId),
  );
  const request = useRef(null);
  useEffect(() => {
    const cleared = (event) => {
      if (event.detail?.userId === userId && event.detail?.roomId === roomId)
        setClearedAt(event.detail.clearedAt);
    };
    window.addEventListener("conclave:conversation-cleared", cleared);
    return () =>
      window.removeEventListener("conclave:conversation-cleared", cleared);
  }, [userId, roomId]);
  async function load(nextCursor = null) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const page = await listRoomMedia(roomId, {
        kind,
        cursor: nextCursor || undefined,
        after: clearedAt ? new Date(clearedAt).toISOString() : undefined,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setItems((current) => {
        const known = new Set(
          (nextCursor ? current : []).map((item) => item.id),
        );
        return [
          ...(nextCursor ? current : []),
          ...page.media.filter((item) => !known.has(item.id)),
        ];
      });
      setCursor(page.nextCursor);
    } catch (err) {
      if (!controller.signal.aborted)
        setError(
          err.response?.data?.message ||
            "Could not load shared files. Check your connection and retry.",
        );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    setItems([]);
    setCursor(null);
    load();
    return () => request.current?.abort();
  }, [roomId, kind, clearedAt, revision]);
  const section = sections.find((item) => item.kind === kind);
  return (
    <section
      className="mt-6 min-w-0 rounded-2xl border border-line bg-surface p-5 md:p-6"
      aria-labelledby="shared-media-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="shared-media-heading" className="text-h2 text-ink">
            Shared files
          </h2>
          <p className="mt-1 text-metadata text-muted">
            Photos, videos, documents and audio from this conversation.
          </p>
        </div>
        <Button
          variant="ghost"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh shared files
        </Button>
      </div>
      <div
        role="group"
        aria-label="Shared file sections"
        className="mt-4 flex flex-wrap gap-2"
      >
        {sections.map((item) => (
          <Button
            key={item.kind}
            variant={kind === item.kind ? "primary" : "secondary"}
            aria-pressed={kind === item.kind}
            onClick={() => setKind(item.kind)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <div
        aria-label={`Shared ${section.label.toLowerCase()}`}
        aria-busy={loading}
        className="mt-4 min-w-0"
      >
        {items.length > 0 && (
          <>
            <p className="mb-3 text-metadata text-muted">
              {items.length} loaded{cursor ? " · more available" : ""}
            </p>
            <ul
              className={
                kind === "media"
                  ? "grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3"
                  : "space-y-3"
              }
            >
              {items.map((item) => (
                <li
                  key={item.id}
                  className="min-w-0 overflow-hidden rounded-xl border border-line bg-canvas p-2"
                  data-shared-file-id={item.id}
                >
                  <AttachmentCard attachment={item} />
                  <p
                    className="mt-2 truncate text-metadata text-ink"
                    title={item.filename}
                  >
                    {item.filename || "Shared file"}
                  </p>
                  <p
                    className="truncate text-metadata text-muted"
                    title={item.sender_name}
                  >
                    {item.sender_name || "Member"}
                  </p>
                  {item.created_at && (
                    <time
                      dateTime={item.created_at}
                      className="block text-metadata text-muted"
                    >
                      {new Date(item.created_at).toLocaleDateString()}
                    </time>
                  )}
                  <Link
                    to={`/chats/${roomId}?message=${encodeURIComponent(item.message_id)}`}
                    aria-label={`Show message for ${item.filename || "shared file"}`}
                    className="mt-2 inline-flex min-h-10 items-center text-label text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    Show message
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
        {loading && (
          <Spinner label={`Loading shared ${section.label.toLowerCase()}`} />
        )}
        {error && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-error/30 p-3"
          >
            <p className="text-metadata text-error [overflow-wrap:anywhere]">
              {error}
            </p>
            <Button
              variant="secondary"
              className="mt-2"
              onClick={() => load(items.length ? cursor : null)}
            >
              Retry shared files
            </Button>
          </div>
        )}
        {!loading && !error && !items.length && (
          <p className="py-6 text-metadata text-muted">
            {clearedAt
              ? "No shared files in this section since you cleared the conversation."
              : section.empty}
          </p>
        )}
        {!loading && !error && cursor && (
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() => load(cursor)}
          >
            Load more shared files
          </Button>
        )}
      </div>
    </section>
  );
}
