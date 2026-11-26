import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useOutletContext } from "react-router-dom";
import IconArrowLeft from "@/assets/icons/arrow-left.svg?react";
import IconArrowRight from "@/assets/icons/arrow-right.svg?react";
import IconClose from "@/assets/icons/close.svg?react";
import IconPin from "@/assets/icons/pin.svg?react";
import IconStar from "@/assets/icons/star.svg?react";
import Spinner from "@/components/ui/Spinner";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Textarea from "@/components/ui/Textarea";
import Modal from "@/components/ui/Modal";
import { useToast } from "@/contexts/ToastContext";
import { useAuth } from "@/contexts/AuthContext";
import { useChats } from "@/contexts/ChatsContext";
import { useRealtime } from "@/contexts/RealtimeContext";
import {
  getDecision,
  getDecisionHistory,
  editDecision,
  retractDecision,
  pinDecision,
  unpinDecision,
} from "@/services/decisions.service";
import Page from "@/components/layout/Page";
import { createTask, listTasks } from "@/services/tasks.service";
import { getRoom } from "@/services/rooms.service";

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * One decision, in full.
 *
 * Reached from a pinned chip in a room header, from the board, or from search.
 * All three previously had nowhere to go: there was no GET for a single
 * decision and no route, so a pin could only ever point at the board and leave
 * the reader hunting for the row they clicked.
 *
 * Pin controls live here as well as in the strip, because a decision opened
 * from the board has no strip beside it — and "pin this for the room" is most
 * useful exactly when you have just re-read the thing you want to pin.
 */
