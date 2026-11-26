import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useSyncReconciler } from "../../contexts/SyncContext";
export default function ConversationPolicyNotice({ room }) {
  const revision = useRef(0);
  const [seconds, setSeconds] = useState(null);
  async function load() {
    const v = ++revision.current;
    try {
      const data = (await api.get(`/experience/rooms/${room.id}/settings`)).data
        .data;
      if (v === revision.current) setSeconds(data.disappearing_seconds);
    } catch {}
  }
  useEffect(() => {
    setSeconds(null);
    load();
    return () => revision.current++;
  }, [room.id]);
  useSyncReconciler(
    async (batch) => {
      if (
        batch.reset ||
        batch.changes.some((c) => c.kind === "room" && c.room_id === room.id)
      )
        await load();
    },
    [room.id],
  );
  return seconds ? (
    <p
      role="status"
      className="border-b border-line bg-surface px-4 py-2 text-center text-metadata text-muted"
    >
      New messages disappear after {seconds / 86400}{" "}
      {seconds === 86400 ? "day" : "days"}. Downloaded copies may remain.
    </p>
  ) : null;
}
