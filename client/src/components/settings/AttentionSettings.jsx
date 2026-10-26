import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useSyncReconciler } from "../../contexts/SyncContext";
import Button from "../ui/Button";
import Input from "../ui/Input";
export default function AttentionSettings() {
  const [status, setStatus] = useState(""),
    [dnd, setDnd] = useState("off"),
    [active, setActive] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const dirty = useRef(false),
    revision = useRef(0);
  const [loaded, setLoaded] = useState(false);
  async function load() {
    if (dirty.current) return;
    const v = ++revision.current;
    try {
      const data = (await api.get("/experience/personal-settings")).data.data;
      if (v !== revision.current || dirty.current) return;
      setLoaded(true);
      setStatus(
        new Date(data.status_until) > new Date()
          ? data.custom_status || ""
          : "",
      );
      setActive(data.dnd_until);
      setDnd(new Date(data.dnd_until) > new Date() ? "keep" : "off");
    } catch (e) {
      setError("Could not load your status");
    }
  }
  useEffect(() => {
    load();
    return () => revision.current++;
  }, []);
  useSyncReconciler(
    async (batch) => {
      if (
        !busy &&
        (batch.reset ||
          batch.changes.some(
            (c) => c.kind === "profile" || c.kind === "preferences",
          ))
      )
        await load();
    },
    [busy],
  );
  return (
    <section className="mt-6 space-y-4 rounded-2xl border border-line bg-surface p-5">
      <h2 className="text-h2">Status and focus</h2>
      <p className="text-body text-muted">
        Your status lasts 24 hours. Do not disturb pauses interruptions across
        your devices; messages still arrive.
      </p>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setNotice("");
          try {
            await api.patch("/experience/personal-settings", { status, dnd });
            dirty.current = false;
            await load();
            setNotice("Status and focus saved");
          } catch (e) {
            setError(
              e.response?.data?.message || "Could not save focus settings",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <Input
          label="Custom status"
          maxLength={100}
          value={status}
          disabled={!loaded || busy}
          onChange={(e) => {
            dirty.current = true;
            setStatus(e.target.value);
          }}
          placeholder="What would you like people to know?"
        />
        <label className="block text-label">
          Do not disturb
          <select
            aria-label="Do not disturb"
            className="mt-2 min-h-11 w-full rounded-xl border border-line bg-surface px-3"
            value={dnd}
            disabled={!loaded || busy}
            onChange={(e) => {
              dirty.current = true;
              setDnd(e.target.value);
            }}
          >
            <option value="keep">Keep current setting</option>
            <option value="off">Off</option>
            <option value="hour">For 1 hour</option>
            <option value="day">For 24 hours</option>
          </select>
        </label>
        {active && new Date(active) > new Date() && (
          <p className="text-metadata text-muted">
            Currently paused until {new Date(active).toLocaleString()}
          </p>
        )}
        <Button type="submit" disabled={busy || !loaded}>
          Save status and focus
        </Button>
      </form>
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