export default function DecisionDetail() {
  const { decisionId } = useParams();
  const { setRoomHeader } = useOutletContext();
  const { toast } = useToast();
  const { user } = useAuth();
  const { rooms } = useChats();
  const { socket } = useRealtime();

  const [decision, setDecision] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState(false);
  const [retracting, setRetracting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [draft, setDraft] = useState({ title: "", body: "", tags: "" });
  const [reason, setReason] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyCursor, setHistoryCursor] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyRevision, setHistoryRevision] = useState(0);
  const [followUps, setFollowUps] = useState([]);
  const [followUpLoading, setFollowUpLoading] = useState(false);
  const [followUpLoadError, setFollowUpLoadError] = useState("");
  const [creatingFollowUp, setCreatingFollowUp] = useState(false);
  const [followUpTitle, setFollowUpTitle] = useState("");
  const [followUpDueDate, setFollowUpDueDate] = useState("");
  const [followUpAssignee, setFollowUpAssignee] = useState("");
  const [followUpMembers, setFollowUpMembers] = useState([]);
  const [followUpError, setFollowUpError] = useState("");
  const [followUpBusy, setFollowUpBusy] = useState(false);
  const [followUpClientId, setFollowUpClientId] = useState(() => crypto.randomUUID());
  const loadedId = useRef(null);

  useEffect(() => {
    let active = true;
    if (loadedId.current !== decisionId) {
      setIsLoading(true);
      setDecision(null);
    }
    setError("");

    getDecision(decisionId)
      .then((value) => {
        if (active) {
          loadedId.current = decisionId;
          setDecision(value);
        }
      })
      .catch((err) => {
        // 403 covers both "not in that room" and "does not exist" — the server
        // does not distinguish them, so the message has to be readable either way.
        if (active) {
          if (err.response?.status === 403) {
            setDecision(null);
            setHistory([]);
            loadedId.current = null;
          }
          setError(
            err.response?.data?.message || "Could not load this decision.",
          );
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [decisionId, refresh]);

  useEffect(() => {
    if (!decision) return undefined;
    let active = true;
    setFollowUpLoading(true);
    setFollowUpLoadError("");
    listTasks({ decisionId }).then((result) => { if (active) setFollowUps(result.tasks); })
      .catch(() => { if (active) setFollowUpLoadError("Could not load follow-up tasks."); })
      .finally(() => { if (active) setFollowUpLoading(false); });
    return () => { active = false; };
  }, [decisionId, decision?.follow_up?.total, decision?.follow_up?.done, refresh]);

  const addFollowUp = async (event) => {
    event.preventDefault();
    setFollowUpBusy(true); setFollowUpError("");
    try {
      const task = await createTask({ roomId: decision.room_id, decisionId,
        title: followUpTitle.trim(), dueDate: followUpDueDate || null,
        assigneeId: followUpAssignee || null, clientId: followUpClientId });
      setFollowUps((current) => [task, ...current]);
      setCreatingFollowUp(false); setFollowUpTitle(""); setFollowUpDueDate(""); setFollowUpAssignee("");
      setFollowUpClientId(crypto.randomUUID());
      setRefresh((value) => value + 1);
      toast({ title: "Follow-up task created", tone: "success" });
    } catch (err) { setFollowUpError(err.response?.data?.message || "Could not create follow-up task."); }
    finally { setFollowUpBusy(false); }
  };

  useEffect(() => {
    const update = (payload) => {
      if (payload?.decisionId === decisionId) setRefresh((value) => value + 1);
    };
    const focus = () => setRefresh((value) => value + 1);
    socket?.on("decision:changed", update);
    socket?.on("decision:pinned", update);
    socket?.on("decision:unpinned", update);
    socket?.on("task:updated", focus);
    window.addEventListener("focus", focus);
    return () => {
      socket?.off("decision:changed", update);
      socket?.off("decision:pinned", update);
      socket?.off("decision:unpinned", update);
      socket?.off("task:updated", focus);
      window.removeEventListener("focus", focus);
    };
  }, [socket, decisionId]);

  useEffect(() => {
    if (!historyOpen) return;
    let active = true;
    setHistoryLoading(true);
    setHistoryError("");
    getDecisionHistory(decisionId)
      .then((result) => {
        if (!active) return;
        setHistory(result.revisions);
        setHistoryCursor(result.nextCursor);
      })
      .catch((err) => {
        if (active) {
          if (err.response?.status === 403) {
            setDecision(null);
            setHistory([]);
          }
          setHistoryError(err.response?.data?.message || "Could not load history.");
        }
      })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [decisionId, historyOpen, refresh, historyRevision]);

  const loadHistoryMore = async () => {
    if (!historyCursor || historyLoading) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const result = await getDecisionHistory(decisionId, historyCursor);
      setHistory((current) => [...current, ...result.revisions]);
      setHistoryCursor(result.nextCursor);
    } catch (err) {
      setHistoryError(err.response?.data?.message || "Could not load more history.");
    } finally { setHistoryLoading(false); }
  };

  useEffect(() => {
    setRoomHeader(decision ? decision.title : "Decision");
    return () => setRoomHeader(null);
  }, [setRoomHeader, decision]);

  const isRoomPinned = Boolean(decision?.pins?.room);
  const mineScopes = decision?.pins?.mine || [];
  const isBookmarked = mineScopes.includes("user");
  const canUnpinRoom = decision?.capabilities?.canUnpinRoom ?? mineScopes.includes("room");
  const canManage = decision?.capabilities?.canManage ?? (decision?.created_by === user?.id ||
    rooms.find((room) => room.id === decision?.room_id)?.my_role === "admin");

  const saveEdit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      const updated = await editDecision(decisionId, {
        version: decision.version,
        title: draft.title.trim(),
        body: draft.body.trim(),
        tags: draft.tags.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean),
      });
      setDecision(updated);
      setHistoryRevision((value) => value + 1);
      setEditing(false);
      toast({ title: "Decision updated", tone: "success" });
    } catch (err) {
      setFormError(err.response?.data?.message || "Could not save this decision.");
    } finally {
      setBusy(false);
    }
  };

  const confirmRetract = async (event) => {
    event.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      const updated = await retractDecision(decisionId, decision.version, reason.trim());
      setDecision(updated);
      setHistoryRevision((value) => value + 1);
      setRetracting(false);
      toast({ title: "Decision retracted", tone: "success" });
    } catch (err) {
      setFormError(err.response?.data?.message || "Could not retract this decision.");
    } finally {
      setBusy(false);
    }
  };

  const runPin = useCallback(
    async (scope) => {
      try {
        setDecision(await pinDecision(decisionId, scope));
      } catch (err) {
        // A 409 means somebody else took the room pin; the server names them,
        // and the fresher payload below puts the strip and this page back in step.
        const message =
          err.response?.data?.message || "Could not pin this decision.";
        toast({ title: "Pin failed", description: message, tone: "error" });
        if (err.response?.status === 409) {
          getDecision(decisionId)
            .then(setDecision)
            .catch(() => {});
        }
      }
    },
    [decisionId, toast],
  );

  const runUnpin = useCallback(
    async (scope) => {
      try {
        const updated = await unpinDecision(decisionId, scope);
        // The server answers a removed-but-absent pin with a sentinel
        // `{ decisionId, scope, unpinned: false }` rather than a 404, so a
        // retried unpin does not look like a failure. That sentinel is not a
        // decision, so the previous payload is kept rather than replacing this
        // page with an empty article.
        if (updated?.pins) setDecision(updated);
      } catch (err) {
        toast({
          title: "Unpin failed",
          description:
            err.response?.data?.message || "Could not remove this pin.",
          tone: "error",
        });
      }
    },
    [decisionId, toast],
  );

  if (isLoading) return <Spinner label="Loading decision" />;

  if (!decision) {
    return (
      <Page width="content">
        <p
          role="alert"
          className="rounded-lg bg-error/10 p-4 text-body text-error"
        >
          {error || "Decision not found."}
        </p>
        <Link
          to="/decisions"
          className="mt-4 inline-flex items-center gap-2 text-label text-brand hover:underline"
        >
          <IconArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to decisions
        </Link>
      </Page>
    );
  }

  return (
    <Page width="content">
      <Link
        to="/decisions"
        className="inline-flex items-center gap-2 text-label text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        <IconArrowLeft className="h-4 w-4" aria-hidden="true" />
        All decisions
      </Link>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-error/10 p-3 text-body text-error">
          {error} Showing the last loaded version.
        </p>
      )}

      <article className="mt-5 rounded-xl border border-line bg-surface px-5 py-6 md:px-8 md:py-8">
        <p className={`text-label ${decision.status === "retracted" ? "text-error" : "text-success"}`}>
          {decision.status === "retracted" ? "RETRACTED DECISION" : "DECISION"}
        </p>
        <h1 className="mt-3 text-h1 text-ink">{decision.title}</h1>

        {decision.body && (
          <p className="mt-5 whitespace-pre-wrap text-body text-ink [overflow-wrap:anywhere]">
            {decision.body}
          </p>
        )}

        {decision.tags?.length > 0 && (
          <ul className="mt-5 flex flex-wrap gap-2">
            {decision.tags.map((tag) => (
              <li
                key={tag}
                className="rounded-full bg-canvas px-2.5 py-1 text-metadata text-muted"
              >
                #{tag}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-6 text-metadata text-muted">
          {decision.author_name} · {formatDate(decision.created_at)} · #
          {decision.room_slug ?? decision.room_name}
          {decision.version > 1 && ` · Updated ${formatDate(decision.updated_at)}`}
        </p>

        {decision.room_id && (
          <Link
            to={`/chats/${decision.room_id}`}
            className="mt-4 inline-flex items-center gap-2 text-label text-brand hover:underline"
          >
            Open #{decision.room_slug ?? decision.room_name}
            <IconArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        )}

        {decision.source_message_id && (
          <Link
            to={`/chats/${decision.room_id}?message=${decision.source_message_id}`}
            className="mt-3 inline-flex items-center gap-2 text-label text-brand hover:underline"
          >
            View source message
            <IconArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setHistoryOpen((value) => !value)}>
            {historyOpen ? "Hide history" : "View history"}
          </Button>
          {canManage && decision.status !== "retracted" && (
            <>
              <Button variant="secondary" onClick={() => {
                setDraft({ title: decision.title, body: decision.body,
                  tags: (decision.tags || []).join(", ") });
                setFormError("");
                setEditing(true);
              }}>Edit decision</Button>
              <Button variant="ghost" className="text-error" onClick={() => {
                setReason("");
                setFormError("");
                setRetracting(true);
              }}>Retract decision</Button>
            </>
          )}
        </div>

        {historyOpen && (
          <div className="mt-4">
          {historyError && <p role="alert" className="text-body text-error">{historyError}</p>}
          {historyLoading && history.length === 0 && <Spinner label="Loading history" />}
          <ol className="divide-y divide-line border-t border-line">
            {history.map((entry) => (
              <li key={entry.version} className="py-3 text-body text-muted">
                <strong className="text-ink">Version {entry.version}</strong>
                {entry.status === "retracted" ? " · Retracted" : ""}
                {` · ${entry.changed_by_name} · ${formatDate(entry.changed_at)}`}
                {entry.note && <p className="mt-1 text-ink">{entry.note}</p>}
                {entry.version !== decision.version && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-brand">View previous text</summary>
                    <p className="mt-1 font-semibold text-ink">{entry.title}</p>
                    <p className="mt-1 whitespace-pre-wrap text-ink">{entry.body}</p>
                  </details>
                )}
              </li>
            ))}
          </ol>
          {historyCursor && <Button variant="secondary" disabled={historyLoading}
            onClick={loadHistoryMore} className="mt-3">
            {historyLoading ? "Loading…" : "Load older revisions"}
          </Button>}
          </div>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-line pt-5">
          {!isRoomPinned && decision.status !== "retracted" && (
            <button
              type="button"
              onClick={() => runPin("room")}
              className="inline-flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-label text-ink transition-colors hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <IconPin className="h-4 w-4" aria-hidden="true" />
              Pin for everyone
            </button>
          )}

          {canUnpinRoom && (
            <button
              type="button"
              onClick={() => runUnpin("room")}
              className="inline-flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-label text-ink transition-colors hover:border-error hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <IconClose className="h-4 w-4" aria-hidden="true" />
              Unpin for everyone
            </button>
          )}

          {isBookmarked ? (
            <button
              type="button"
              onClick={() => runUnpin("user")}
              className="inline-flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-label text-ink transition-colors hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <IconStar className="h-4 w-4" aria-hidden="true" />
              Remove my bookmark
            </button>
          ) : (
            <button
              type="button"
              onClick={() => runPin("user")}
              className="inline-flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-label text-ink transition-colors hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <IconStar className="h-4 w-4" aria-hidden="true" />
              Bookmark for me
            </button>
          )}
        </div>

        {decision.status !== "retracted" && <p className="mt-3 text-metadata text-muted">
          {isRoomPinned && !canUnpinRoom
            ? `Pinned for the room by ${decision.pins.room.display_name}. Only they or a room admin can unpin it.`
            : "Any member can pin a decision for the room."}
        </p>}
      </article>
      <section className="mt-5 rounded-2xl border border-line bg-surface p-5 md:p-8" aria-labelledby="follow-up-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-label uppercase tracking-wider text-brand">From choice to action</p>
            <h2 id="follow-up-heading" className="mt-2 text-h2 text-ink">Follow-up tasks</h2>
            <p className="mt-1 text-body text-muted">Track the work this decision created in the same conversation.</p></div>
          {decision.status === "active" && <Button onClick={() => {
            setCreatingFollowUp(true);
            getRoom(decision.room_id).then((room) => setFollowUpMembers(room?.members || []))
              .catch(() => setFollowUpMembers([]));
          }}>Add follow-up</Button>}
        </div>
        {followUpLoadError && <div className="mt-4 flex items-center gap-3"><p role="alert" className="text-body text-error">{followUpLoadError}</p><Button variant="secondary" onClick={() => setRefresh((value) => value + 1)}>Retry</Button></div>}
        {followUpLoadError ? null : followUpLoading && followUps.length === 0 ? <div className="mt-5"><Spinner label="Loading follow-up tasks" /></div> :
          followUps.length === 0 ? <p className="mt-5 rounded-xl bg-canvas p-4 text-body text-muted">No follow-up tasks yet.</p> :
          <ul className="mt-5 space-y-2">{followUps.map((task) => <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3">
            <div><p className="text-body font-semibold text-ink">{task.title}</p><p className="text-metadata text-muted">{task.assignee_name || "Unassigned"} · {task.status.replaceAll("_", " ")}</p></div>
            <Link to={`/tasks?task=${task.id}`} className="text-label text-brand hover:underline">Open task</Link>
          </li>)}</ul>}
        {decision.follow_up?.total > followUps.length && <Link to={`/tasks?decision=${decisionId}`} className="mt-4 inline-block text-label text-brand hover:underline">View all {decision.follow_up.total} tasks</Link>}
      </section>
      <Modal open={creatingFollowUp} onClose={() => !followUpBusy && setCreatingFollowUp(false)} title="New follow-up task" closeDisabled={followUpBusy}>
        <form className="space-y-4" onSubmit={addFollowUp}>
          <p className="text-body text-muted">Linked to {decision.title}</p>
          <Input label="Task" required maxLength={160} value={followUpTitle} onChange={(event) => setFollowUpTitle(event.target.value)} />
          <Input label="Due date (optional)" type="date" value={followUpDueDate} onChange={(event) => setFollowUpDueDate(event.target.value)} />
          <label className="block text-label text-ink">Assign to (optional)
            <select className="mt-2 min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-body text-ink" value={followUpAssignee} onChange={(event) => setFollowUpAssignee(event.target.value)}>
              <option value="">Unassigned</option>
              {followUpMembers.map((member) => <option key={member.id} value={member.id}>{member.display_name}</option>)}
            </select>
          </label>
          {followUpError && <p role="alert" className="text-body text-error">{followUpError}</p>}
          <Button type="submit" disabled={followUpBusy || !followUpTitle.trim()}>{followUpBusy ? "Creating…" : "Create task"}</Button>
        </form>
      </Modal>
      <Modal
        open={editing}
        onClose={() => !busy && setEditing(false)}
        title="Edit decision"
        closeDisabled={busy}
      >
        <form onSubmit={saveEdit} className="space-y-4">
          <Input label="Title" value={draft.title} maxLength={140} required
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
          <Textarea label="Body" value={draft.body} maxLength={10000} required rows={6}
            onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))} />
          <Input label="Tags (comma separated)" value={draft.tags}
            onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))} />
          {formError && <p role="alert" className="text-error">{formError}</p>}
          <Button type="submit" disabled={busy || !draft.title.trim() || !draft.body.trim()}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </form>
      </Modal>
      <Modal
        open={retracting}
        onClose={() => !busy && setRetracting(false)}
        title="Retract decision?"
        closeDisabled={busy}
      >
        <form onSubmit={confirmRetract} className="space-y-4">
          <p className="text-body text-muted">
            The decision remains visible with its history so other members know it no longer applies.
          </p>
          <Textarea label="Reason" value={reason} maxLength={500} minLength={5} required
            onChange={(event) => setReason(event.target.value)}
            placeholder="What changed?" />
          {formError && <p role="alert" className="text-error">{formError}</p>}
          <Button type="submit" disabled={busy || reason.trim().length < 5} className="bg-error hover:bg-error/90">
            {busy ? "Retracting…" : "Retract decision"}
          </Button>
        </form>
      </Modal>
    </Page>
  );
}
