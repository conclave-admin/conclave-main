import { useCallback, useEffect, useMemo, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import Page from "@/components/layout/Page";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Spinner from "@/components/ui/Spinner";
import Textarea from "@/components/ui/Textarea";
import { useAuth } from "@/contexts/AuthContext";
import { useRealtime } from "@/contexts/RealtimeContext";
import { useToast } from "@/contexts/ToastContext";
import { getRoom } from "@/services/rooms.service";
import { cancelRoomEvent, createRoomEvent, listRoomEvents, respondToRoomEvent, updateRoomEvent } from "@/services/roomEvents.service";

const toLocalInput = (date) => {
  const value = new Date(date);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

const formatTime = (event) => new Intl.DateTimeFormat(undefined, {
  dateStyle: "full", timeStyle: "short", timeZone: event.timezone,
}).format(new Date(event.starts_at));

export default function RoomEvents() {
  const { roomId } = useParams();
  const { setRoomHeader } = useOutletContext();
  const { user } = useAuth();
  const { socket } = useRealtime();
  const { toast } = useToast();
  const [room, setRoom] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ title: "", description: "", startsAt: "", endsAt: "", reminder: "15" });

  const reload = useCallback(async () => {
    const [roomInfo, rows] = await Promise.all([getRoom(roomId), listRoomEvents(roomId)]);
    setRoom(roomInfo);
    setEvents(rows);
  }, [roomId]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    reload().catch((error) => toast({ title: "Could not load room events", description: error.response?.data?.message, tone: "error" }))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [reload, toast]);
  useEffect(() => {
    setRoomHeader("Room events");
    return () => setRoomHeader(null);
  }, [setRoomHeader]);
  useEffect(() => {
    if (!socket) return undefined;
    const changed = (payload) => { if (payload?.roomId === roomId) reload().catch(() => {}); };
    socket.on("room:event", changed);
    return () => socket.off("room:event", changed);
  }, [socket, roomId, reload]);

  const me = useMemo(() => room?.members?.find((member) => member.id === user?.id), [room, user]);
  const canCreate = Boolean(me);
  async function submit(event) {
    event.preventDefault();
    if (!form.startsAt) return;
    setSaving(true);
    try {
      const starts = new Date(form.startsAt);
      const reminderAt = form.reminder === "none" ? null : new Date(starts.getTime() - Number(form.reminder) * 60000).toISOString();
      if (reminderAt && new Date(reminderAt) <= new Date()) throw new Error("Choose a start time far enough in the future for its reminder.");
      const payload = {
        title: form.title,
        description: form.description,
        startsAt: starts.toISOString(),
        endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        reminderAt,
      };
      if (editingId) await updateRoomEvent(roomId, editingId, payload);
      else await createRoomEvent(roomId, payload);
      const wasEditing = Boolean(editingId);
      setEditingId(null);
      setForm({ title: "", description: "", startsAt: "", endsAt: "", reminder: "15" });
      await reload();
      toast({ title: wasEditing ? "Event updated" : "Event scheduled", tone: "success" });
    } catch (error) {
      toast({ title: "Could not schedule event", description: error.response?.data?.message || error.message, tone: "error" });
    } finally { setSaving(false); }
  }
  async function respond(item, response) {
    try { await respondToRoomEvent(roomId, item.id, response); await reload(); }
    catch (error) { toast({ title: "RSVP could not be saved", description: error.response?.data?.message, tone: "error" }); }
  }
  async function cancel(item) {
    try { await cancelRoomEvent(roomId, item.id); await reload(); toast({ title: "Event cancelled", tone: "success" }); }
    catch (error) { toast({ title: "Could not cancel event", description: error.response?.data?.message, tone: "error" }); }
  }
  function edit(item) {
    const reminderMinutes = item.reminder_at
      ? Math.max(1, Math.round((new Date(item.starts_at) - new Date(item.reminder_at)) / 60000))
      : null;
    setEditingId(item.id);
    setForm({
      title: item.title,
      description: item.description || "",
      startsAt: toLocalInput(item.starts_at),
      endsAt: item.ends_at ? toLocalInput(item.ends_at) : "",
      reminder: reminderMinutes === null ? "none" : String([15, 60, 1440].reduce((closest, value) => Math.abs(value - reminderMinutes) < Math.abs(closest - reminderMinutes) ? value : closest, 15)),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (loading) return <Spinner label="Loading events" />;
  const roomTitle = room?.display_name || room?.name || "Conversation";
  return <Page width="content">
    <header className="mb-6"><p className="text-metadata text-muted">{roomTitle}</p><h1 className="mt-1 text-h1 text-ink">Events</h1><p className="mt-2 text-body text-muted">Plan a time together and let people share whether they can make it.</p></header>
    {canCreate && <form onSubmit={submit} className="mb-8 space-y-3 rounded-2xl border border-line bg-surface p-4 md:p-5">
      <div className="flex items-center justify-between gap-3"><h2 className="text-h2 text-ink">{editingId ? "Edit event" : "Schedule an event"}</h2>{editingId && <button type="button" onClick={() => { setEditingId(null); setForm({ title: "", description: "", startsAt: "", endsAt: "", reminder: "15" }); }} className="text-label text-muted hover:text-ink">Stop editing</button>}</div>
      <Input label="Event name" required maxLength={140} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      <Textarea label="Details" maxLength={5000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      <div className="grid gap-3 md:grid-cols-2"><Input label="Starts" type="datetime-local" required value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /><Input label="Ends (optional)" type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></div>
      <label className="grid gap-1 text-label text-ink">Reminder
        <select value={form.reminder} onChange={(e) => setForm({ ...form, reminder: e.target.value })} className="min-h-11 rounded-lg border border-line bg-surface px-3 text-body"><option value="15">15 minutes before</option><option value="60">1 hour before</option><option value="1440">1 day before</option><option value="none">No reminder</option></select>
      </label>
      <p className="text-metadata text-muted">Times use your device time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"}).</p>
      <Button type="submit" disabled={saving || !form.title.trim() || !form.startsAt}>{saving ? "Saving…" : editingId ? "Save changes" : "Schedule event"}</Button>
    </form>}
    {events.length === 0 ? <div className="rounded-2xl border border-dashed border-line p-8 text-center"><h2 className="text-h2 text-ink">Nothing planned yet</h2><p className="mt-2 text-body text-muted">Room events will appear here.</p></div> : <div className="space-y-3">{events.map((item) => {
      const canManage = item.created_by === user?.id || me?.role === "admin";
      return <article key={item.id} className="rounded-2xl border border-line bg-surface p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="text-h2 text-ink">{item.title}</h2><p className="mt-1 text-body text-brand">{formatTime(item)}</p><p className="mt-1 text-metadata text-muted">Organized by {item.organizer_name}</p></div>{canManage && <div className="flex gap-2"><button type="button" onClick={() => edit(item)} className="rounded-lg px-3 py-2 text-label text-brand hover:bg-brand-soft">Edit</button><button type="button" onClick={() => cancel(item)} className="rounded-lg px-3 py-2 text-label text-error hover:bg-error/10">Cancel event</button></div>}</div>
        {item.description && <p className="mt-3 whitespace-pre-wrap text-body text-ink">{item.description}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-2"><span className="mr-1 text-metadata text-muted">{item.yes_count} going · {item.maybe_count} maybe · {item.no_count} can't go</span>{[["yes","Going"],["maybe","Maybe"],["no","Can't go"]].map(([key,label]) => <button key={key} type="button" onClick={() => respond(item,key)} aria-pressed={item.my_response===key} className={`rounded-full border px-3 py-1.5 text-label ${item.my_response===key ? "border-brand bg-brand-soft text-brand" : "border-line text-muted hover:bg-canvas"}`}>{label}</button>)}</div>
      </article>;
    })}</div>}
  </Page>;
}
