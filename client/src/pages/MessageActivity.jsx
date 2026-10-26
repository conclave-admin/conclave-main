import useExpiryClock from "../hooks/useExpiryClock";
import { ReviewSchedule } from "../components/chat/MessageLater";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { decryptMessages } from "../lib/encryption";
import { useSyncReconciler } from "../contexts/SyncContext";
import Page from "../components/layout/Page";
import Button from "../components/ui/Button";
import MessageBody from "../components/chat/MessageBody";
export default function MessageActivity() {
  const [params, setParams] = useSearchParams(),
    navigate = useNavigate();
  const tab = params.get("tab") || "threads";
  const [rows, setRows] = useState([]),
    [cursor, setCursor] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const revision = useRef(0);
  const now = useExpiryClock(tab === "saved" ? rows : []);
  const displayedRows =
    tab === "saved"
      ? rows.filter(
          (row) => !row.expires_at || new Date(row.expires_at).getTime() > now,
        )
      : rows;
  async function load(before) {
    const v = ++revision.current;
    setBusy(true);
    setError("");
    try {
      const data = (await api.get(`/experience/${tab}`, { params: { before } }))
        .data.data;
      let result =
        tab === "saved"
          ? await decryptMessages(data.messages)
          : tab === "threads"
            ? data.threads
            : data;
      if (v !== revision.current) return;
      setRows((old) =>
        before
          ? [...old, ...result.filter((r) => !old.some((x) => x.id === r.id))]
          : result,
      );
      setCursor(data.nextCursor || null);
    } catch (e) {
      if (v === revision.current) {
        setRows([]);
        setError(
          e.response?.data?.message || "Could not load your message activity.",
        );
      }
    } finally {
      if (v === revision.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (!["threads", "saved", "schedules", "reminders"].includes(tab)) {
      setParams({ tab: "threads" });
      return;
    }
    load();
    return () => revision.current++;
  }, [tab]);
  useSyncReconciler(async () => {
    await load();
  }, [tab]);
  async function cancel(id) {
    try {
      await api.delete(`/experience/${tab}/${id}`);
      await load();
    } catch (e) {
      setError(e.response?.data?.message || "Could not cancel this item");
    }
  }
  return (
    <Page>
      <h1 className="text-h1">Message activity</h1>
      <p className="mt-2 text-body text-muted">
        Focused conversations, saved messages, and things to return to.
      </p>
      <nav aria-label="Message activity" className="my-6 flex flex-wrap gap-2">
        {["threads", "saved", "schedules", "reminders"].map((name) => (
          <button
            key={name}
            type="button"
            aria-current={tab === name ? "page" : undefined}
            onClick={() => setParams({ tab: name })}
            className={`min-h-11 rounded-xl px-4 text-label capitalize ${tab === name ? "bg-brand text-white" : "bg-surface text-muted"}`}
          >
            {name}
          </button>
        ))}
      </nav>
      {tab === "saved" && (
        <Button
          onClick={async () => {
            try {
              const room = (await api.post("/experience/saved-room")).data.data;
              navigate(`/chats/${room.id}`);
            } catch (e) {
              setError(
                e.response?.data?.message ||
                  "Could not open your personal conversation",
              );
            }
          }}
        >
          Open private notes
        </Button>
      )}
      {error && (
        <p role="alert" className="my-4 text-error">
          {error}
        </p>
      )}
      <div className="mt-5 space-y-3">
        {displayedRows.map((row) => (
          <article
            key={row.id}
            className="rounded-2xl border border-line bg-surface p-5"
          >
            {tab === "threads" ? (
              <>
                <p className="text-label">{row.room_name}</p>
                <p className="mt-2 text-body text-muted">
                  {row.reply_count} replies · {row.unread_count} unread
                </p>
                <Link
                  className="mt-3 inline-flex min-h-11 items-center text-brand"
                  to={`/chats/${row.room_id}?message=${row.id}&thread=${row.id}`}
                >
                  Open thread
                </Link>
              </>
            ) : tab === "saved" ? (
              <>
                <p className="mb-2 text-label text-muted">{row.sender_name}</p>
                {row._cryptoError ? (
                  <Link
                    to="/settings#security-recovery"
                    className="text-brand underline"
                  >
                    Restore message access on this device
                  </Link>
                ) : (
                  <MessageBody text={row.content || "Attachment"} />
                )}
                <Link
                  to={`/chats/${row.room_id}?message=${row.id}`}
                  className="mt-2 inline-flex min-h-11 items-center text-brand"
                >
                  View source message
                </Link>
              </>
            ) : (
              <>
                <p className="text-label">
                  {tab === "schedules" ? "Scheduled message" : "Reminder"} ·{" "}
                  {new Date(row.due_at).toLocaleString()}
                </p>
                <p className="mt-2 text-body text-muted">
                  {{
                    pending: "Waiting to send",
                    sending: "Sending",
                    sent: "Sent",
                    needs_review: "Needs your review",
                    cancelled: "Cancelled",
                  }[row.status] ||
                    (row.cancelled_at
                      ? "Cancelled"
                      : row.completed_at
                        ? "Reminder sent"
                        : "Pending")}
                </p>
                {row.reason && (
                  <p role="status" className="mt-2 text-body text-warning">
                    {row.reason}
                  </p>
                )}
                {row.status === "needs_review" && (
                  <ReviewSchedule id={row.id} onReviewed={() => load()} />
                )}
                {tab === "schedules" && (
                  <Link
                    className="mr-4 inline-flex min-h-11 items-center text-brand"
                    to={`/chats/${row.room_id}`}
                  >
                    Open conversation
                  </Link>
                )}
                {tab === "reminders" && (
                  <Link
                    className="mr-4 inline-flex min-h-11 items-center text-brand"
                    to={
                      row.room_id
                        ? `/chats/${row.room_id}?message=${row.message_id}`
                        : "/activity?tab=reminders"
                    }
                  >
                    View source message
                  </Link>
                )}
                {(tab === "schedules"
                  ? ["pending", "sending", "needs_review"].includes(row.status)
                  : !row.cancelled_at && !row.completed_at) && (
                  <Button variant="ghost" onClick={() => cancel(row.id)}>
                    Cancel
                  </Button>
                )}
              </>
            )}
          </article>
        ))}
      </div>
      {!busy && !displayedRows.length && !error && (
        <p role="status" className="mt-8 text-body text-muted">
          Nothing here yet. Use a message’s actions to save it or set a
          reminder.
        </p>
      )}
      <div className="mt-5 flex gap-3">
        <Button variant="secondary" disabled={busy} onClick={() => load()}>
          {busy ? "Loading…" : "Refresh"}
        </Button>
        {cursor && (
          <Button disabled={busy} onClick={() => load(cursor)}>
            Load more
          </Button>
        )}
      </div>
    </Page>
  );
}
