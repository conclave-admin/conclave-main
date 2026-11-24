import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import Page from "@/components/layout/Page";
import * as moderation from "@/services/moderation.service";

const field = "min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-body text-ink";
const button = "min-h-10 rounded-lg border border-line bg-surface px-3 py-2 text-label text-ink hover:border-brand disabled:opacity-50";
const statuses = ["open", "reviewed", "actioned", "dismissed"];

export default function ModerationInbox() {
  const { setRoomHeader } = useOutletContext();
  const [filter, setFilter] = useState("open");
  const [reports, setReports] = useState([]);
  const [storage, setStorage] = useState(null);
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const result = await moderation.listReports({ status: filter });
      setReports(result.reports);
      const storageResult = await moderation.getStorageOverview();
      setStorage(storageResult);
      setError("");
      if (selected) {
        try { setSelected(await moderation.getReport(selected.report.id)); }
        catch { setSelected(null); }
      }
    } catch (cause) {
      setError(cause.response?.data?.message || "Could not load moderation reports");
    }
  }, [filter, selected?.report.id]);
  useEffect(() => { setRoomHeader("Safety reports"); return () => setRoomHeader(null); }, [setRoomHeader]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function act(operation) {
    setBusy(true); setError("");
    try { await operation(); await refresh(); }
    catch (cause) { setError(cause.response?.data?.message || "Could not save moderation action"); }
    finally { setBusy(false); }
  }

  async function openReport(id) {
    setError("");
    try { setSelected(await moderation.getReport(id)); setReason(""); }
    catch (cause) { setError(cause.response?.data?.message || "Could not open report"); }
  }

  return <Page width="board">
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-label uppercase text-brand">PLATFORM SAFETY</p><h1 className="mt-2 text-h1">Safety reports</h1>
        <p className="mt-2 text-body text-muted">Review reports and record each decision.</p></div>
      <Link className={button} to="/chats">Back to Conclave</Link>
    </div>
    {error && <p role="alert" className="mb-4 rounded-lg bg-error/10 p-3 text-body text-error">{error}</p>}
    {storage && <section aria-label="Beta storage monitoring" className="mb-5 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-h2">Beta storage</h2>
        <p className="mt-1 text-metadata text-muted">Storage estimate excludes bandwidth and provider operations. Check the provider billing console for actual spend.</p></div>
        <span className="text-metadata text-muted">Updated {new Date(storage.generatedAt).toLocaleString()}</span></div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg bg-canvas p-3"><p className="text-metadata text-muted">Active storage</p><p className="mt-1 text-h2">{Number(storage.usage.total_gb).toFixed(2)} GB</p><p className="text-metadata text-muted">{Number(storage.usage.objects).toLocaleString()} uploads</p></div>
        <div className="rounded-lg bg-canvas p-3"><p className="text-metadata text-muted">Beta cohort</p><p className="mt-1 text-h2">Up to {storage.limits.maxActiveAccounts} accounts</p><p className="text-metadata text-muted">Open signup closes automatically at the cap</p></div>
        <div className="rounded-lg bg-canvas p-3"><p className="text-metadata text-muted">Storage-only monthly estimate</p><p className="mt-1 text-h2">{storage.estimatedStorageOnlyMonthlyUsd == null ? "Not configured" : `$${Number(storage.estimatedStorageOnlyMonthlyUsd).toFixed(2)}`}</p><p className="text-metadata text-muted">Rate: {storage.limits.storageUsdPerGbMonth ? `$${storage.limits.storageUsdPerGbMonth}/GB-month` : "unset"}</p></div>
        <div className="rounded-lg bg-canvas p-3"><p className="text-metadata text-muted">Cleanup queue</p><p className="mt-1 text-h2">{Number(storage.cleanup.queued).toLocaleString()} pending</p><p className={`text-metadata ${storage.alerts.deletionFailures ? "text-error" : "text-muted"}`}>{storage.alerts.deletionFailures ? `${storage.cleanup.repeated_failures} repeated failures need review` : "No repeated failures"}</p></div>
      </div>
      {(storage.alerts.storageThresholdExceeded || storage.alerts.storageBudgetExceeded || storage.alerts.deletionFailures || storage.alerts.costRateUnconfigured) && <p role="status" className="mt-3 rounded-lg bg-warning/10 p-3 text-body text-ink">
        {storage.alerts.storageThresholdExceeded && `Storage is at or above the ${storage.limits.storageAlertGb} GB threshold. `}
        {storage.alerts.storageBudgetExceeded && "The configured storage-only budget estimate has been reached. "}
        {storage.alerts.deletionFailures && "Inspect repeated object cleanup failures. "}
        {storage.alerts.costRateUnconfigured && "Set the storage price estimate and budget in backend configuration. "}
        Review actual provider charges and follow the response steps in docs/BETA_OPERATIONS.md.
      </p>}
    </section>}
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
      <section aria-label="Reports" className="rounded-xl border border-line bg-surface p-4">
        <label className="text-label">Status<select className={`ml-3 ${field}`} value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="open">Open</option><option value="reviewed">Reviewed</option><option value="actioned">Actioned</option><option value="dismissed">Dismissed</option><option value="all">All reports</option></select></label>
        <div className="mt-4 divide-y divide-line">{reports.map((report) => <button key={report.id} type="button" onClick={() => void openReport(report.id)}
          className={`block w-full py-4 text-left ${selected?.report.id === report.id ? "text-brand" : "text-ink"}`}>
          <span className="flex items-center justify-between gap-3"><strong>{report.reason.replaceAll("_", " ")}</strong><span className="text-metadata text-muted">{report.status}</span></span>
          <span className="mt-1 block text-body">{report.reported_display_name}{report.reported_suspended ? " · suspended" : ""}</span>
          <span className="mt-1 block text-metadata text-muted">{report.room_name || "No conversation attached"} · {new Date(report.created_at).toLocaleString()}</span>
        </button>)}
          {!reports.length && <p className="py-6 text-body text-muted">No reports in this view.</p>}
        </div>
      </section>

      <section aria-label="Selected report" className="h-fit rounded-xl border border-line bg-surface p-5">
        {!selected ? <p className="text-body text-muted">Select a report to review its details.</p> : <>
          <div className="flex items-start justify-between gap-3"><div><p className="text-metadata uppercase text-brand">{selected.report.status}</p>
            <h2 className="mt-1 text-h2">{selected.report.reason.replaceAll("_", " ")}</h2></div><span className="text-metadata text-muted">{new Date(selected.report.created_at).toLocaleString()}</span></div>
          <p className="mt-3 text-body">Reported account: <strong>{selected.report.reported_display_name}</strong></p>
          {selected.report.room_name && <p className="mt-1 text-body text-muted">Conversation: {selected.report.room_name}</p>}
          {selected.report.details && <p className="mt-3 whitespace-pre-wrap rounded-lg bg-canvas p-3 text-body">{selected.report.details}</p>}
          <h3 className="mt-5 text-label">Nearby conversation context</h3>
          <div className="mt-2 space-y-2">{selected.context.map((item) => <article key={item.id} className="rounded-lg bg-canvas p-3">
            <p className="text-metadata text-muted">{item.sender_name || "Deleted user"} · {new Date(item.created_at).toLocaleTimeString()}</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-body">{item.content || "Attachment or empty message"}</p>
          </article>)}{!selected.context.length && <p className="text-body text-muted">No retained message context is available.</p>}</div>
          <p className="mt-4 text-metadata text-muted">Reporter identity is withheld. Report views and decisions are recorded.</p>
          <label className="mt-5 block text-label">Decision reason<textarea className={`mt-2 w-full ${field}`} rows={3} minLength={5} maxLength={1000} required value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          <div className="mt-3 flex flex-wrap gap-2">{statuses.filter((status) => status !== selected.report.status).map((status) => <button key={status} type="button" className={button}
            disabled={busy || reason.trim().length < 5} onClick={() => void act(async () => {
              await moderation.transitionReport(selected.report.id, { expectedStatus: selected.report.status, status, reason });
              setSelected(await moderation.getReport(selected.report.id));
            })}>{status === "actioned" ? "Mark actioned" : `Mark ${status}`}</button>)}</div>
          <div className="mt-5 border-t border-line pt-4">{selected.report.reported_suspended ? <button className={button} disabled={busy || reason.trim().length < 5}
            onClick={() => void act(() => moderation.restoreAccount(selected.report.reported_user_id, reason))}>Restore account</button>
            : <button className={button} disabled={busy || reason.trim().length < 5} onClick={() => void act(() => moderation.suspendAccount(selected.report.reported_user_id, reason))}>Suspend account</button>}
          </div>
          <details className="mt-5"><summary className="cursor-pointer text-label">Decision history</summary><ol className="mt-2 space-y-2">{selected.audit.map((entry) => <li key={entry.id} className="text-metadata text-muted">
            {entry.action.replaceAll("_", " ")} · {entry.from_status && `${entry.from_status} → ${entry.to_status} · `}{entry.reason || ""} · {new Date(entry.created_at).toLocaleString()}
          </li>)}</ol></details>
        </>}
      </section>
    </div>
  </Page>;
}
