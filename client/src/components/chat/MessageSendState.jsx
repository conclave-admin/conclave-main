import { useState } from "react";
import { useToast } from "@/contexts/ToastContext";

export default function MessageSendState({
  message,
  onRetry,
  onCancel,
  compact = false,
}) {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const state = message._outbox;
  if (!state) return null;
  const filename = message.attachments?.[0]?.filename || "message";
  const percent = Math.min(100, Math.round(state.progress * 100));
  const label =
    state.state === "uploading"
      ? `Uploading ${percent}%`
      : state.state === "awaiting_ack"
        ? "Confirming send…"
        : state.state === "failed"
          ? "Not sent"
          : state.retryAt
            ? "Waiting to retry…"
            : "Waiting to send…";
  const act = async (action) => {
    setBusy(true);
    try {
      await action(state.key);
    } catch (error) {
      toast({
        title: "Could not update this message",
        description: error.message,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };
  if (compact)
    return (
      <div
        data-outbox-state={state.state}
        className="media-transfer-overlay absolute inset-0 z-[3] flex flex-col items-center justify-center gap-2 rounded-lg bg-black/15 text-white"
      >
        {state.state === "uploading" && (
          <progress
            aria-label={`Uploading ${filename}`}
            value={percent}
            max="100"
            className="sr-only"
          />
        )}
        <div
          className="grid h-14 w-14 place-items-center rounded-full p-1 shadow-lg"
          style={{
            background:
              state.state === "uploading"
                ? `conic-gradient(rgb(var(--color-brand)) ${percent}%, rgb(255 255 255 / .35) 0)`
                : "rgb(0 0 0 / .55)",
          }}
        >
          {state.state === "failed" || state.retryAt > 0 ? (
            <button
              type="button"
              disabled={busy}
              aria-label={`Retry ${filename}`}
              onClick={() => act(onRetry)}
              className="grid h-12 w-12 place-items-center rounded-full bg-black/50 text-2xl focus-visible:ring-2 focus-visible:ring-white"
            >
              ↻
            </button>
          ) : state.canCancel ? (
            <button
              type="button"
              disabled={busy}
              aria-label={`Cancel upload ${filename}`}
              onClick={() => act(onCancel)}
              className="grid h-12 w-12 place-items-center rounded-full bg-black/50 text-2xl focus-visible:ring-2 focus-visible:ring-white"
            >
              ×
            </button>
          ) : (
            <span className="text-xl" aria-hidden="true">
              ◷
            </span>
          )}
        </div>
        <span
          role="status"
          className="max-w-[90%] rounded-full bg-black/65 px-2.5 py-1 text-[11px]"
        >
          {label}
        </span>
        {state.error && (
          <span
            role="alert"
            title={state.error}
            className="max-w-[90%] truncate rounded bg-black/70 px-2 text-[11px]"
          >
            {state.error}
          </span>
        )}
        {state.canCancel && (state.state === "failed" || state.retryAt > 0) && (
          <button
            type="button"
            disabled={busy}
            aria-label={`Cancel upload ${filename}`}
            onClick={() => act(onCancel)}
            className="rounded-full bg-black/65 px-3 py-1 text-metadata"
          >
            Cancel
          </button>
        )}
      </div>
    );
  return (
    <div
      data-outbox-state={state.state}
      className="w-full max-w-xs rounded-lg border border-line bg-surface px-3 py-2 text-metadata text-ink"
    >
      <p role="status">{label}</p>
      {state.state === "uploading" && (
        <progress
          aria-label={`Uploading ${filename}`}
          value={percent}
          max="100"
          className="mt-1 h-1.5 w-full accent-brand"
        />
      )}
      {state.error && (
        <p className="mt-1 break-words text-error">
          {state.error}
          {state.state === "queued" ? " Retrying automatically." : ""}
        </p>
      )}
      <div className="mt-1 flex gap-4">
        {(state.state === "failed" || state.retryAt > 0) && (
          <button
            type="button"
            disabled={busy}
            aria-label={`Retry ${filename}`}
            onClick={() => act(onRetry)}
            className="font-medium text-brand hover:underline disabled:opacity-50"
          >
            Retry
          </button>
        )}
        {state.canCancel && (
          <button
            type="button"
            disabled={busy}
            aria-label={`Cancel ${state.media ? "upload" : "message"} ${filename}`}
            onClick={() => act(onCancel)}
            className="text-muted hover:underline disabled:opacity-50"
          >
            {state.media ? "Cancel upload" : "Cancel message"}
          </button>
        )}
      </div>
    </div>
  );
}
