import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import Avatar from "@/components/ui/Avatar";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import Modal from "@/components/ui/Modal";
import Page from "@/components/layout/Page";
import Spinner from "@/components/ui/Spinner";
import { useToast } from "@/contexts/ToastContext";
import { getMessageRequests, respondToRequest } from "@/services/security.service";
import { blockUser, reportUser } from "@/services/users.service";

const UNDO_MS = 10_000;

function undoRemaining(request, now) {
  if (request.status !== "declined" || !request.declined_at) return 0;
  return Math.max(0, UNDO_MS - (now - new Date(request.declined_at).getTime()));
}

function errorMessage(error) {
  return error?.response?.data?.message || error?.message || "Please try again.";
}

export default function MessageRequests() {
  const navigate = useNavigate();
  const { setRoomHeader } = useOutletContext();
  const { toast } = useToast();
  const [requests, setRequests] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [busyRoomId, setBusyRoomId] = useState(null);
  const [error, setError] = useState("");
  const [blockTarget, setBlockTarget] = useState(null);
  const [reportTarget, setReportTarget] = useState(null);
  const [reportReason, setReportReason] = useState("spam");
  const [reportDetails, setReportDetails] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setRequests(await getMessageRequests());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setRoomHeader("Message requests");
    void load();
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => {
      setRoomHeader(null);
      window.clearInterval(timer);
    };
  }, [load, setRoomHeader]);

  async function respond(request, status) {
    setBusyRoomId(request.room_id);
    setError("");
    try {
      const updated = await respondToRequest(request.room_id, status);
      if (status === "accepted") {
        toast({ title: `Request accepted`, tone: "success" });
        navigate(`/chats/${request.room_id}`);
        return;
      }
      setRequests((items) =>
        items.map((item) =>
          item.room_id === request.room_id ? { ...item, ...updated } : item,
        ),
      );
      if (status === "declined")
        toast({ title: "Request declined", description: "You can undo this for 10 seconds.", tone: "success" });
      else toast({ title: "Decline undone", description: "The request is open again.", tone: "success" });
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause?.response?.status === 409) void load();
    } finally {
      setBusyRoomId(null);
    }
  }

  async function confirmBlock() {
    if (!blockTarget) return;
    setBusyRoomId(blockTarget.room_id);
    try {
      await blockUser(blockTarget.sender_id);
      setRequests((items) => items.filter((item) => item.room_id !== blockTarget.room_id));
      toast({ title: `${blockTarget.sender_name} blocked`, description: "They can no longer message or call you.", tone: "success" });
      setBlockTarget(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyRoomId(null);
    }
  }

  async function submitReport(event) {
    event.preventDefault();
    if (!reportTarget) return;
    setBusyRoomId(reportTarget.room_id);
    try {
      await reportUser(reportTarget.sender_id, {
        reason: reportReason,
        details: reportDetails,
        roomId: reportTarget.room_id,
      });
      toast({ title: "Report submitted", description: "The request is still available to accept or decline.", tone: "success" });
      setReportTarget(null);
      setReportDetails("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyRoomId(null);
    }
  }

  return (
    <Page width="content">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-label uppercase tracking-wide text-brand">Your inbox</p>
          <h1 className="mt-1 text-h1 text-ink">Message requests</h1>
          <p className="mt-2 max-w-2xl text-body text-muted">
            Review messages from people outside your conversations. Declining stops the sender from messaging again; you can undo briefly or accept later.
          </p>
        </div>
        <Link to="/chats" className="text-label text-brand hover:underline">Back to chats</Link>
      </div>

      {error && <p role="alert" className="mb-4 rounded-xl bg-error/10 p-3 text-body text-error">{error}</p>}
      {loading ? <Spinner label="Loading message requests" /> : requests.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface" aria-label="Message requests">
          {requests.map((request) => {
            const remaining = undoRemaining(request, now);
            const busy = busyRoomId === request.room_id;
            return (
              <li key={request.room_id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:p-5">
                <Avatar name={request.sender_name} src={request.sender_avatar} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-h2 text-ink">{request.sender_name}</h2>
                    <span className={`rounded-full px-2.5 py-1 text-metadata ${request.status === "declined" ? "bg-canvas text-muted" : "bg-brand-soft text-brand"}`}>
                      {request.status === "declined" ? "Declined" : "New request"}
                    </span>
                  </div>
                  <p className="mt-1 text-metadata text-muted">
                    {request.status === "declined"
                      ? "They cannot send another message unless you accept."
                      : "Accept to reply, or decline to stop further messages."}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button disabled={busy} onClick={() => void respond(request, "accepted")}>
                      Accept
                    </Button>
                    {request.status === "pending" ? (
                      <Button variant="secondary" disabled={busy} onClick={() => void respond(request, "declined")}>
                        Decline
                      </Button>
                    ) : remaining > 0 ? (
                      <Button variant="secondary" disabled={busy} onClick={() => void respond(request, "undo_decline")}>
                        Undo decline · {Math.ceil(remaining / 1000)}s
                      </Button>
                    ) : null}
                    <Button variant="ghost" disabled={busy} onClick={() => setReportTarget(request)}>
                      Report
                    </Button>
                    <Button variant="ghost" className="text-error" disabled={busy} onClick={() => setBlockTarget(request)}>
                      Block
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title="No message requests" description="Requests from people outside your conversations will appear here." />
      )}

      <Modal open={Boolean(blockTarget)} onClose={() => setBlockTarget(null)} title={`Block ${blockTarget?.sender_name || "this person"}`}>
        <p className="text-body text-muted">They will not be able to send you messages or call you. You can unblock them later in the conversation details.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setBlockTarget(null)}>Cancel</Button>
          <Button className="bg-error" disabled={busyRoomId === blockTarget?.room_id} onClick={() => void confirmBlock()}>Block person</Button>
        </div>
      </Modal>

      <Modal open={Boolean(reportTarget)} onClose={() => setReportTarget(null)} title={`Report ${reportTarget?.sender_name || "person"}`}>
        <form onSubmit={submitReport} className="space-y-4">
          <label className="block text-label text-ink">Reason
            <select value={reportReason} onChange={(event) => setReportReason(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-body">
              <option value="spam">Spam</option>
              <option value="harassment">Harassment</option>
              <option value="inappropriate_content">Inappropriate content</option>
              <option value="impersonation">Impersonation</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="block text-label text-ink">Details (optional)
            <textarea rows={3} maxLength={1000} value={reportDetails} onChange={(event) => setReportDetails(event.target.value)} className="mt-1 w-full rounded-lg border border-line bg-surface p-3 text-body" />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReportTarget(null)}>Cancel</Button>
            <Button type="submit" disabled={busyRoomId === reportTarget?.room_id}>Submit report</Button>
          </div>
        </form>
      </Modal>
    </Page>
  );
}
