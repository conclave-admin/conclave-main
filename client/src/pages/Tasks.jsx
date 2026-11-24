import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import Page from "@/components/layout/Page";
import Spinner from "@/components/ui/Spinner";
import EmptyState from "@/components/ui/EmptyState";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Textarea from "@/components/ui/Textarea";
import Modal from "@/components/ui/Modal";
import { useAuth } from "@/contexts/AuthContext";
import { useChats } from "@/contexts/ChatsContext";
import { useRealtime } from "@/contexts/RealtimeContext";
import { useToast } from "@/contexts/ToastContext";
import { getRoom } from "@/services/rooms.service";
import { listTasks, getTask, createTask, editTask, addTaskUpdate, updateTaskStatus } from "@/services/tasks.service";

const COLUMNS = [
  { status: "open", label: "To do", tone: "text-warning", bar: "bg-warning" },
  { status: "in_progress", label: "In progress", tone: "text-brand", bar: "bg-brand" },
  { status: "done", label: "Done", tone: "text-success", bar: "bg-success" },
];
function displayDate(value) {
  if (!value) return "No due date";
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function isOverdue(task) {
  return task.due_date && task.status !== "done" && task.due_date < new Date().toISOString().slice(0, 10);
}

function TaskDetail({ taskId, onClose, onChanged }) {
  const { user } = useAuth();
  const { socket } = useRealtime();
  const { toast } = useToast();
  const [detail, setDetail] = useState(null);
  const [members, setMembers] = useState([]);
  const [note, setNote] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: "", body: "", dueDate: "", assigneeId: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setDetail(await getTask(taskId)); setError(""); }
    catch (err) { setDetail(null); setError(err.response?.data?.message || "Task unavailable"); }
  }, [taskId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const changed = ({ taskId: changedId }) => { if (changedId === taskId) void refresh(); };
    socket?.on("task:updated", changed);
    window.addEventListener("focus", refresh);
    return () => { socket?.off("task:updated", changed); window.removeEventListener("focus", refresh); };
  }, [socket, taskId, refresh]);
  const task = detail?.task;
  const canProgress = task?.can_progress ?? task?.assignee_id === user?.id;
  const canManage = task?.can_manage ?? task?.created_by === user?.id;
  const run = async (fn, message) => {
    setBusy(true); setError("");
    try { await fn(); await refresh(); onChanged(); toast({ title: message, tone: "success" }); }
    catch (err) { setError(err.response?.data?.message || "Could not save task"); }
    finally { setBusy(false); }
  };
  const openEdit = async () => {
    setForm({ title: task.title, body: task.body || "", dueDate: task.due_date || "", assigneeId: task.assignee_id || "" });
    try { const room = await getRoom(task.room_id); setMembers(room?.members || []); setEditing(true); }
    catch { setError("Could not load room members. Reassignment is unavailable."); }
  };
  return (
    <Modal open onClose={onClose} title="Task details" fullscreen>
      <div className="mx-auto h-full w-full max-w-3xl overflow-y-auto">
        {!detail && !error && <Spinner label="Loading task" />}
        {error && <p role="alert" className="mx-5 mt-4 rounded-lg bg-error/10 p-3 text-body text-error">{error}</p>}
        {task && <div className="space-y-6 p-5">
          <div className="rounded-xl border border-line bg-canvas p-5">
            <p className="text-label text-brand">{COLUMNS.find((column) => column.status === task.status)?.label}</p>
            <h2 className="mt-2 text-h1 text-ink [overflow-wrap:anywhere]">{task.title}</h2>
            {task.body && <p className="mt-3 whitespace-pre-wrap text-body text-muted [overflow-wrap:anywhere]">{task.body}</p>}
            <div className="mt-5 grid grid-cols-2 gap-3 text-metadata text-muted">
              <p><span className="block text-ink">Assigned to</span>{task.assignee_name || "Unassigned"}</p>
              <p><span className="block text-ink">Due</span>{displayDate(task.due_date)}</p>
              <p><span className="block text-ink">Created by</span>{task.creator_name || "Member"}</p>
              <p><span className="block text-ink">Conversation</span>#{task.room_slug || task.room_name}</p>
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link to={`/chats/${task.room_id}`} className="text-label text-brand hover:underline">Open conversation</Link>
              {task.source_message_id && <Link to={`/chats/${task.room_id}?message=${task.source_message_id}`} className="text-label text-brand hover:underline">View source message</Link>}
              {task.decision_id && <Link to={`/decisions/${task.decision_id}`} className="text-label text-brand hover:underline">View decision: {task.decision_title}</Link>}
            </div>
          </div>
          {canProgress && <section><h3 className="text-h2 text-ink">Move progress</h3>
            <div className="mt-3 flex flex-wrap gap-2">{COLUMNS.map((column) => <Button key={column.status} variant={task.status === column.status ? "primary" : "secondary"} disabled={busy || task.status === column.status}
              onClick={() => run(() => updateTaskStatus(task.id, column.status), "Progress updated")}>{column.label}</Button>)}</div>
            <form className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void run(async () => { await addTaskUpdate(task.id, note); setNote(""); }, "Progress note added"); }}>
              <Textarea label="Add a progress note" value={note} maxLength={2000} rows={3} onChange={(event) => setNote(event.target.value)} placeholder="Share an update, blocker or result" />
              <Button type="submit" disabled={busy || !note.trim()}>Post update</Button>
            </form>
          </section>}
          {canManage && <section><Button variant="secondary" onClick={() => editing ? setEditing(false) : void openEdit()}>{editing ? "Cancel editing" : "Edit assignment and details"}</Button>
            {editing && <form className="mt-4 space-y-4 rounded-xl border border-line p-4" onSubmit={(event) => { event.preventDefault(); void run(async () => { await editTask(task.id, { ...form, assigneeId: form.assigneeId || null, dueDate: form.dueDate || null }); setEditing(false); }, "Task details updated"); }}>
              <Input label="Title" value={form.title} required maxLength={160} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} />
              <Textarea label="Instructions" value={form.body} maxLength={2000} rows={4} onChange={(event) => setForm((current) => ({ ...current, body: event.target.value }))} />
              <Input label="Due date" type="date" value={form.dueDate} onChange={(event) => setForm((current) => ({ ...current, dueDate: event.target.value }))} />
              <label className="block text-label text-ink">Assignee<select className="mt-2 min-h-11 w-full rounded-lg border border-line bg-surface px-3" value={form.assigneeId} onChange={(event) => setForm((current) => ({ ...current, assigneeId: event.target.value }))}>
                <option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.display_name}</option>)}
              </select></label>
              <Button type="submit" disabled={busy || !form.title.trim()}>Save details</Button>
            </form>}
          </section>}
          {!canProgress && !canManage && <p className="rounded-lg bg-canvas p-3 text-body text-muted">You can follow this task. The assigned member updates its progress.</p>}
          <section><h3 className="text-h2 text-ink">Activity</h3>
            {detail.updates.length === 0 ? <p className="mt-2 text-body text-muted">No updates yet.</p> :
              <ol className="mt-3 space-y-3">{detail.updates.map((update) => <li key={update.id} className="rounded-lg border border-line p-3 text-body">
                <p className="text-label text-ink">{update.author_name} · {new Date(update.created_at).toLocaleString()}</p>
                <p className="mt-1 whitespace-pre-wrap text-muted">{update.kind === "status" ? `${update.old_status.replaceAll("_", " ")} → ${update.new_status.replaceAll("_", " ")}` : update.body}</p>
              </li>)}</ol>}
            {detail.nextCursor && <Button variant="secondary" className="mt-3" disabled={loadingMore} onClick={async () => {
              setLoadingMore(true);
              try { const older = await getTask(taskId, detail.nextCursor); setDetail((current) => ({ ...current, updates: [...current.updates, ...older.updates], nextCursor: older.nextCursor })); }
              catch (err) { setError(err.response?.data?.message || "Could not load older updates"); }
              finally { setLoadingMore(false); }
            }}>{loadingMore ? "Loading…" : "Load older updates"}</Button>}
          </section>
        </div>}
      </div>
    </Modal>
  );
}

