import { useCallback, useEffect, useState } from "react";
import * as moderation from "@/services/moderation.service";

const field = "min-h-10 rounded-lg border border-line bg-surface px-3 py-2 text-body text-ink";
const button = "min-h-10 rounded-lg border border-line bg-surface px-3 py-2 text-label text-ink hover:border-brand disabled:opacity-50";

export default function PlatformOperators() {
  const [operators, setOperators] = useState([]);
  const [nextOffset, setNextOffset] = useState(null);
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await moderation.listOperators({ search, limit: 50, offset: 0 });
      setOperators(result.operators || []);
      setNextOffset(result.nextOffset);
      setError("");
    } catch (cause) {
      setError(cause.response?.data?.message || "Could not load platform operators.");
    }
  }, [search]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function loadMore() {
    if (nextOffset === null) return;
    try {
      const result = await moderation.listOperators({ search, limit: 50, offset: nextOffset });
      setOperators((current) => [...current, ...(result.operators || [])]);
      setNextOffset(result.nextOffset);
    } catch (cause) {
      setError(cause.response?.data?.message || "Could not load more accounts.");
    }
  }

  async function save() {
    if (!pending || reason.trim().length < 5) return;
    setBusy(true);
    try {
      await moderation.changeOperatorRole(pending.id, { role: pending.nextRole, expectedRole: pending.role, reason });
      setPending(null);
      setReason("");
      await refresh();
    } catch (cause) {
      setError(cause.response?.data?.message || "Could not update platform access.");
    } finally { setBusy(false); }
  }

  return <section>
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><p className="text-label uppercase text-brand">ACCESS CONTROL</p><h1 className="mt-2 text-h1">Platform operators</h1><p className="mt-2 max-w-2xl text-body text-muted">Grant or remove moderator and administrator access for existing, verified accounts. Every change is audited and ends the account’s active sessions.</p></div><label className="grid gap-1 text-label text-muted">Search accounts<input className={field} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or email" /></label></div>
    {error && <p role="alert" className="mb-4 rounded-lg bg-error/10 p-3 text-body text-error">{error}</p>}
    <div className="overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full min-w-[760px] text-left text-body"><thead className="border-b border-line bg-canvas text-label text-muted"><tr><th className="p-3">Account</th><th className="p-3">Role</th><th className="p-3">Status</th><th className="p-3">Change access</th></tr></thead><tbody>{operators.map((operator) => <tr key={operator.id} className="border-b border-line last:border-0"><td className="p-3"><strong className="block font-medium text-ink">{operator.display_name}</strong><span className="text-metadata text-muted">{operator.email}</span></td><td className="p-3 capitalize">{operator.role}</td><td className="p-3 text-muted">{operator.suspended_at ? "Suspended" : operator.email_verified_at ? "Verified" : "Unverified"}</td><td className="p-3"><select aria-label={`Change role for ${operator.display_name}`} className={field} value={operator.role} disabled={Boolean(operator.suspended_at)} onChange={(event) => setPending({ ...operator, nextRole: event.target.value })}><option value="admin" disabled={!operator.email_verified_at}>Administrator</option><option value="moderator" disabled={!operator.email_verified_at}>Moderator</option><option value="user">User</option></select></td></tr>)}{!operators.length && <tr><td className="p-6 text-center text-muted" colSpan="4">No matching accounts found.</td></tr>}</tbody></table></div>
    {nextOffset !== null && <div className="mt-4 flex justify-center"><button type="button" className={button} onClick={() => void loadMore()}>Load more accounts</button></div>}
    {pending && <div className="fixed inset-0 z-50 grid place-items-center bg-ink/50 p-4" onMouseDown={() => !busy && setPending(null)}><section role="dialog" aria-modal="true" aria-labelledby="operator-change-title" className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-modal" onMouseDown={(event) => event.stopPropagation()}><h2 id="operator-change-title" className="text-h2 text-ink">Confirm access change</h2><p className="mt-2 text-body text-muted">Change {pending.display_name} from {pending.role} to {pending.nextRole}? Their active sessions will be revoked.</p><label className="mt-5 grid gap-2 text-label text-ink">Reason for this change<textarea className={`${field} min-h-24`} value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={1000} required /></label><div className="mt-5 flex justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={() => setPending(null)}>Cancel</button><button type="button" className={`${button} border-brand text-brand`} disabled={busy || reason.trim().length < 5} onClick={() => void save()}>{busy ? "Saving…" : "Save role"}</button></div></section></div>}
  </section>;
}
