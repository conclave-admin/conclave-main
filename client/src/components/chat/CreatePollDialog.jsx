import { useEffect, useState } from "react";
import IconClose from "@/assets/icons/close.svg?react";
import IconPlus from "@/assets/icons/plus.svg?react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import { createPoll } from "@/services/polls.service";

// Mirror the server limits in poll.service.js.
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 12;
const MAX_QUESTION = 300;
const MAX_OPTION = 100;

export default function CreatePollDialog({ open, onClose, roomId, onCreated }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuestion("");
    setOptions(["", ""]);
    setAllowMultiple(false);
    setError("");
  }, [open]);

  const filled = options.map((option) => option.trim()).filter(Boolean);
  const hasDuplicates =
    new Set(filled.map((option) => option.toLowerCase())).size !==
    filled.length;
  const canSubmit =
    question.trim() &&
    filled.length >= MIN_OPTIONS &&
    !hasDuplicates &&
    !isSaving;

  const setOption = (index, value) =>
    setOptions((current) =>
      current.map((option, i) => (i === index ? value : option)),
    );

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;

    setIsSaving(true);
    setError("");
    try {
      const message = await createPoll({
        roomId,
        question: question.trim(),
        options: filled,
        allowMultiple,
      });
      onCreated?.(message);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Could not create this poll.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create poll"
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="poll-form"
            disabled={!canSubmit}
          >
            {isSaving ? "Sending…" : "Send poll"}
          </Button>
        </>
      }
    >
      <form
        id="poll-form"
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
      >
        <Input
          id="poll-question"
          label="Question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={MAX_QUESTION}
          placeholder="Ask something"
          required
        />

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-ink">Options</span>
          {options.map((option, index) => (
            <div key={index} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  value={option}
                  onChange={(event) => setOption(index, event.target.value)}
                  maxLength={MAX_OPTION}
                  placeholder={`Option ${index + 1}`}
                  aria-label={`Option ${index + 1}`}
                />
              </div>
              {options.length > MIN_OPTIONS && (
                <button
                  type="button"
                  onClick={() =>
                    setOptions((current) =>
                      current.filter((_, i) => i !== index),
                    )
                  }
                  aria-label={`Remove option ${index + 1}`}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-canvas hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                >
                  <IconClose className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          ))}

          {options.length < MAX_OPTIONS && (
            <button
              type="button"
              onClick={() => setOptions((current) => [...current, ""])}
              className="flex items-center gap-2 self-start rounded-lg px-2 py-1.5 text-label text-brand transition-colors hover:bg-brand-soft"
            >
              <IconPlus className="h-4 w-4" aria-hidden="true" />
              Add option
            </button>
          )}

          {hasDuplicates && (
            <p role="alert" className="text-metadata text-error">
              Two options are the same.
            </p>
          )}
        </div>

        <label className="flex items-center gap-3 text-body text-ink">
          <input
            type="checkbox"
            checked={allowMultiple}
            onChange={(event) => setAllowMultiple(event.target.checked)}
            className="h-4 w-4 accent-brand"
          />
          Allow multiple answers
        </label>

        <p className="text-metadata text-muted">
          Everyone in the room can see who voted for what.
        </p>

        {error && (
          <p role="alert" className="text-metadata text-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
