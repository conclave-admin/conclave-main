import { useAuth } from "../../contexts/AuthContext";
import { MediaViewerProvider } from "./MediaViewer";
import { AttachmentGroup } from "./AttachmentCard";
import { viewerItems } from "../../lib/mediaAlbums";
import { readStatus } from "../../lib/messageMeta";
import MessageSendState from "./MessageSendState";
import useExpiryClock from "../../hooks/useExpiryClock";
import { useEffect, useRef, useState } from "react";
import { localConversationMessages } from "../../services/messages.service";
import { api } from "../../lib/api";
import { decryptMessages } from "../../lib/encryption";
import { useSyncReconciler } from "../../contexts/SyncContext";
import MessageBody from "./MessageBody";
import MessageComposer from "./MessageComposer";
import Button from "../ui/Button";
export default function ThreadPanel({
  root,
  room,
  onClose,
  onSend,
  onSendMedia,
  deliveryIds,
  pending = [],
}) {
  const { user } = useAuth();
  const rootId = root.thread_root_id || root.id;
  const [rows, setRows] = useState([]),
    [cursor, setCursor] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [offline, setOffline] = useState(false);
  const version = useRef(0);
  async function load(before) {
    const current = ++version.current;
    setBusy(true);
    try {
      const cached = navigator.onLine === false;
      const page = cached
        ? {
            messages: (await localConversationMessages(room.id)).filter(
              (m) => m.id === rootId || m.thread_root_id === rootId,
            ),
            nextCursor: null,
          }
        : (
            await api.get(`/experience/threads/${rootId}`, {
              params: { before },
            })
          ).data.data;
      const decoded = await decryptMessages(page.messages);
      if (current !== version.current) return;
      setRows((old) =>
        before
          ? [...old, ...decoded.filter((m) => !old.some((r) => r.id === m.id))]
          : decoded,
      );
      setOffline(cached);
      setCursor(page.nextCursor);
      setError("");
    } catch (e) {
      if (current === version.current) {
        if ([403, 404].includes(e.response?.status)) setRows([]);
        setError(
          e.response?.data?.message ||
            "Could not load this thread. Reconnect and try again.",
        );
      }
    } finally {
      if (current === version.current) setBusy(false);
    }
  }
  useEffect(() => {
    load();
    return () => version.current++;
  }, [rootId]);
  useSyncReconciler(
    async (batch) => {
      if (batch.reset || batch.changes.some((c) => c.room_id === room.id))
        await load();
    },
    [room.id, rootId],
  );
  useExpiryClock(rows);
  useEffect(() => {
    const escape = (e) => {
      if (e.key === "Escape" && !document.querySelector('[role="dialog"]'))
        onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  const original = rows.find((m) => m.id === rootId) || root;
  const expired =
    original.expires_at && new Date(original.expires_at) <= new Date();
  const replies = [
    ...rows.filter(
      (m) =>
        m.id !== rootId &&
        (!m.expires_at || new Date(m.expires_at) > new Date()),
    ),
    ...pending.filter(
      (m) =>
        !rows.some(
          (r) => r.id === m.id || (m.client_id && r.client_id === m.client_id),
        ),
    ),
  ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return (
    <MediaViewerProvider items={viewerItems([original, ...replies])}>
      <aside
        role="complementary"
        aria-label="Message thread"
        className="fixed inset-0 z-40 flex min-w-0 flex-col border-l border-line bg-surface md:left-auto md:w-[min(440px,45vw)]"
      >
        <header className="flex min-h-16 items-center justify-between border-b border-line px-4">
          <div>
            <h2 className="text-h2">Thread</h2>
            <p className="text-metadata text-muted">
              {room.display_name || room.name}
            </p>
          </div>
          <Button variant="ghost" onClick={onClose}>
            Close thread
          </Button>
        </header>
        {offline && (
          <p role="status" className="px-4 py-2 text-metadata text-muted">
            Offline · showing thread history saved on this device. Replies will
            wait to send.
          </p>
        )}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {expired ? (
            <p role="status">This thread’s original message has expired.</p>
          ) : error ? (
            <p role="alert" className="text-error">
              {error}
            </p>
          ) : (
            <article className="rounded-xl bg-canvas p-3">
              <p className="mb-2 text-label text-muted">
                {original.sender_name}
              </p>
              <MessageBody
                text={
                  original._cryptoError
                    ? "Restore message access in Settings to view this message."
                    : original.content || ""
                }
              />
              <AttachmentGroup attachments={original.attachments || []} />
            </article>
          )}
          <div className="border-t border-line" />
          {cursor && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => load(cursor)}
            >
              Earlier replies
            </Button>
          )}
          {!expired &&
            !error &&
            replies.map((m) => (
              <article
                key={m.client_id || m.id}
                className="rounded-xl border border-line p-3"
              >
                <p className="mb-2 text-label text-muted">
                  {m.sender_name || "You"} ·{" "}
                  {new Date(m.created_at).toLocaleString()}
                </p>
                <MessageBody
                  text={
                    m._cryptoError
                      ? "Restore message access in Settings to view this message."
                      : m.content || ""
                  }
                />
                <AttachmentGroup attachments={m.attachments || []} />
                {m._outbox ? (
                  <MessageSendState
                    message={m}
                    onRetry={deliveryIds?.onRetry}
                    onCancel={deliveryIds?.onCancel}
                  />
                ) : (
                  <p className="mt-2 text-metadata text-muted">
                    {readStatus(m, room.members, user?.id)}
                  </p>
                )}
              </article>
            ))}
          {!replies.length && !busy && !error && (
            <p className="text-body text-muted">
              Start a focused conversation here.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => load()}>
              Refresh thread
            </Button>
            <Button
              variant="ghost"
              disabled={!rows.length || Boolean(error)}
              onClick={async () => {
                try {
                  const sequences = rows
                    .filter((m) => m.id !== rootId)
                    .map((m) => BigInt(m.room_sequence || 0));
                  const max = sequences.reduce((a, b) => (a > b ? a : b), 0n);
                  await api.post(`/experience/threads/${rootId}/read`, {
                    sequence: String(max),
                  });
                  setError("");
                } catch (e) {
                  setError(
                    e.response?.data?.message ||
                      "Could not update the read position",
                  );
                }
              }}
            >
              Mark displayed replies read
            </Button>
          </div>
        </div>
        {!error && !expired && !(room.type === "dm" &&
          !room.members?.some((member) => member.id !== user?.id)) && (
          <div className="chat-composer">
            <MessageComposer
              activityScope={`thread:${room.id}:${rootId}`}
              members={room.members}
              onSendMedia={(items) =>
                onSendMedia(
                  items.map((item) => ({
                    ...item,
                    threadRootId: rootId,
                    replyToId: rootId,
                  })),
                )
              }
              disabled={
                room.member_can_send === false && room.my_role !== "admin"
              }
              onSend={(payload) =>
                onSend({ ...payload, threadRootId: rootId, replyToId: rootId })
              }
            />
          </div>
        )}
      </aside>
    </MediaViewerProvider>
  );
}
