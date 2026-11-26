import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import Textarea from "@/components/ui/Textarea";
import { promoteToDecision } from "@/services/decisions.service";

/**
 * Promote a message to a decision.
 *
 * The message body is prefilled into the body field, because most promotions
 * are a restatement of what was already said — and an empty body field would
 * make the reader retype it. The title has no prefill: a decision titled with
 * the first twelve words of a message is a decision nobody can find again, and
 * a title worth searching for is the one thing the flow genuinely needs from a
 * person.
 *
 * Tags are optional and typed as comma-separated words, which the server
 * lowercases and stores. There is no tag autocomplete because there is no
 * endpoint listing a room's existing tags — offering suggestions that do not
 * exist would be worse than none.
 */
export default function PromoteToDecisionDialog({
  open,
  onClose,
  message,
  roomId,
  rooms = [],
  onPromoted,
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [selectedRoomId, setSelectedRoomId] = useState(roomId || "");
  const [clientId, setClientId] = useState("");
  const [hydratedKey, setHydratedKey] = useState("");

  // Opened from the attach menu rather than from a message: there is no source
  // message, so the body starts empty and the endpoint gets no sourceMessageId.
  // Only the copy changes — the request is identical either way.
  const manual = Boolean(message?.manual);
  const draftKey = `decision-draft:${manual ? `new:${roomId || "board"}` : `message:${message?.id || "none"}`}`;

  // Reset whenever the dialog opens on a different message, so a cancelled
  // promotion cannot leave its draft sitting in the next one.
  useEffect(() => {
    if (!open) return;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(draftKey) || "null"); } catch { /* fresh form */ }
    setTitle(saved?.title || "");
    setBody(saved?.body ?? message?.content ?? "");
    setTags(saved?.tags || "");
    setClientId(saved?.clientId || crypto.randomUUID());
    setHydratedKey(draftKey);
    setError("");
    setSelectedRoomId(saved?.selectedRoomId || roomId || rooms[0]?.id || "");
  }, [open, message, roomId, draftKey]);
  useEffect(() => {
    if (!open || !clientId || hydratedKey !== draftKey) return;
    sessionStorage.setItem(draftKey, JSON.stringify({ title, body, tags, selectedRoomId, clientId }));
  }, [open, draftKey, hydratedKey, title, body, tags, selectedRoomId, clientId]);
  useEffect(() => {
    if (open && !selectedRoomId && rooms[0]?.id)
      setSelectedRoomId(rooms[0].id);
  }, [open, selectedRoomId, rooms]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (isSaving || !selectedRoomId || !title.trim() || !body.trim()) return;

    setIsSaving(true);
    setError("");
    try {
      const decision = await promoteToDecision({
        roomId: selectedRoomId,
        sourceMessageId: message?.id,
        title: title.trim(),
        body: body.trim(),
        tags: tags
          .split(",")
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean),
        clientId,
      });
      sessionStorage.removeItem(draftKey);
      onPromoted?.(decision);
      onClose();
    } catch (err) {
      setError(
        err.response?.data?.message ||
          (manual
            ? "Could not create this decision."
            : "Could not promote this message."),
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => !isSaving && onClose()}
      title={manual ? "New decision" : "Promote to decision"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} type="button" disabled={isSaving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="promote-form"
            disabled={!selectedRoomId || !title.trim() || !body.trim() || isSaving}
          >
            {isSaving
              ? manual
                ? "Saving…"
                : "Promoting…"
              : manual
                ? "Create decision"
                : "Promote"}
          </Button>
        </>
      }
    >
      <form
        id="promote-form"
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
      >
        <p className="text-body text-muted">
          Record a choice the conversation has already made. Room members will see who recorded it and any later corrections.
        </p>
        {manual && rooms.length > 0 && (
          <label className="text-label text-ink">
            Conversation
            <select
              value={selectedRoomId}
              onChange={(event) => setSelectedRoomId(event.target.value)}
              className="mt-2 min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-body"
              required
            >
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.display_name || room.name || "Conversation"}
                </option>
              ))}
            </select>
          </label>
        )}
        {message?.content && (
          <blockquote className="rounded-lg border-l-2 border-line bg-canvas px-3 py-2 text-metadata text-muted [overflow-wrap:anywhere]">
            {message.content}
          </blockquote>
        )}

        <Input
          id="promote-title"
          label="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What was decided"
          maxLength={140}
          required
        />

        <Textarea
          id="promote-body"
          label="Body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={5}
          maxRows={12}
          placeholder="Why, and what it means"
          maxLength={10000}
          required
        />

        <Input
          id="promote-tags"
          label="Tags (optional)"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder="upload, limits"
        />

        {error && (
          <p role="alert" className="text-metadata text-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
