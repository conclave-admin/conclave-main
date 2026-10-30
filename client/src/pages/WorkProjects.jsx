import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import Page from "@/components/layout/Page";
import Spinner from "@/components/ui/Spinner";
import { useChats } from "@/contexts/ChatsContext";
import { useAuth } from "@/contexts/AuthContext";
import * as work from "@/services/work.service";

const field = "min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-body text-ink";
const secondary = "rounded-lg border border-line bg-surface px-3 py-2 text-label text-ink hover:border-brand focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50";
const primary = "rounded-lg bg-brand px-4 py-2 text-label text-white hover:opacity-90 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50";

function useHeader(title) {
  const { setRoomHeader } = useOutletContext();
  useEffect(() => { setRoomHeader(title); return () => setRoomHeader(null); }, [setRoomHeader, title]);
}
function ErrorLine({ value }) { return value ? <p role="alert" className="rounded-lg bg-error/10 p-3 text-body text-error">{value}</p> : null; }

export function ProjectsIndex() {
  useHeader("Projects");
  const { rooms } = useChats();
  const [projects, setProjects] = useState([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [roomIds, setRoomIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { const result = await work.listProjects(); setProjects(result.projects); setError(""); }
    catch (e) { setError(e.response?.data?.message || "Could not load projects"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function create(event) {
    event.preventDefault(); setBusy(true); setError("");
    try { await work.createProject({ name, description, roomIds }); setName(""); setDescription(""); setRoomIds([]); await refresh(); }
    catch (e) { setError(e.response?.data?.message || "Could not create project"); }
    finally { setBusy(false); }
  }
  const available = rooms.filter((room) => room.type !== "dm" && room.encryption_mode !== "e2ee-v1" && room.my_role === "admin");
  return <Page width="board">
    <div className="mb-7"><p className="text-label text-brand">CONNECTED WORK</p><h1 className="mt-2 text-h1">Projects</h1>
      <p className="mt-2 text-body text-muted">Bring conversations, decisions, tasks and milestones into one place.</p></div>
    <ErrorLine value={error} />
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section aria-label="Your projects" className="space-y-3">
        {loading ? <Spinner label="Loading projects" /> : projects.length ? projects.map((p) =>
          <Link key={p.id} to={`/work/projects/${p.id}`} className="block rounded-xl border border-line bg-surface p-5 hover:border-brand focus-visible:outline-2 focus-visible:outline-brand">
            <span className="text-metadata uppercase text-brand">{p.status} · {p.room_count} rooms</span>
            <h2 className="mt-2 text-h2 text-ink">{p.name}</h2>
            {p.description && <p className="mt-2 line-clamp-2 text-body text-muted">{p.description}</p>}
          </Link>) : <p className="rounded-xl border border-dashed border-line p-6 text-body text-muted">No projects yet. Create one from conversations you manage.</p>}
      </section>
      <form onSubmit={create} className="h-fit space-y-4 rounded-xl border border-line bg-surface p-5">
        <h2 className="text-h2">New project</h2>
        <label className="block text-label">Name<input className={`mt-2 ${field}`} required maxLength={160} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="block text-label">Description<textarea className={`mt-2 ${field}`} maxLength={2000} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <fieldset><legend className="text-label">Conversations you administer</legend><div className="mt-2 max-h-48 space-y-2 overflow-auto rounded-lg border border-line p-3">
          {available.length ? available.map((room) => <label key={room.id} className="flex gap-2 text-body"><input type="checkbox" checked={roomIds.includes(room.id)}
            onChange={(e) => setRoomIds((ids) => e.target.checked ? [...ids, room.id] : ids.filter((id) => id !== room.id))} />{room.display_name || room.name}</label>)
            : <p className="text-body text-muted">Create a group conversation first.</p>}</div></fieldset>
        <button className={primary} disabled={busy || !name.trim() || !roomIds.length}>{busy ? "Creating…" : "Create project"}</button>
      </form>
    </div>
  </Page>;
}

export function ProjectDetail() {
  const { projectId } = useParams();
  useHeader("Project");
  const { user } = useAuth();
  const { rooms } = useChats();
  const [detail, setDetail] = useState(null);
  const [rules, setRules] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newRoom, setNewRoom] = useState("");
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [milestoneDue, setMilestoneDue] = useState("");
  const [dependency, setDependency] = useState({ taskId: "", dependsOnId: "" });
  const [editingProject, setEditingProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const refresh = useCallback(async () => {
    try { const [project, automations] = await Promise.all([work.getProject(projectId), work.listAutomations(projectId)]);
      setDetail(project); setRules(automations.rules); setProjectName(project.project.name); setProjectDescription(project.project.description); setError(""); }
    catch (e) { setError(e.response?.data?.message || "Could not load project"); }
  }, [projectId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const canManage = detail?.project.created_by === user?.id;
  const linkedRooms = useMemo(() => new Set(detail?.rooms.map((room) => room.id) || []), [detail]);
  async function action(fn) {
    setBusy(true); setError("");
    try { await fn(); await refresh(); }
    catch (e) { setError(e.response?.data?.message || "Could not save change"); }
    finally { setBusy(false); }
  }
  return <Page width="board">
    <Link to="/work" className="text-label text-brand hover:underline">← All projects</Link>
    <ErrorLine value={error} />
    {!detail ? <Spinner label="Loading project" /> : <>
      <header className="mt-4 rounded-xl border border-line bg-surface p-6"><p className="text-label uppercase text-brand">{detail.project.status} project</p>
        <h1 className="mt-2 text-h1">{detail.project.name}</h1><p className="mt-2 text-body text-muted">{detail.project.description}</p>
        {canManage && <div className="mt-4 flex flex-wrap gap-2">{["active", "completed", "archived"].filter((s) => s !== detail.project.status).map((s) =>
          <button key={s} className={secondary} disabled={busy} onClick={() => void action(() => work.updateProject(projectId,
            { name: detail.project.name, description: detail.project.description, status: s }))}>Mark {s}</button>)}
          <button className={secondary} onClick={() => setEditingProject((value) => !value)}>Edit details</button></div>}
        {canManage && editingProject && <form className="mt-4 grid gap-2" onSubmit={(e) => { e.preventDefault(); void action(async () => { await work.updateProject(projectId,
          { name: projectName, description: projectDescription, status: detail.project.status }); setEditingProject(false); }); }}>
          <input aria-label="Project name" className={field} value={projectName} maxLength={160} required onChange={(e) => setProjectName(e.target.value)} />
          <textarea aria-label="Project description" className={field} value={projectDescription} maxLength={2000} rows={3} onChange={(e) => setProjectDescription(e.target.value)} />
          <button className={primary} disabled={busy || !projectName.trim()}>Save details</button></form>}
      </header>
      <section className="mt-6" aria-label="Project report"><h2 className="text-h2">Project health</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">{[
          ["Tasks", detail.report.total], ["Done", detail.report.done], ["Blocked", detail.report.blocked],
          ["Overdue", detail.report.overdue], ["Unassigned", detail.report.unassigned],
        ].map(([label, count]) => <a key={label} href="#project-tasks" className="rounded-xl border border-line bg-surface p-4 hover:border-brand"><strong className="block text-h1">{count}</strong><span className="text-metadata text-muted">{label}</span></a>)}</div>
        {detail.truncated && <p className="mt-2 text-metadata text-muted">Counts include all visible tasks; the lists below show the most recent items.</p>}
      </section>
      <div className="mt-7 grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-surface p-5"><h2 className="text-h2">Conversations and briefs</h2>
          <div className="mt-3 space-y-3">{detail.rooms.map((room) => <div key={room.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-canvas p-3">
            <div><Link className="text-label text-brand hover:underline" to={`/chats/${room.id}`}>{room.name}</Link><p className="text-metadata text-muted">{room.role}</p></div>
            <div className="flex gap-2"><Link className={secondary} to={`/work/rooms/${room.id}/brief`}>Brief</Link>
              {canManage && room.role === "admin" && <button className={secondary} disabled={busy} onClick={() => void action(() => work.removeProjectRoom(projectId, room.id))}>Remove</button>}</div>
          </div>)}</div>
          {canManage && <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); void action(async () => { await work.addProjectRoom(projectId, newRoom); setNewRoom(""); }); }}>
            <select aria-label="Add conversation" className={field} value={newRoom} onChange={(e) => setNewRoom(e.target.value)} required><option value="">Add conversation</option>
              {rooms.filter((room) => !linkedRooms.has(room.id) && room.type !== "dm" && room.encryption_mode !== "e2ee-v1" && room.my_role === "admin").map((room) =>
                <option key={room.id} value={room.id}>{room.display_name || room.name}</option>)}</select><button className={primary} disabled={busy || !newRoom}>Add</button></form>}
        </section>
        <section className="rounded-xl border border-line bg-surface p-5"><h2 className="text-h2">Milestones</h2><div className="mt-3 space-y-2">{detail.milestones.map((m) =>
          <div key={m.id} className="flex items-center justify-between gap-3 rounded-lg bg-canvas p-3 text-body"><div><strong>{m.title}</strong><p className="text-metadata text-muted">{m.done_tasks}/{m.total_tasks} tasks · {m.due_date || "No due date"}</p></div>
            {canManage && <button className={secondary} disabled={busy} onClick={() => void action(() => work.updateMilestone(projectId, m.id,
              { title: m.title, dueDate: m.due_date, completed: !m.completed_at }))}>{m.completed_at ? "Reopen" : "Complete"}</button>}</div>)}</div>
          {canManage && <form className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto_auto]" onSubmit={(e) => { e.preventDefault(); void action(async () => { await work.createMilestone(projectId,
            { title: milestoneTitle, dueDate: milestoneDue || null }); setMilestoneTitle(""); setMilestoneDue(""); }); }}>
            <input aria-label="Milestone title" placeholder="New milestone" className={field} value={milestoneTitle} maxLength={160} required onChange={(e) => setMilestoneTitle(e.target.value)} />
            <input aria-label="Milestone due date" type="date" className={field} value={milestoneDue} onChange={(e) => setMilestoneDue(e.target.value)} />
            <button className={primary} disabled={busy || !milestoneTitle.trim()}>Add</button></form>}
        </section>
      </div>
      <section id="project-tasks" className="mt-6 rounded-xl border border-line bg-surface p-5"><h2 className="text-h2">Tasks and blockers</h2>
        <div className="mt-3 space-y-2">{detail.tasks.map((task) => <div key={task.id} className="grid gap-2 rounded-lg border border-line p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <div><Link className="text-label text-brand hover:underline" to={`/tasks?task=${task.id}`}>{task.title}</Link>
            <p className="text-metadata text-muted">{task.room_name} · {task.assignee_name || "Unassigned"} · {task.status.replaceAll("_", " ")}{task.open_blockers > 0 ? ` · ${task.open_blockers} blockers` : ""}</p></div>
          {(task.created_by === user?.id || detail.rooms.some((room) => room.id === task.room_id && room.role === "admin")) && <select aria-label={`Milestone for ${task.title}`} className={field} value={task.milestone_id || ""} disabled={busy}
            onChange={(e) => void action(() => work.setTaskMilestone(task.id, e.target.value || null))}><option value="">No milestone</option>
            {detail.milestones.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</select>}
          {(detail.dependencies || []).filter((dep) => dep.task_id === task.id).map((dep) => <div key={dep.depends_on_id} className="flex items-center gap-2 text-metadata text-muted">Waiting for {dep.blocker_title}
            {(task.created_by === user?.id || detail.rooms.some((room) => room.id === task.room_id && room.role === "admin")) && <button type="button" className="text-brand hover:underline" disabled={busy} onClick={() => void action(() => work.removeDependency(task.id, dep.depends_on_id))}>Remove</button>}</div>)}
        </div>)}</div>
        <form className="mt-4 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void action(async () => { await work.addDependency(dependency.taskId, dependency.dependsOnId); setDependency({ taskId: "", dependsOnId: "" }); }); }}>
          <select aria-label="Blocked task" className={field} required value={dependency.taskId} onChange={(e) => setDependency((d) => ({ ...d, taskId: e.target.value }))}><option value="">Task that is blocked</option>{detail.tasks.filter((t) => t.created_by === user?.id || detail.rooms.some((room) => room.id === t.room_id && room.role === "admin")).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
          <select aria-label="Blocking task" className={field} required value={dependency.dependsOnId} onChange={(e) => setDependency((d) => ({ ...d, dependsOnId: e.target.value }))}><option value="">Waits for task</option>{detail.tasks.filter((t) => t.id !== dependency.taskId).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
          <button className={primary} disabled={busy || !dependency.taskId || !dependency.dependsOnId}>Add blocker</button></form>
      </section>
      <section className="mt-6 rounded-xl border border-line bg-surface p-5"><h2 className="text-h2">Decisions</h2><div className="mt-3 space-y-2">{detail.decisions.map((d) =>
        <Link key={d.id} to={`/decisions/${d.id}`} className="block rounded-lg border border-line p-3 text-body hover:border-brand">{d.title}<span className="ml-2 text-metadata text-muted">{d.room_name} · {d.status}</span></Link>)}</div></section>
      <section className="mt-6 rounded-xl border border-line bg-surface p-5"><h2 className="text-h2">Automations</h2>
        <p className="mt-1 text-body text-muted">Rules run once per matching event. Activity is recorded below.</p>
        <div className="mt-3 space-y-2">{rules.map((rule) => <div key={rule.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-3 text-body">
          <span>{rule.trigger_kind === "decision_recorded" ? "New decision → follow-up task" : "Overdue task → notify assignee"}<small className="ml-2 text-muted">{rule.run_count} runs</small></span>
          {canManage && <button className={secondary} disabled={busy} onClick={() => void action(() => work.setAutomation(projectId, rule.id, !rule.enabled))}>{rule.enabled ? "Pause" : "Enable"}</button>}
        </div>)}</div>
        {canManage && <div className="mt-4 flex flex-wrap gap-2">{!rules.some((r) => r.trigger_kind === "decision_recorded") && <button className={secondary} disabled={busy} onClick={() => void action(() => work.createAutomation(projectId, { triggerKind: "decision_recorded" }))}>Add decision follow-up</button>}
          {!rules.some((r) => r.trigger_kind === "task_overdue") && <button className={secondary} disabled={busy} onClick={() => void action(() => work.createAutomation(projectId, { triggerKind: "task_overdue" }))}>Add overdue reminder</button>}</div>}
      </section>
    </>}
  </Page>;
}
