import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import Page from "@/components/layout/Page";
import { useAuth } from "@/contexts/AuthContext";
import * as moderation from "@/services/moderation.service";

const field = "min-h-10 rounded-lg border border-line bg-surface px-3 py-2 text-body text-ink";
const button = "min-h-10 rounded-lg border border-line bg-surface px-3 py-2 text-label text-ink hover:border-brand disabled:opacity-50";

export default function ModerationAppeals() {
  const { setRoomHeader } = useOutletContext();
  const { user } = useAuth();
  const [filter, setFilter] = useState("open");
  const [assignment, setAssignment] = useState("all");
  const [appeals, setAppeals] = useState([]);
  const [selected, setSelected] = useState(null);
  const [moderators, setModerators] = useState([]);
  const [canAssignOthers, setCanAssignOthers] = useState(false);
  const [resolution, setResolution] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [listed, reviewerList] = await Promise.all([
        moderation.listAppeals({ status: filter, assignment }),
        moderation.listModerators(),
      ]);
      setAppeals(listed.appeals || []);
      setModerators(reviewerList.moderators || []);
      setCanAssignOthers(Boolean(reviewerList.canAssignOthers));
      if (selected?.appeal.id) {
        try { setSelected(await moderation.getAppeal(selected.appeal.id)); }
        catch { setSelected(null); }
      }
      setError("");
    } catch (cause) { setError(cause.response?.data?.message || "Could not load appeals"); }
  }, [filter, assignment, selected?.appeal.id]);
  useEffect(() => { setRoomHeader("Appeals"); return () => setRoomHeader(null); }, [setRoomHeader]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function act(operation) {
    setBusy(true); setError("");
    try { await operation(); await refresh(); }
    catch (cause) { setError(cause.response?.data?.message || "Could not save appeal update"); }
    finally { setBusy(false); }
  }
  async function open(id) {
    setError(""); setResolution("");
    try { setSelected(await moderation.getAppeal(id)); }
    catch (cause) { setError(cause.response?.data?.message || "Could not open appeal"); }
  }
  async function transition(status) {
    await moderation.transitionAppeal(selected.appeal.id, {
      expectedStatus: selected.appeal.status,
      status,
      resolution,
    });
    setResolution("");
  }

  return <Page width="board">
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3"><div><p className="text-label uppercase text-brand">PLATFORM SAFETY</p><h1 className="mt-2 text-h1">Appeals</h1><p className="mt-2 text-body text-muted">A different reviewer handles appeals of suspensions and report actions.</p></div><div className="flex gap-2"><Link className={button} to="/moderation/reports">Reports</Link><a className={button} href="https://conclave.com.ng">Back to Conclave</a></div></div>
    {error && <p role="alert" className="mb-4 rounded-lg bg-error/10 p-3 text-body text-error">{error}</p>}
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
      <section aria-label="Appeal queue" className="rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap gap-2"><label className="text-label">Status<select className={`ml-2 ${field}`} value={filter} onChange={(e) => setFilter(e.target.value)}><option value="open">Open</option><option value="reviewed">Reviewed</option><option value="upheld">Upheld</option><option value="reversed">Reversed</option><option value="all">All</option></select></label><label className="text-label">Assignment<select className={`ml-2 ${field}`} value={assignment} onChange={(e) => setAssignment(e.target.value)}><option value="all">All reviewers</option><option value="mine">Assigned to me</option><option value="unassigned">Unassigned</option></select></label></div>
        <div className="mt-4 divide-y divide-line">{appeals.map((appeal) => <button key={appeal.id} type="button" onClick={() => void open(appeal.id)} className={`block w-full py-4 text-left ${selected?.appeal.id === appeal.id ? "text-brand" : "text-ink"}`}><span className="flex justify-between gap-3"><strong>{appeal.subject_name || "Unavailable account"}{appeal.subject_suspended ? " · suspended" : ""}</strong><span className="text-metadata text-muted">{appeal.status}</span></span><span className="mt-1 block text-metadata text-muted">{appeal.report_id ? `Report appeal · ${appeal.report_reason || "report"}` : "Suspension appeal"} · {appeal.assignee_name || "Unassigned"}</span><span className="mt-1 block text-metadata text-muted">{new Date(appeal.created_at).toLocaleString()}</span></button>)}{!appeals.length && <p className="py-6 text-body text-muted">No appeals in this view.</p>}</div>
      </section>
      <section aria-label="Selected appeal" className="h-fit rounded-xl border border-line bg-surface p-5">
        {!selected ? <p className="text-body text-muted">Select an appeal to review its request and history.</p> : <>
          <div className="flex items-start justify-between gap-3"><div><p className="text-metadata uppercase text-brand">{selected.appeal.status}</p><h2 className="mt-1 text-h2">{selected.appeal.subject_name || "Unavailable account"}</h2></div><span className="text-metadata text-muted">{new Date(selected.appeal.created_at).toLocaleString()}</span></div>
          <p className="mt-3 text-body text-muted">{selected.appeal.suspension_case_id ? "Appeal of account suspension" : "Appeal of a report action"}{selected.appeal.report_reason ? ` · ${selected.appeal.report_reason.replaceAll("_", " ")}` : ""}</p>
          <p className="mt-4 whitespace-pre-wrap rounded-lg bg-canvas p-3 text-body text-ink">{selected.appeal.reason}</p>
          <p className="mt-3 text-metadata text-muted">Assigned to {selected.appeal.assignee_name || "no reviewer"}</p>
          <div className="mt-3 flex flex-wrap gap-2"><button className={button} disabled={busy || selected.appeal.assigned_to === user?.id} onClick={() => void act(() => moderation.assignAppeal(selected.appeal.id, user.id))}>Assign to me</button>{canAssignOthers && <><select aria-label="Assign appeal to reviewer" className={field} value={selected.appeal.assigned_to || ""} onChange={(e) => setSelected({ ...selected, appeal: { ...selected.appeal, assigned_to: e.target.value || null } })}><option value="">Choose reviewer</option>{moderators.map((moderator) => <option key={moderator.id} value={moderator.id}>{moderator.display_name} · {moderator.role}</option>)}</select><button className={button} disabled={busy || !selected.appeal.assigned_to} onClick={() => void act(() => moderation.assignAppeal(selected.appeal.id, selected.appeal.assigned_to))}>Assign</button></>}</div>
          {(selected.appeal.status === "open" || selected.appeal.status === "reviewed") && <><label className="mt-5 block text-label">Review decision<textarea className={`mt-2 w-full ${field}`} rows={3} minLength={5} maxLength={1000} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="Explain the review outcome" /></label><div className="mt-3 flex flex-wrap gap-2">{(selected.appeal.status === "open" ? [["reviewed","Mark reviewed"],["upheld","Uphold decision"],["reversed","Reverse decision"]] : [["open","Reopen"],["upheld","Uphold decision"],["reversed","Reverse decision"]]).map(([status,label]) => <button key={status} type="button" className={button} disabled={busy || selected.appeal.assigned_to !== user?.id || resolution.trim().length < 5} onClick={() => void act(() => transition(status))}>{label}</button>)}</div></>}
          <details className="mt-5"><summary className="cursor-pointer text-label">Audit history</summary><ol className="mt-2 space-y-2">{selected.audit.map((entry) => <li key={entry.id} className="text-metadata text-muted">{entry.action.replaceAll("_", " ")}{entry.actor_name ? ` · ${entry.actor_name}` : ""} · {entry.from_status && `${entry.from_status} → ${entry.to_status} · `}{entry.reason || ""} · {new Date(entry.created_at).toLocaleString()}</li>)}</ol></details>
        </>}
      </section>
    </div>
  </Page>;
}
