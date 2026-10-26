import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useSyncReconciler } from "../../contexts/SyncContext";
import Button from "../ui/Button";
export default function AdvancedConversationSettings({ room }) {
  const [settings, setSettings] = useState(null),
    [level, setLevel] = useState("all"),
    [mute, setMute] = useState("off"),
    [lifetime, setLifetime] = useState("off"),
    [policy, setPolicy] = useState([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const revision = useRef(0),
    mutating = useRef(false),
    dirty = useRef(false);
  async function load() {
    if (mutating.current || dirty.current) return;
    const v = ++revision.current;
    try {
      const [s, p] = await Promise.all([
        api.get(`/experience/rooms/${room.id}/settings`),
        api.get(`/experience/rooms/${room.id}/policy`),
      ]);
      if (v !== revision.current || dirty.current) return;
      setSettings(s.data.data);
      setLevel(s.data.data.notification_level);
      setLifetime(
        s.data.data.disappearing_seconds
          ? String(s.data.data.disappearing_seconds)
          : "off",
      );
      setMute(
        s.data.data.muted
          ? "forever"
          : s.data.data.mute_until &&
              new Date(s.data.data.mute_until) > new Date()
            ? "active"
            : "off",
      );
      setPolicy(p.data.data);
    } catch (e) {
      if (v === revision.current)
        setError(
          e.response?.data?.message || "Could not load conversation settings",
        );
    }
  }
  useEffect(() => {
    load();
    return () => revision.current++;
  }, [room.id]);
  useSyncReconciler(
    async (batch) => {
      if (batch.reset || batch.changes.some((c) => c.room_id === room.id))
        await load();
    },
    [room.id],
  );
  async function save(work) {
    mutating.current = true;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await work();
      dirty.current = false;
      setNotice("Saved");
    } catch (e) {
      setError(e.response?.data?.message || "Could not save settings");
    } finally {
      mutating.current = false;
      setBusy(false);
      await load();
    }
  }
  return (
    <section className="mt-6 space-y-5 rounded-2xl border border-line bg-surface p-5">
      <h2 className="text-h2">Conversation preferences</h2>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save(() =>
            api.patch(`/experience/rooms/${room.id}/notifications`, {
              level,
              mute: mute === "active" ? "keep" : mute,
            }),
          );
        }}
      >
        <label className="block text-label">
          Notify me
          <select
            aria-label="Notify me"
            disabled={busy || !settings}
            className="mt-2 min-h-11 w-full rounded-xl border border-line bg-surface px-3"
            value={level}
            onChange={(e) => {
              dirty.current = true;
              setLevel(e.target.value);
            }}
          >
            <option value="all">All messages</option>
            <option value="mentions">Mentions only</option>
            <option value="none">No interruptions</option>
          </select>
        </label>
        <label className="block text-label">
          Mute duration
          <select
            aria-label="Mute duration"
            disabled={busy || !settings}
            className="mt-2 min-h-11 w-full rounded-xl border border-line bg-surface px-3"
            value={mute}
            onChange={(e) => {
              dirty.current = true;
              setMute(e.target.value);
            }}
          >
            {mute === "active" && (
              <option value="active">
                Currently muted until{" "}
                {new Date(settings.mute_until).toLocaleString()} — choose a new
                duration
              </option>
            )}
            <option value="off">Not muted</option>
            <option value="hour">1 hour</option>
            <option value="day">24 hours</option>
            <option value="week">7 days</option>
            <option value="forever">Until I unmute</option>
          </select>
        </label>
        <p className="text-metadata text-muted">
          Global notification permissions and Do not disturb still apply. Only
          admins can use @here or @channel to notify a room.
        </p>
        <Button type="submit" disabled={busy || !settings}>
          Save notifications
        </Button>
      </form>
      <form
        className="space-y-3 border-t border-line pt-5"
        onSubmit={(e) => {
          e.preventDefault();
          save(() =>
            api.patch(`/experience/rooms/${room.id}/retention`, {
              seconds: lifetime === "off" ? null : Number(lifetime),
            }),
          );
        }}
      >
        <h3 className="text-label">Disappearing messages</h3>
        <p className="text-body text-muted">
          Applies to new messages from the moment they are sent. Existing timers
          do not change. Expired messages become unavailable; downloaded copies
          cannot be recalled. Either person may change a DM timer; only admins
          may change a group timer.
        </p>
        <select
          aria-label="Message expiry"
          disabled={room.type !== "dm" && room.my_role !== "admin"}
          className="min-h-11 w-full rounded-xl border border-line bg-surface px-3"
          value={lifetime}
          onChange={(e) => {
            dirty.current = true;
            setLifetime(e.target.value);
          }}
        >
          <option value="off">Off</option>
          <option value="86400">24 hours</option>
          <option value="604800">7 days</option>
          <option value="7776000">90 days</option>
        </select>
        <Button
          type="submit"
          disabled={
            busy ||
            !settings ||
            (room.type !== "dm" && room.my_role !== "admin")
          }
        >
          Save message timer
        </Button>
      </form>
      {policy.length > 0 && (
        <details>
          <summary className="min-h-9 cursor-pointer text-label text-muted">
            Timer changes
          </summary>
          <ul className="space-y-2 text-metadata text-muted">
            {policy.map((event) => (
              <li key={event.id}>
                {event.display_name || "A member"} set{" "}
                {event.seconds
                  ? `${event.seconds / 86400} day expiry`
                  : "expiry off"}{" "}
                · {new Date(event.created_at).toLocaleString()}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-success">
          {notice}
        </p>
      )}
    </section>
  );
}
