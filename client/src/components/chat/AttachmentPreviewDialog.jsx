import { useEffect, useRef, useState } from "react";
import IconAudio from "@/assets/icons/audio-file.svg?react";
import IconClose from "@/assets/icons/close.svg?react";
import IconDocument from "@/assets/icons/document.svg?react";
import IconFile from "@/assets/icons/file.svg?react";
import { limitFor } from "@/lib/media";
import {
  compressVideo,
  videoCompressionSupported,
} from "@/lib/videoCompression";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";

/**
 * The full-screen preview a picked file lands in, before anything is uploaded.
 *
 * Picking a file used to start the upload immediately, which meant the file was
 * on its way to Cloudinary before the user had decided to send it, and the
 * message went out the moment the last upload returned. This inverts that: the
 * bytes stay local until Send is pressed, so a file chosen by mistake is
 * discarded with Cancel rather than becoming an orphaned asset, and the caption
 * is written where the file can be seen.
 *
 * Send saves the files and per-item captions to the outbox before closing this
 * dialog. A storage failure leaves the selection here; upload failures are
 * handled by each message bubble after the draft has been saved.
 *
 * Object URLs are made here and revoked when the file list changes or the
 * dialog unmounts. They are never stored anywhere else, so a revoked URL can
 * never find its way onto the wire — `uploadFile` takes the `File` itself.
 *
 * @param {boolean} open
 * @param {File[]} files - the picked files; empty closes the dialog
 * @param {string} initialCaption - the composer's draft at the moment of picking
 * @param {boolean} sending - saving the draft; closing is blocked
 * @param {string} error - shown in place of a status line
 * @param {(captions: string[]) => void} onSend
 * @param {() => void} onCancel
 * @param {(index: number) => void} onRemoveFile - dropping the last one closes
 */
