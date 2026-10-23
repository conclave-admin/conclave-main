import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useSyncReconciler } from "../../contexts/SyncContext";
import { sharedLinks, sharedUrls } from "../../services/roomLifecycle.service";
import Button from "../ui/Button";
export default function SharedLinksBrowser({ room, user }) {
  const [rows, setRows] = useState([]),
    [cursor, setCursor] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const generation = useRef(0);
  async function load(before) {
    const version = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const page = await sharedLinks(room, before);
      if (version !== generation.current) return;
      setRows((old) =>
        before
          ? [
              ...old,
              ...page.messages.filter((m) => !old.some((x) => x.id === m.id)),
            ]
          : page.messages,
      );
      setCursor(page.nextCursor);
    } catch (e) {
      if (version === generation.current)
        setError(e.response?.data?.message || e.message);
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    load();
    return () => {
      generation.current++;
    };
  }, [room.id, user.id, room.cleared_sequence, revision]);
  useEffect(() => {
    const cleared = (e) => {
      if (e.detail?.userId === user.id && e.detail?.roomId === room.id)
        setRevision((v) => v + 1);
    };
    window.addEventListener("conclave:conversation-cleared", cleared);
    return () =>
      window.removeEventListener("conclave:conversation-cleared", cleared);
  }, [user.id, room.id]);
  useSyncReconciler(
    async (batch) => {
      if (
        batch.reset ||
        batch.changes.some(
          (c) =>
            c.room_id === room.id &&
            ["message", "preferences"].includes(c.kind),
        )
      )
        await load();
    },
    [user.id, room.id],
  );
  return (
    <section
      className="mt-6 space-y-3 rounded-2xl border border-line bg-surface p-5"
      aria-labelledby="shared-links"
    >
      <h2 id="shared-links" className="text-h2 text-ink">
        Shared links
      </h2>
      <p className="text-metadata text-muted">
        {room.encryption_mode === "e2ee-v1"
          ? "Only links in decrypted messages cached on this device are included."
          : "Links from messages visible to your account."}{" "}
        Opening a link visits an external website.
      </p>
      {rows.map((message) => (
        <article
          key={message.id}
          className="min-w-0 space-y-2 rounded-lg border border-line p-3"
        >
          {sharedUrls(message.content).map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="block break-all text-body text-brand"
            >
              {url}
            </a>
          ))}
          <Link
            className="inline-flex min-h-11 items-center text-label text-ink"
            to={`/chats/${room.id}?message=${message.id}`}
          >
            View source message
          </Link>
        </article>
      ))}
      {!busy && !rows.length && !error && (
        <p className="text-body text-muted">No shared links available.</p>
      )}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => load()}>
          Refresh links
        </Button>
        {cursor && (
          <Button disabled={busy} onClick={() => load(cursor)}>
            Load more links
          </Button>
        )}
      </div>
    </section>
  );
}
