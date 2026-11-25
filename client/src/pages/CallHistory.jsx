import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Page from "@/components/layout/Page";
import Avatar from "@/components/ui/Avatar";
import Spinner from "@/components/ui/Spinner";
import { useToast } from "@/contexts/ToastContext";
import { useAuth } from "@/contexts/AuthContext";
import { useCalls } from "@/contexts/CallContext";
import { listCallHistory } from "@/services/calls.service";
import IconCall from "@/assets/icons/call.svg?react";
import IconVideo from "@/assets/icons/video.svg?react";
import { CALLS_ENABLED } from "@/lib/features";

function outcome(call, userId) {
  if (call.status === "missed") return call.caller_id === userId ? "No answer" : "Missed call";
  if (call.status === "declined") return call.caller_id === userId ? "Declined" : "Declined call";
  if (call.status === "cancelled") return "Cancelled";
  if (call.status === "failed") return "Call failed";
  return call.caller_id === userId ? "Outgoing call" : "Incoming call";
}

function CallsComingSoon() {
  return (
    <Page width="form" className="py-8 sm:py-12">
      <section className="overflow-hidden rounded-3xl border border-line bg-surface shadow-sm">
        <div className="bg-gradient-to-br from-brand-soft via-surface to-canvas px-6 py-10 text-center sm:px-10">
          <div className="mx-auto flex h-16 w-16 items-center justify-center gap-2 rounded-2xl border border-brand/15 bg-surface text-brand shadow-sm">
            <IconCall className="h-6 w-6" aria-hidden="true" />
            <IconVideo className="h-6 w-6" aria-hidden="true" />
          </div>
          <p className="mt-6 text-metadata font-semibold uppercase tracking-[0.14em] text-brand">Coming soon</p>
          <h1 className="mt-2 text-h1 text-ink">Calls are on their way</h1>
          <p className="mx-auto mt-3 max-w-md text-body leading-6 text-muted">
            Voice and video calls, along with call history, will be available in a future Conclave release. Your conversations are ready whenever you are.
          </p>
          <Link to="/chats" className="mt-7 inline-flex min-h-11 items-center justify-center rounded-xl bg-brand px-5 text-label font-semibold text-white transition-colors hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2">
            Back to chats
          </Link>
        </div>
      </section>
    </Page>
  );
}

function CallHistoryEnabled() {
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const { startCall } = useCalls();
  const { toast } = useToast();
  const { user } = useAuth();
  const refresh = useCallback(() => {
    let active = true;
    listCallHistory()
      .then((items) => active && setCalls(items))
      .catch((error) => active && toast({ title: "Call history unavailable", description: error.response?.data?.message || "Try again shortly.", tone: "error" }))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [toast]);

  useEffect(() => {
    const dispose = refresh();
    window.addEventListener("conclave:calls-changed", refresh);
    return () => {
      dispose?.();
      window.removeEventListener("conclave:calls-changed", refresh);
    };
  }, [refresh]);

  if (loading) return <Spinner fullPage label="Loading call history" />;
  return (
    <Page width="form" className="py-6">
      <h1 className="text-h1 text-ink">Calls</h1>
      <p className="mt-1 text-body text-muted">Voice and video calls from your conversations.</p>
      {!calls.length ? (
        <div className="mt-6 rounded-2xl border border-line bg-surface p-6 text-center">
          <p className="text-label font-semibold text-ink">No calls yet</p>
          <p className="mt-1 text-body text-muted">Calls with people in your conversations will appear here.</p>
        </div>
      ) : (
        <ul className="mt-5 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {calls.map((call) => {
            const seconds = call.answered_at && call.ended_at ? Math.max(0, Math.floor((new Date(call.ended_at) - new Date(call.answered_at)) / 1000)) : 0;
            const peers = call.peers || [];
            const title = call.room_type === "group" ? call.room_name || "Group conversation" : peers[0]?.display_name || "Conclave member";
            return (
              <li key={call.id} className="flex items-center gap-3 p-4">
                <Avatar name={title} src={peers[0]?.avatar_url} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-label font-semibold text-ink">{title}</p>
                  <p className="mt-0.5 text-metadata text-muted">{outcome(call, user?.id)} · {new Date(call.started_at).toLocaleString()}</p>
                  <p className="text-metadata text-muted">{call.call_type === "video" ? "Video call" : "Voice call"}</p>
                  {seconds > 0 && <p className="mt-0.5 text-metadata text-muted">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</p>}
                </div>
                <Link to={`/chats/${call.room_id}`} className="rounded-lg border border-line px-3 py-2 text-label text-ink hover:bg-canvas">Open chat</Link>
                <button type="button" onClick={() => startCall(call.room_id, peers[0], call.call_type)} aria-label={`${call.call_type === "video" ? "Video call" : "Call"} ${title}`} className="grid h-11 w-11 place-items-center rounded-full bg-brand-soft text-brand hover:bg-brand/15">
                  {call.call_type === "video" ? <IconVideo className="h-5 w-5" aria-hidden="true" /> : <IconCall className="h-5 w-5" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}

export default function CallHistory() {
  return CALLS_ENABLED ? <CallHistoryEnabled /> : <CallsComingSoon />;
}
