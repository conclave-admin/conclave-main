import { useState } from "react";
import { api } from "../../lib/api";
import { encryptOutgoing } from "../../lib/encryption";
import Modal from "../ui/Modal";
import Input from "../ui/Input";
import Button from "../ui/Button";
export function ScheduleMessage({ room, text, onScheduled }) {
  const [open, setOpen] = useState(false),
    [due, setDue] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <Button
        variant="ghost"
        disabled={!text.trim()}
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        Schedule text
      </Button>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        closeDisabled={busy}
        title="Schedule this text message"
      >
        <p className="mb-4 text-body text-muted">
          Time is shown in your device’s timezone. Your message can send while
          the app is closed. If conversation access or trusted devices change,
          it will wait for your review in Message activity.
        </p>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            setBusy(true);
            setError("");
            try {
              const payload = await encryptOutgoing({
                roomId: room.id,
                clientId: crypto.randomUUID(),
                content: text.trim(),
                attachments: [],
              });
              await api.post("/experience/schedules", {
                roomId: room.id,
                payload,
                dueAt: new Date(due).toISOString(),
              });
              setOpen(false);
              onScheduled?.();
            } catch (e) {
              setError(
                e.response?.data?.message ||
                  e.message ||
                  "Could not schedule this message",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input
            type="datetime-local"
            label="Send date and time"
            required
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
          <Button type="submit" disabled={busy}>
            {busy ? "Saving schedule…" : "Confirm schedule"}
          </Button>
          {error && (
            <p role="alert" className="text-error">
              {error}
            </p>
          )}
        </form>
      </Modal>
    </>
  );
}
export function ReminderAction({
  messageId,
  externalOpen,
  onClose,
  hideTrigger = false,
}) {
  const [open, setOpen] = useState(false),
    [due, setDue] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  return (
    <>
      {!hideTrigger && (
        <button
          type="button"
          className="min-h-9 text-metadata text-brand"
          onClick={() => setOpen(true)}
        >
          Remind me
        </button>
      )}
      {notice && (
        <span role="status" className="text-metadata text-muted">
          {notice}
        </span>
      )}
      <Modal
        open={externalOpen ?? open}
        onClose={() => {
          if (!busy) {
            setOpen(false);
            onClose?.();
          }
        }}
        title="Remind me about this message"
      >
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            setBusy(true);
            setError("");
            try {
              await api.post("/experience/reminders", {
                messageId,
                dueAt: new Date(due).toISOString(),
              });
              setOpen(false);
              onClose?.();
              setNotice("Reminder saved");
            } catch (e) {
              setError(e.response?.data?.message || "Could not save reminder");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input
            label="Reminder date and time"
            type="datetime-local"
            required
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
          <Button type="submit" disabled={busy}>
            Save reminder
          </Button>
          {error && (
            <p role="alert" className="text-error">
              {error}
            </p>
          )}
        </form>
      </Modal>
    </>
  );
}

export function ReviewSchedule({ id, onReviewed }) {
  const [open, setOpen] = useState(false),
    [job, setJob] = useState(null),
    [text, setText] = useState(""),
    [due, setDue] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function begin() {
    setOpen(true);
    setBusy(true);
    setError("");
    try {
      const item = (await api.get(`/experience/schedules/${id}`)).data.data;
      setJob(item);
      if (item.payload?.encryptedPayload) {
        const { decryptMessage } = await import("../../lib/encryption");
        const { getSessionUserId } = await import("../../lib/session");
        const decoded = await decryptMessage({
          room_id: item.room_id,
          client_id: item.client_id,
          sender_id: getSessionUserId(),
          thread_root_id: item.payload.threadRootId || null,
          encrypted_payload: item.payload.encryptedPayload,
          attachments: [],
        });
        setText(decoded._decrypted ? decoded.content : "");
        if (!decoded._decrypted)
          setError(
            "This device cannot open the original. Restore your keys or enter replacement text.",
          );
      } else setText(item.payload?.content || "");
    } catch (e) {
      setError(e.response?.data?.message || "Could not open this schedule");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="secondary" onClick={begin}>
        Review and reschedule
      </Button>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        closeDisabled={busy}
        title="Review scheduled message"
      >
        <p className="mb-4 text-body text-muted">
          Confirm the current recipients and choose a new time. This device will
          encrypt the replacement for the current trusted devices.
        </p>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            setBusy(true);
            setError("");
            try {
              const payload = await encryptOutgoing({
                roomId: job.room_id,
                clientId: job.client_id,
                content: text,
                ...(job.payload?.threadRootId
                  ? { threadRootId: job.payload.threadRootId }
                  : {}),
                attachments: [],
              });
              await api.post(`/experience/schedules/${id}/review`, {
                roomId: job.room_id,
                payload,
                dueAt: new Date(due).toISOString(),
              });
              setOpen(false);
              onReviewed?.();
            } catch (e) {
              setError(
                e.response?.data?.message ||
                  e.message ||
                  "Could not reschedule",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="block text-label">
            Message
            <textarea
              required
              maxLength={20000}
              className="mt-2 min-h-32 w-full rounded-xl border border-line bg-surface p-3 text-body"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <Input
            label="New send date and time"
            type="datetime-local"
            required
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
          <Button type="submit" disabled={busy || !job || !text.trim()}>
            Confirm new schedule
          </Button>
          {error && (
            <p role="alert" className="text-error">
              {error}
            </p>
          )}
        </form>
      </Modal>
    </>
  );
}
