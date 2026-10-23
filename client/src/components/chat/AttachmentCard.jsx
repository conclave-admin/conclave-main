import IconAudio from "@/assets/icons/audio-file.svg?react";
import IconDocument from "@/assets/icons/document.svg?react";
import IconDownload from "@/assets/icons/download.svg?react";
import IconFile from "@/assets/icons/file.svg?react";
import IconImage from "@/assets/icons/image.svg?react";
import IconSpreadsheet from "@/assets/icons/spreadsheet.svg?react";
import { useEffect, useRef, useState } from "react";
import { useMediaViewer } from "./MediaViewer";
import Modal from "@/components/ui/Modal";
import useAttachmentDownload from "@/hooks/useAttachmentDownload";
import useAttachmentImage from "@/hooks/useAttachmentImage";
import { saveAttachmentToDevice } from "@/services/attachments.service";

function formatSize(bytes) {
  if (typeof bytes !== "number" || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function iconFor(mimeType = "") {
  if (mimeType.startsWith("image/")) return IconImage;
  if (mimeType.startsWith("audio/")) return IconAudio;
  if (mimeType.startsWith("video/")) return IconFile;
  if (mimeType.includes("sheet") || mimeType.includes("excel"))
    return IconSpreadsheet;
  if (
    mimeType.startsWith("text/") ||
    mimeType.includes("pdf") ||
    mimeType.includes("document")
  ) {
    return IconDocument;
  }
  return IconFile;
}

function useObjectUrl(blob) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return undefined;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

function DownloadState({ download, attachment }) {
  const { status, progress, persisted, error, start, cancel } = download;
  return (
    <div
      data-download-state={status}
      className="min-w-0 text-metadata text-muted"
    >
      <p role="status">
        {status === "downloading"
          ? `Downloading ${Math.round(progress * 100)}%`
          : status === "downloaded"
            ? persisted
              ? "Downloaded · available offline"
              : "Available this visit · could not save offline"
            : status === "failed"
              ? "Download failed"
              : "Original not downloaded"}
      </p>
      {status === "downloading" && (
        <>
          <progress
            aria-label={`Downloading ${attachment.filename}`}
            max="1"
            value={progress}
            className="mt-1 w-full accent-brand"
          />
          <button
            type="button"
            onClick={cancel}
            className="mt-1 text-brand hover:underline"
            aria-label={`Cancel download ${attachment.filename}`}
          >
            Cancel download
          </button>
        </>
      )}
      {status === "failed" && (
        <>
          <p role="alert" className="break-words text-error">
            {error}
          </p>
          <button
            type="button"
            onClick={start}
            className="mt-1 text-brand hover:underline"
            aria-label={`Retry download ${attachment.filename}`}
          >
            Retry download
          </button>
        </>
      )}
    </div>
  );
}

function AudioAttachment({ attachment }) {
  const download = useAttachmentDownload(attachment);
  const src = useObjectUrl(download.blob);
  const player = useRef(null);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState("");
  const [duration, setDuration] = useState(null);
  const probing = useRef(false);
  const probeTimer = useRef(null);
  useEffect(() => () => clearTimeout(probeTimer.current), [src]);
  useEffect(() => {
    setError("");
    setDuration(null);
    probing.current = false;
  }, [src]);
  useEffect(() => {
    if (player.current) player.current.playbackRate = speed;
  }, [speed, src]);
  useEffect(() => {
    const audio = player.current;
    const pause = () => audio?.pause();
    const another = (event) => {
      if (event.detail !== audio) pause();
    };
    window.addEventListener("conclave:voice-playing", another);
    window.addEventListener("conclave:session-ended", pause);
    window.addEventListener("conclave:outbox-stop", pause);
    return () => {
      pause();
      window.removeEventListener("conclave:voice-playing", another);
      window.removeEventListener("conclave:session-ended", pause);
      window.removeEventListener("conclave:outbox-stop", pause);
    };
  }, [src]);
  const metadata = () => {
    const audio = player.current;
    if (Number.isFinite(audio?.duration) && audio.duration > 0) {
      setDuration(audio.duration);
      if (probing.current) {
        probing.current = false;
        clearTimeout(probeTimer.current);
        audio.currentTime = 0;
      }
    }
  };
  const loaded = () => {
    metadata();
    // Chromium can report Infinity for MediaRecorder WebM until the end is
    // inspected. This seeks only the already downloaded local Blob.
    if (player.current?.duration === Infinity) {
      probing.current = true;
      player.current.currentTime = 1e10;
      probeTimer.current = setTimeout(() => {
        probing.current = false;
        if (player.current) player.current.currentTime = 0;
      }, 2000);
    }
  };
  return (
    <section
      aria-label="Voice message"
      className="w-full min-w-0 max-w-sm space-y-2 rounded-lg border border-line bg-canvas p-3"
    >
      <p className="truncate text-label text-ink">
        {attachment.filename || "Voice message"}
      </p>
      {src ? (
        <>
          <audio
            ref={player}
            src={src}
            controls
            preload="metadata"
            aria-label={`Play ${attachment.filename || "voice message"}`}
            className="block h-11 w-full min-w-0 max-w-full"
            onLoadedMetadata={loaded}
            onDurationChange={metadata}
            onTimeUpdate={metadata}
            onPlay={() =>
              window.dispatchEvent(
                new CustomEvent("conclave:voice-playing", {
                  detail: player.current,
                }),
              )
            }
            onError={() =>
              setError(
                "This browser could not play the recording. You can save it and try another player.",
              )
            }
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-metadata text-muted">
              {duration
                ? `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")}`
                : "Duration available in player"}
            </span>
            <label className="text-metadata text-ink">
              Playback speed{" "}
              <select
                aria-label="Voice message playback speed"
                value={speed}
                className="min-h-11 rounded border border-line bg-surface px-2"
                onChange={(event) => setSpeed(Number(event.target.value))}
              >
                {[1, 1.25, 1.5, 2].map((value) => (
                  <option key={value} value={value}>
                    {value}×
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            className="min-h-11 text-label text-brand"
            onClick={() => saveAttachmentToDevice(attachment, download.blob)}
          >
            Save audio
          </button>
        </>
      ) : (
        <button
          type="button"
          className="min-h-11 text-label text-brand"
          disabled={
            download.checking ||
            download.status === "downloading" ||
            !(attachment.id || attachment.local_blob)
          }
          onClick={() => download.start()}
        >
          Download voice message · {formatSize(attachment.size)}
        </button>
      )}
      {error && (
        <p role="alert" className="text-metadata text-error">
          {error}
        </p>
      )}
      <DownloadState download={download} attachment={attachment} />
    </section>
  );
}

function FileAttachment({ attachment }) {
  return attachment.mime_type?.startsWith("audio/") ? (
    <AudioAttachment attachment={attachment} />
  ) : (
    <DocumentAttachment attachment={attachment} />
  );
}

function DocumentAttachment({ attachment }) {
  const Icon = iconFor(attachment.mime_type);
  const download = useAttachmentDownload(attachment);
  const save = async () => {
    const blob = await download.start();
    if (blob) saveAttachmentToDevice(attachment, blob);
  };
  return (
    <div className="w-full max-w-sm rounded-lg border border-line bg-canvas px-3 py-2.5">
      <button
        type="button"
        onClick={save}
        disabled={
          download.status === "downloading" ||
          !(attachment.id || attachment.local_blob)
        }
        aria-label={`Download ${attachment.filename}`}
        className="group flex w-full items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-70"
      >
        <Icon className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body text-ink">
            {attachment.filename || "Attachment"}
          </span>
          <span className="block text-metadata text-muted">
            {formatSize(attachment.size)}
          </span>
        </span>
        <IconDownload
          className="h-4 w-4 shrink-0 text-brand"
          aria-hidden="true"
        />
      </button>
      <div className="mt-2">
        <DownloadState download={download} attachment={attachment} />
      </div>
    </div>
  );
}

function mediaStyle(attachment, tile, fallback = "4 / 3") {
  const ratio =
    attachment.width && attachment.height
      ? attachment.width / attachment.height
      : 4 / 3;
  return {
    maxWidth: tile ? undefined : `${Math.min(320, 320 * ratio)}px`,
    aspectRatio: tile
      ? "1 / 1"
      : attachment.width && attachment.height
        ? `${attachment.width} / ${attachment.height}`
        : fallback,
    maxHeight: tile ? undefined : "20rem",
  };
}

function ImageAttachment({ attachment, tile = false }) {
  const viewer = useMediaViewer();
  const preview = useAttachmentImage(attachment);
  const download = useAttachmentDownload(attachment);
  const originalSrc = useObjectUrl(download.blob);
  const [open, setOpen] = useState(false);
  const [originalFailed, setOriginalFailed] = useState(false);
  useEffect(() => setOriginalFailed(false), [download.blob]);
  const displaySrc = (originalFailed ? null : originalSrc) || preview.src;
  const imageError = () => {
    if (originalSrc && !originalFailed) setOriginalFailed(true);
    else preview.fail();
  };
  const openOriginal = () => {
    if (viewer) viewer.open(attachment);
    else {
      setOpen(true);
      download.start();
    }
  };
  const save = async () => {
    const blob = await download.start();
    if (blob) saveAttachmentToDevice(attachment, blob);
  };
  return (
    <div className="w-full min-w-0 max-w-xs">
      <button
        type="button"
        onClick={openOriginal}
        aria-label={`Open ${attachment.filename}`}
        style={mediaStyle(attachment, tile)}
        className={`relative block w-full overflow-hidden bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${tile ? "" : "rounded-xl"}`}
      >
        {displaySrc ? (
          <img
            src={displaySrc}
            alt={attachment.filename}
            onError={imageError}
            width={attachment.width || undefined}
            height={attachment.height || undefined}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center bg-line p-4 text-metadata text-muted">
            {preview.failed
              ? "Preview unavailable · open original"
              : "Loading preview…"}
          </span>
        )}
      </button>
      {preview.failed && !originalSrc && (
        <button
          type="button"
          onClick={preview.retry}
          aria-label={`Retry preview ${attachment.filename}`}
          className="py-1 text-metadata text-brand hover:underline"
        >
          Retry preview
        </button>
      )}
      <DownloadState download={download} attachment={attachment} />
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={attachment.filename}
        footer={
          <button
            type="button"
            onClick={save}
            disabled={download.status === "downloading"}
            className="text-brand disabled:opacity-50"
          >
            Download
          </button>
        }
      >
        {displaySrc && (
          <img
            src={displaySrc}
            onError={imageError}
            alt={attachment.filename}
            className="mx-auto max-h-[65vh] w-auto max-w-full object-contain"
          />
        )}
        {originalFailed && (
          <p className="mt-2 text-metadata text-error">
            This image cannot be displayed. Download it to open in another app.
          </p>
        )}
        <DownloadState download={download} attachment={attachment} />
        {download.status === "available" && (
          <button
            type="button"
            onClick={download.start}
            className="mt-3 text-brand"
          >
            Download original
          </button>
        )}
      </Modal>
    </div>
  );
}

function formatDuration(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return "";
  const seconds = Math.floor(duration);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function VideoAttachment({ attachment, tile = false }) {
  const viewer = useMediaViewer();
  const download = useAttachmentDownload(attachment);
  const src = useObjectUrl(download.blob);
  const [playFailed, setPlayFailed] = useState(false);
  const size = formatSize(attachment.size);
  return (
    <div className="w-full min-w-0 max-w-xs">
      {src && !playFailed && !tile ? (
        <video
          src={src}
          controls
          playsInline
          preload="metadata"
          onError={() => setPlayFailed(true)}
          poster={attachment.preview_url || undefined}
          style={mediaStyle(attachment, tile, "16 / 9")}
          aria-label={attachment.filename}
          className={`w-full bg-canvas object-contain ${tile ? "" : "rounded-xl"}`}
        />
      ) : (
        <button
          type="button"
          onClick={() =>
            tile && viewer ? viewer.open(attachment) : download.start()
          }
          disabled={
            download.status === "downloading" ||
            !(attachment.id || attachment.local_blob)
          }
          aria-label={`Download video ${attachment.filename || ""}, ${size}`}
          style={mediaStyle(attachment, tile, "16 / 9")}
          className={`relative grid w-full place-items-center overflow-hidden border border-line bg-canvas text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${tile ? "" : "rounded-xl"}`}
        >
          {attachment.preview_url && (
            <img
              src={attachment.preview_url}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
          <span className="relative flex max-w-full flex-col items-center gap-1 rounded-lg bg-surface/90 px-3 py-2 text-center">
            <IconDownload className="h-6 w-6 text-brand" aria-hidden="true" />
            <span className="max-w-full truncate text-label">
              {attachment.filename || "Video"}
            </span>
            <span className="text-metadata">
              {formatDuration(attachment.duration)} · {size}
            </span>
          </span>
        </button>
      )}
      {playFailed && (
        <p className="text-metadata text-error">
          This browser cannot play this video. Save it to open in another app.
        </p>
      )}
      <DownloadState download={download} attachment={attachment} />
      {viewer && !tile && (
        <button
          type="button"
          onClick={() => viewer.open(attachment)}
          className="py-1 text-metadata text-brand"
          aria-label={`Open ${attachment.filename}`}
        >
          Open video
        </button>
      )}
      {download.blob && (
        <button
          type="button"
          onClick={() => saveAttachmentToDevice(attachment, download.blob)}
          aria-label={`Save ${attachment.filename}`}
          className="py-1 text-metadata text-brand hover:underline"
        >
          Save video
        </button>
      )}
    </div>
  );
}

const isMedia = (attachment) =>
  /^(image|video)\//.test(attachment.mime_type || "");
function MediaItem({ attachment, tile }) {
  return (attachment.mime_type || "").startsWith("video/") ? (
    <VideoAttachment attachment={attachment} tile={tile} />
  ) : (
    <ImageAttachment attachment={attachment} tile={tile} />
  );
}
export function AttachmentGroup({ attachments = [], albumTile = false }) {
  const media = attachments.filter(isMedia);
  const files = attachments.filter((attachment) => !isMedia(attachment));
  const tiled = albumTile || media.length > 1;
  return (
    <div className="flex w-full flex-col gap-1.5">
      {media.length > 0 && (
        <div
          className={
            tiled
              ? "grid w-full max-w-xs grid-cols-2 gap-1 overflow-hidden rounded-xl"
              : "w-full max-w-xs"
          }
        >
          {media.map((attachment) => (
            <MediaItem
              key={attachment.id || attachment.url}
              attachment={attachment}
              tile={tiled}
            />
          ))}
        </div>
      )}
      {files.map((attachment) => (
        <FileAttachment
          key={attachment.id || attachment.url}
          attachment={attachment}
        />
      ))}
    </div>
  );
}
export default function AttachmentCard({ attachment }) {
  return isMedia(attachment) ? (
    <MediaItem attachment={attachment} tile={false} />
  ) : (
    <FileAttachment attachment={attachment} />
  );
}