export default function Tasks() {
  const [params, setParams] = useSearchParams();
  const decisionId = params.get("decision") || undefined;
  const { setRoomHeader } = useOutletContext();
  const { user } = useAuth();
  const { rooms } = useChats();
  const { socket } = useRealtime();
  const [tasks, setTasks] = useState([]);
  const [counts, setCounts] = useState({ open: 0, in_progress: 0, done: 0 });
  const [next, setNext] = useState(null);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(params.get("task"));
  const [creating, setCreating] = useState(false);
  const [newTask, setNewTask] = useState({ roomId: "", title: "", body: "", dueDate: "", clientId: crypto.randomUUID() });
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const assignedOnly = filter === "mine";
  const assigneeId = assignedOnly ? user?.id : undefined;
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    if (assignedOnly && !assigneeId) {
      setTasks([]);
      setCounts({ open: 0, in_progress: 0, done: 0 });
      setNext(null);
      setLoading(false);
      return;
    }
    try {
      const result = await listTasks({ decisionId, assigneeId });
      if (version !== requestVersion.current) return;
      setTasks(result.tasks);
      setCounts(result.counts);
      setNext(result.nextCursor);
      setError("");
    } catch (err) {
      if (version === requestVersion.current)
        setError(err.response?.data?.message || "Could not load tasks");
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [assignedOnly, assigneeId, decisionId]);
  useEffect(() => { setRoomHeader("Tasks"); return () => setRoomHeader(null); }, [setRoomHeader]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const changed = () => { void refresh(); };
    socket?.on("task:updated", changed);
    window.addEventListener("focus", changed);
    return () => { socket?.off("task:updated", changed); window.removeEventListener("focus", changed); };
  }, [socket, refresh]);
  const loadMore = async () => {
    if (!next || loadingMore) return;
    const version = requestVersion.current;
    setLoadingMore(true);
    try {
      const result = await listTasks({ decisionId, assigneeId, before: next });
      if (version !== requestVersion.current) return;
      setTasks((current) => [...current, ...result.tasks.filter((task) => !current.some((item) => item.id === task.id))]);
      setCounts(result.counts);
      setNext(result.nextCursor);
    } catch (err) {
      if (version === requestVersion.current)
        setError(err.response?.data?.message || "Could not load more tasks");
    }
    finally { setLoadingMore(false); }
  };
  return <Page width="board">
    <header className="mb-5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-h1 text-ink">Tasks</h1>
          <p className="mt-1 text-body text-muted">Ownership, deadlines and progress.</p>
        </div>
        <Button
          onClick={() => {
            setNewTask({ roomId: rooms.find(() => true)?.id || "", title: "", body: "", dueDate: "", clientId: crypto.randomUUID() });
            setCreateError("");
            setCreating(true);
          }}
          className="shrink-0"
        >
          New task
        </Button>
      </div>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex w-fit rounded-xl bg-canvas p-1" role="group" aria-label="Task filter">
          <button
            type="button"
            aria-pressed={filter === "all"}
            className={`rounded-lg px-4 py-2 text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${filter === "all" ? "bg-brand text-white" : "text-muted hover:text-ink"}`}
            onClick={() => setFilter("all")}
          >
            All tasks
          </button>
          <button
            type="button"
            aria-pressed={filter === "mine"}
            className={`rounded-lg px-4 py-2 text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${filter === "mine" ? "bg-brand text-white" : "text-muted hover:text-ink"}`}
            onClick={() => setFilter("mine")}
          >
            Assigned to me
          </button>
        </div>
        <dl className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Task status overview">
          {COLUMNS.map((column) => (
            <div key={column.status} className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5">
              <dt className="flex items-center gap-2 text-metadata text-muted">
                <span className={`h-2 w-2 rounded-full ${column.bar}`} aria-hidden="true" />
                {column.label}
              </dt>
              <dd className="order-first text-sm font-semibold text-ink">{counts[column.status]}</dd>
            </div>
          ))}
        </dl>
      </div>
    </header>
    {decisionId && <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/30 bg-brand/5 p-4 text-body text-ink"><span>Showing tasks linked to one decision</span><button type="button" className="text-label text-brand hover:underline" onClick={() => setParams((current) => { const nextParams = new URLSearchParams(current); nextParams.delete("decision"); return nextParams; })}>Show all tasks</button></div>}
    {error && <p role="alert" className="mb-4 rounded-lg bg-error/10 p-3 text-body text-error">{error}</p>}
    {loading ? <Spinner label="Loading tasks" /> : tasks.length === 0 ? <EmptyState title="No tasks here yet" description="Flag a conversation message as a task to give work an owner and a place to track progress." /> :
      <div className="grid gap-5 md:grid-cols-3 md:items-start">{COLUMNS.map((column) => <section key={column.status} className="min-w-0 rounded-2xl bg-canvas p-3"><h2 className={`mb-4 flex items-center gap-2 text-h2 ${column.tone}`}><span className={`h-2 w-2 rounded-full ${column.bar}`} />{column.label} <span className="text-metadata text-muted">{counts[column.status]}</span></h2><div className="space-y-3">{tasks.filter((task) => task.status === column.status).map((task) => <button type="button" key={task.id} onClick={() => setSelected(task.id)} className="w-full rounded-xl border border-line bg-surface p-4 text-left shadow-sm transition hover:border-brand hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
        <span className="text-metadata text-brand">#{task.room_slug || task.room_name}</span>{task.decision_id && <span className="ml-2 text-metadata text-muted">From a decision</span>}<strong className="mt-2 block text-body text-ink [overflow-wrap:anywhere]">{task.title}</strong>{task.body && <span className="mt-1 block line-clamp-2 text-metadata text-muted">{task.body}</span>}
        <span className="mt-4 flex flex-wrap gap-2 text-metadata text-muted"><span>{task.assignee_name || "Unassigned"}</span><span aria-hidden="true">·</span><span className={isOverdue(task) ? "text-error" : ""}>{displayDate(task.due_date)}</span></span>
      </button>)}</div></section>)}</div>}
    {next && <div className="mt-6 text-center"><Button variant="secondary" disabled={loadingMore} onClick={loadMore}>{loadingMore ? "Loading…" : "Load more tasks"}</Button></div>}
    {selected && <TaskDetail taskId={selected} onClose={() => { setSelected(null); setParams((current) => { const nextParams = new URLSearchParams(current); nextParams.delete("task"); return nextParams; }); }} onChanged={refresh} />}
    <Modal open={creating} onClose={() => !creatingBusy && setCreating(false)} title="New task" closeDisabled={creatingBusy}>
      <form className="space-y-4" onSubmit={async (event) => { event.preventDefault(); setCreatingBusy(true); setCreateError(""); try { const created = await createTask(newTask); setCreating(false); await refresh(); setSelected(created.id); } catch (err) { setCreateError(err.response?.data?.message || "Could not create task"); } finally { setCreatingBusy(false); } }}>
        <label className="block text-label text-ink">Conversation<select required className="mt-2 min-h-11 w-full rounded-lg border border-line bg-surface px-3" value={newTask.roomId} onChange={(event) => setNewTask((current) => ({ ...current, roomId: event.target.value }))}>
          <option value="">Choose conversation</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.display_name || room.name}</option>)}
        </select></label>
        <Input label="Task" required maxLength={160} value={newTask.title} onChange={(event) => setNewTask((current) => ({ ...current, title: event.target.value }))} />
        <Textarea label="Instructions (optional)" maxLength={2000} rows={4} value={newTask.body} onChange={(event) => setNewTask((current) => ({ ...current, body: event.target.value }))} />
        <Input label="Due date (optional)" type="date" value={newTask.dueDate} onChange={(event) => setNewTask((current) => ({ ...current, dueDate: event.target.value }))} />
        <p className="text-metadata text-muted">You can assign a room member after creating the task.</p>
        {createError && <p role="alert" className="text-body text-error">{createError}</p>}
        <Button type="submit" disabled={creatingBusy || !newTask.roomId || !newTask.title.trim()}>{creatingBusy ? "Creating…" : "Create task"}</Button>
      </form>
    </Modal>
  </Page>;
}