export default function AttachmentPreviewDialog({
  open,
  files,
  initialCaption = "",
  sending = false,
  sendDisabled = false,
  error = "",
  onSend,
  onCancel,
  onRemoveFile,
  onReplaceFile,
}) {
  const [captions, setCaptions] = useState(() => new Map());
  const [activeIndex, setActiveIndex] = useState(0);
  const [urls, setUrls] = useState([]);
  const [compression, setCompression] = useState(null);
  const [compressionError, setCompressionError] = useState("");
  const [compressionNote, setCompressionNote] = useState("");
  const compressionController = useRef(null);
  useEffect(() => () => compressionController.current?.abort(), []);

  // Re-seeded on open rather than on every file change: removing one file from
  // a set of three must not wipe the caption being written alongside them.
  useEffect(() => {
    if (!open) {
      compressionController.current?.abort();
      return;
    }
    setCaptions(
      new Map(
        files.map((file, index) => [file, index === 0 ? initialCaption : ""]),
      ),
    );
    setActiveIndex(0);
  }, [open, initialCaption]);

  useEffect(() => {
    if (!open || files.length === 0) return undefined;
    const next = files.map((file) => URL.createObjectURL(file));
    setUrls(next);
    return () => next.forEach((url) => URL.revokeObjectURL(url));
  }, [open, files]);

  if (!open || files.length === 0) return null;

  const index = Math.min(activeIndex, files.length - 1);
  const active = files[index];
  const isImage = (file) => Boolean(file?.type?.startsWith("image/"));
  const isVideo = (file) => Boolean(file?.type?.startsWith("video/"));
  const Icon =
    active?.type === "application/pdf"
      ? IconDocument
      : active?.type?.startsWith("audio/")
        ? IconAudio
        : IconFile;

  const formatSize = (bytes) => {
    if (!Number.isFinite(bytes)) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const oversized = files.some((file) => file.size > limitFor(file));
  const compress = async () => {
    const controller = new AbortController();
    compressionController.current = controller;
    setCompression({ file: active, progress: 0 });
    setCompressionError("");
    setCompressionNote("");
    try {
      const result = await compressVideo(active, {
        signal: controller.signal,
        onProgress: (progress) => setCompression({ file: active, progress }),
      });
      if (result.compressed) {
        setCaptions((current) => {
          const next = new Map(current);
          next.set(result.file, current.get(active) || "");
          next.delete(active);
          return next;
        });
        onReplaceFile(index, result.file);
        setCompressionNote(
          `Video compressed locally to ${formatSize(result.file.size)}.`,
        );
      } else
        setCompressionError(
          "The original is already smaller than the encoded result. It remains selected.",
        );
    } catch (err) {
      if (err.name !== "AbortError") setCompressionError(err.message);
    } finally {
      setCompression(null);
      compressionController.current = null;
    }
  };
  const submit = (event) => {
    event?.preventDefault();
    if (sendDisabled || sending || compression || oversized) return;
    onSend(files.map((file) => captions.get(file) || ""));
  };

  return (
    <Modal
      open
      onClose={() => {
        compressionController.current?.abort();
        onCancel();
      }}
      closeDisabled={sending}
      fullscreen
      title="Send attachment"
      footer={
        <form onSubmit={submit} className="flex w-full items-end gap-3">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Add a caption</span>
            <textarea
              value={captions.get(active) || ""}
              onChange={(event) =>
                setCaptions((current) => {
                  const next = new Map(current);
                  next.set(active, event.target.value);
                  return next;
                })
              }
              rows={1}
              placeholder="Add a caption…"
              disabled={sending}
              className="block max-h-32 min-h-10 w-full resize-none rounded-lg border border-line bg-surface px-3.5 py-2.5 text-body text-ink outline-none transition-shadow placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/15 disabled:opacity-60"
            />
          </label>
          <Button
            variant="primary"
            type="submit"
            disabled={
              sendDisabled || sending || Boolean(compression) || oversized
            }
            className="shrink-0"
            aria-label={sending ? "Saving messages" : "Send"}
          >
            {sending ? "Saving…" : "Send"}
          </Button>
        </form>
      }
    >
      <div className="flex h-full flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center bg-canvas p-4">
          {isImage(active) && urls[index] ? (
            <img
              src={urls[index]}
              alt={active.name}
              className="max-h-full max-w-full rounded-lg object-contain"
            />
          ) : isVideo(active) && urls[index] ? (
            <video
              key={urls[index]}
              src={urls[index]}
              controls
              playsInline
              className="max-h-full max-w-full rounded-lg"
            />
          ) : active?.type?.startsWith("audio/") && urls[index] ? (
            <audio
              src={urls[index]}
              controls
              className="w-full max-w-md"
              aria-label={active.name}
            />
          ) : (
            <div className="flex max-w-xs flex-col items-center gap-3 text-center">
              <span className="grid h-20 w-20 place-items-center rounded-2xl bg-brand-soft text-brand">
                <Icon className="h-10 w-10" aria-hidden="true" />
              </span>
              <p className="break-words text-body text-ink">{active.name}</p>
              <p className="text-metadata text-muted">
                {formatSize(active.size)}
              </p>
            </div>
          )}
        </div>

        {isVideo(active) && (
          <div className="shrink-0 space-y-2 border-t border-line px-4 py-3 text-metadata">
            <p className="truncate text-ink">{active.name}</p>
            {compressionNote && <p role="status">{compressionNote}</p>}
            <p className="text-muted">
              {formatSize(active.size)} · Send limit 50 MB. Optional compression
              changes video quality and runs locally in real time.
            </p>
            {compression ? (
              <>
                <p role="status">
                  Compressing video {Math.round(compression.progress * 100)}% ·
                  keep this tab open
                </p>
                <progress
                  aria-label="Video compression"
                  max="1"
                  value={compression.progress}
                  className="w-full accent-brand"
                />
                <Button
                  variant="secondary"
                  onClick={() => compressionController.current?.abort()}
                >
                  Cancel compression
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                disabled={sending || !videoCompressionSupported()}
                onClick={compress}
              >
                Compress video
              </Button>
            )}
            {!videoCompressionSupported() && (
              <p className="text-muted">
                Local compression is unavailable here. Trim large clips in your
                device editor.
              </p>
            )}
            {compressionError && (
              <p role="alert" className="text-error">
                {compressionError}
              </p>
            )}
          </div>
        )}
        {oversized && (
          <p
            role="alert"
            className="shrink-0 border-t border-line px-4 py-2 text-metadata text-error"
          >
            A selected file exceeds its send limit. Compress or trim the video,
            or remove the oversized file before sending.
          </p>
        )}
        {files.length === 1 && active?.type?.startsWith("audio/") && (
          <button
            type="button"
            disabled={sending || Boolean(compression)}
            onClick={onCancel}
            className="min-h-11 shrink-0 border-t border-line px-4 text-label text-error"
          >
            Discard voice message
          </button>
        )}
        {files.length > 1 && (
          <div className="scrollbar-none flex shrink-0 gap-2 overflow-x-auto border-t border-line px-4 py-3">
            {files.map((file, i) => (
              <div key={`${file.name}-${i}`} className="relative shrink-0">
                <button
                  type="button"
                  disabled={Boolean(compression)}
                  onClick={() => {
                    setActiveIndex(i);
                    setCompressionError("");
                  }}
                  aria-label={`Preview ${file.name}`}
                  aria-current={i === index}
                  className={`block overflow-hidden rounded-lg border-2 transition-colors ${
                    i === index ? "border-brand" : "border-transparent"
                  }`}
                >
                  {isImage(file) && urls[i] ? (
                    <img
                      src={urls[i]}
                      alt=""
                      className="h-14 w-14 object-cover"
                    />
                  ) : isVideo(file) && urls[i] ? (
                    <video
                      src={urls[i]}
                      muted
                      playsInline
                      preload="metadata"
                      className="h-14 w-14 object-cover"
                    />
                  ) : (
                    <span className="grid h-14 w-14 place-items-center rounded-lg bg-canvas text-muted">
                      <IconFile className="h-6 w-6" aria-hidden="true" />
                    </span>
                  )}
                </button>
                {!sending && !compression && (
                  <button
                    type="button"
                    onClick={() => onRemoveFile(i)}
                    aria-label={`Remove ${file.name}`}
                    className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-ink text-surface transition-colors hover:bg-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                  >
                    <IconClose className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {sending && (
          <p
            role="status"
            className="shrink-0 border-t border-line px-4 py-3 text-metadata text-muted"
          >
            Saving messages on this device…
          </p>
        )}

        {error && (
          <p
            role="alert"
            className="shrink-0 border-t border-line bg-canvas px-4 py-2.5 text-metadata text-error"
          >
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
