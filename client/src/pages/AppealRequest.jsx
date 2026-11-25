import { useState } from "react";
import { Link } from "react-router-dom";
import AuthLayout from "@/components/layout/AuthLayout";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Textarea from "@/components/ui/Textarea";
import * as moderation from "@/services/moderation.service";

export default function AppealRequest() {
  const [credentials, setCredentials] = useState({ email: "", password: "" });
  const [reason, setReason] = useState("");
  const [reportId, setReportId] = useState("");
  const [appeals, setAppeals] = useState(null);
  const [eligibleReports, setEligibleReports] = useState([]);
  const [canAppealSuspension, setCanAppealSuspension] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError(""); setMessage(""); setAppeals(null);
    try {
      const result = await moderation.requestAppeal({ ...credentials, reason, reportId: reportId.trim() || undefined });
      setMessage(result.message || "If the account details are valid and eligible, the request has been recorded.");
      setReason(""); setReportId("");
    } catch (cause) { setError(cause.response?.data?.message || "Could not submit the appeal. Try again later."); }
    finally { setBusy(false); }
  }
  async function checkStatus(event) {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await moderation.getAppealStatus(credentials);
      setAppeals(result.appeals || []);
      setEligibleReports(result.eligibleReports || []);
      setCanAppealSuspension(Boolean(result.canAppealSuspension));
      setMessage(result.message || "Appeal status loaded.");
    } catch (cause) { setError(cause.response?.data?.message || "Could not check appeal status."); }
    finally { setBusy(false); }
  }

  return <AuthLayout title="Appeal a moderation decision" description="Request a separate review of an account suspension or an action taken on a report." alternateText="Return to Conclave sign in when you are ready.">
    <div className="space-y-5">
      <p className="text-body text-muted">Verify with the email and password for the affected account. A reviewer who made the original decision cannot review its appeal.</p>
      <Input id="appeal-email" label="Account email" type="email" autoComplete="username" required value={credentials.email} onChange={(e) => setCredentials({ ...credentials, email: e.target.value })} />
      <Input id="appeal-password" label="Account password" type="password" autoComplete="current-password" required value={credentials.password} onChange={(e) => setCredentials({ ...credentials, password: e.target.value })} />
      <form onSubmit={submit} className="space-y-4">
        <Textarea id="appeal-reason" label="Why are you appealing?" required minLength={5} maxLength={3000} value={reason} onChange={(e) => setReason(e.target.value)} />
        {eligibleReports.length > 0 && <label className="grid gap-1 text-label text-ink">Report decision (optional)
          <select id="appeal-report-id" value={reportId} onChange={(e) => setReportId(e.target.value)} className="min-h-11 rounded-lg border border-line bg-surface px-3 text-body"><option value="">No report selected</option>{eligibleReports.map((report) => <option key={report.id} value={report.id}>{report.reason.replaceAll("_", " ")}{report.room_name ? ` · ${report.room_name}` : ""} · {new Date(report.created_at).toLocaleDateString()}</option>)}</select>
        </label>}
        {error && <p role="alert" className="rounded-lg bg-error/10 p-3 text-body text-error">{error}</p>}
        {message && <p role="status" className="rounded-lg bg-brand-soft p-3 text-body text-ink">{message}</p>}
        <Button type="submit" className="w-full" disabled={busy || !reason.trim()}>{busy ? "Submitting…" : "Submit appeal"}</Button>
      </form>
      <form onSubmit={checkStatus} className="border-t border-line pt-4">
        <Button type="submit" variant="secondary" className="w-full" disabled={busy || !credentials.email || !credentials.password}>Check appeal status</Button>
      </form>
      {appeals && <div className="space-y-2" aria-live="polite">
        {canAppealSuspension && <p className="text-metadata text-muted">A current suspension can be appealed without choosing a report.</p>}
        {!!eligibleReports.length && <p className="text-metadata text-muted">You can also appeal an actioned report by selecting it above.</p>}
        {!appeals.length && <p className="text-body text-muted">No appeal is available for these account details.</p>}
        {appeals.map((appeal) => <article key={appeal.id} className="rounded-xl border border-line bg-surface p-3"><div className="flex justify-between gap-3"><strong className="capitalize text-label text-ink">{appeal.status}</strong><span className="text-metadata text-muted">{new Date(appeal.created_at).toLocaleDateString()}</span></div>{appeal.resolution && <p className="mt-2 text-body text-muted">{appeal.resolution}</p>}</article>)}
      </div>}
      <Link className="block text-center text-label text-brand hover:underline" to="/login">Back to sign in</Link>
    </div>
  </AuthLayout>;
}
