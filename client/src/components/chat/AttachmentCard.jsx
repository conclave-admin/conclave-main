import IconAudio from "@/assets/icons/audio-file.svg?react";
import IconDocument from "@/assets/icons/document.svg?react";
import IconDownload from "@/assets/icons/download.svg?react";
import IconFile from "@/assets/icons/file.svg?react";
import IconImage from "@/assets/icons/image.svg?react";
import IconPlay from "@/assets/icons/play-recording.svg?react";
import IconVideo from "@/assets/icons/video-file.svg?react";
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
  if (mimeType.startsWith("video/")) return IconVideo;
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
  if (
    status === "available" ||
    status === "not-downloaded" ||
    status === "idle"
  )
    return null;
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
              : "Tap the attachment to download"}
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
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const playWhenReady = useRef(false);
  const probing = useRef(false);
  const probeTimer = useRef(null);
  useEffect(() => () => clearTimeout(probeTimer.current), [src]);
  useEffect(() => {
    setError("");
    setDuration(null);
    setCurrentTime(0);
    setPlaying(false);
    probing.current = false;
  }, [src]);
  useEffect(() => {
    if (!src || !playWhenReady.current || !player.current) return;
    playWhenReady.current = false;
    player.current.play().catch(() => {
      setError("Playback could not start in this browser. Save the audio to try another player.");
    });
  }, [src]);
  const togglePlayback = async () => {
    setError("");
    if (src && player.current) {
      if (!player.current.paused) {
        player.current.pause();
        return;
      }
      await player.current.play().catch(() =>
        setError("Playback could not start in this browser. Save the audio to try another player."),
      );
      return;
    }
    playWhenReady.current = true;
    const blob = await download.start();
    if (!blob) playWhenReady.current = false;
  };
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
  const isVoice = attachment.filename?.startsWith("voice-") || attachment.filename?.startsWith("recording-");
  const label = isVoice ? "Voice message" : attachment.filename || "Audio file";
  const busy = download.checking || download.status === "downloading";
  const seek = (event) => {
    const next = Number(event.target.value);
    if (player.current && Number.isFinite(player.current.duration)) {
      player.current.currentTime = next;
      setCurrentTime(next);
    }
  };
  return (
    <section
      aria-label={label}
      className="w-full min-w-0 max-w-sm space-y-2 rounded-2xl border border-line bg-canvas p-3"
    >
      <audio
        ref={player}
        src={src || undefined}
        preload="metadata"
        onLoadedMetadata={loaded}
        onDurationChange={metadata}
        onTimeUpdate={(event) => { metadata(); setCurrentTime(event.currentTarget.currentTime); }}
        onPlay={() => {
          setPlaying(true);
          window.dispatchEvent(new CustomEvent("conclave:voice-playing", { detail: player.current }));
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          if (player.current) player.current.currentTime = 0;
          setCurrentTime(0);
        }}
        onError={() => src && setError("This browser could not play the audio. Save it to try another player.")}
      />
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={togglePlayback}
          disabled={busy || !(attachment.id || attachment.local_blob)}
          aria-label={`${playing ? "Pause" : "Play"} ${label}`}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand text-white disabled:opacity-60"
        >
          {playing ? <span className="flex gap-1" aria-hidden="true"><span className="h-4 w-1 rounded-sm bg-current" /><span className="h-4 w-1 rounded-sm bg-current" /></span> : <IconPlay className="h-5 w-5" aria-hidden="true" />}
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-label text-ink">{label}</p>
          <input
            type="range"
            min="0"
            max={duration || 1}
            step="0.1"
            value={Math.min(currentTime, duration || 1)}
            onChange={seek}
            disabled={!src || !duration}
            aria-label={`Seek ${label}`}
            className="h-5 w-full min-w-0 accent-brand disabled:opacity-50"
          />
          <div className="flex justify-between text-metadata text-muted">
            <span>{formatDuration(currentTime) || "0:00"}</span>
            <span>{download.status === "downloading" ? `${Math.round(download.progress * 100)}%` : formatDuration(duration || attachment.duration) || formatSize(attachment.size)}</span>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => setSpeed((value) => value === 1 ? 1.5 : value === 1.5 ? 2 : 1)} className="rounded-full px-2 py-1 text-metadata font-semibold text-brand" aria-label={`Playback speed ${speed} times. Change speed`}>{speed}×</button>
        {download.blob && <button type="button" className="text-metadata text-brand" onClick={() => saveAttachmentToDevice(attachment, download.blob)}>Save audio</button>}
      </div>
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
    width: "100%",
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
        className={`relative block min-w-0 max-w-full overflow-hidden bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${tile ? "" : "rounded-xl"}`}
      >
        {displaySrc ? (
          <img
            src={displaySrc}
            alt={attachment.filename}
            onError={imageError}
            width={attachment.width || undefined}
            height={attachment.height || undefined}
            className="block h-full w-full min-w-0 max-w-full object-cover"
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
  const player = useRef(null);
  const playWhenReady = useRef(false);
  const [playFailed, setPlayFailed] = useState(false);
  const size = formatSize(attachment.size);
  useEffect(() => {
    if (!src || !playWhenReady.current || !player.current || tile) return;
    playWhenReady.current = false;
    player.current.play().catch(() => {
      // Browsers can decline playback after an asynchronous download. Native
      // controls remain visible so the user can start it with one more tap.
    });
  }, [src, tile]);
  useEffect(() => {
    const pauseForOtherMedia = (event) => {
      if (event.detail !== player.current) player.current?.pause();
    };
    window.addEventListener("conclave:voice-playing", pauseForOtherMedia);
    return () => window.removeEventListener("conclave:voice-playing", pauseForOtherMedia);
  }, []);
  const play = async () => {
    if (tile && viewer) {
      viewer.open(attachment);
      return;
    }
    if (src && player.current) {
      await player.current.play().catch(() => {});
      return;
    }
    playWhenReady.current = true;
    const blob = await download.start();
    if (!blob) playWhenReady.current = false;
  };
  return (
    <div className="w-full min-w-0 max-w-xs">
      {src && !playFailed && !tile ? (
        <video
          ref={player}
          src={src}
          controls
          playsInline
          preload="metadata"
          onError={() => setPlayFailed(true)}
          onPlay={() => window.dispatchEvent(new CustomEvent("conclave:voice-playing", { detail: player.current }))}
          poster={attachment.preview_url || undefined}
          style={mediaStyle(attachment, tile, "16 / 9")}
          aria-label={attachment.filename}
          className="block min-w-0 max-w-full bg-canvas object-contain rounded-xl"
        />
      ) : playFailed && !tile ? (
        <div className="rounded-xl border border-line bg-canvas p-4 text-metadata text-muted">Video preview unavailable</div>
      ) : (
        <button
          type="button"
          onClick={play}
          disabled={
            download.checking || download.status === "downloading" ||
            !(attachment.id || attachment.local_blob)
          }
          aria-label={`Play video ${attachment.filename || ""}, ${size}`}
          style={mediaStyle(attachment, tile, "16 / 9")}
          className={`relative grid min-w-0 max-w-full place-items-center overflow-hidden border border-line bg-canvas text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${tile ? "" : "rounded-xl"}`}
        >
          {attachment.preview_url && (
            <img
              src={attachment.preview_url}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
          <span className="relative flex max-w-full flex-col items-center gap-1 rounded-lg bg-surface/90 px-3 py-2 text-center">
            <IconPlay className="h-6 w-6 text-brand" aria-hidden="true" />
            <span className="max-w-full truncate text-label">{download.status === "downloading" ? `Loading ${Math.round(download.progress * 100)}%` : "Play video"}</span>
          </span>
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-metadata text-white">{formatDuration(attachment.duration) || size}</span>
        </button>
      )}
      {playFailed && (
        <p className="text-metadata text-error">
          This browser cannot play this video. Save it to open in another app.
        </p>
      )}
      <DownloadState download={download} attachment={attachment} />
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
    <div className="flex w-full min-w-0 max-w-full flex-col gap-1.5">
      {media.length > 0 && (
        <div
          className={
            tiled
              ? "grid w-full min-w-0 max-w-xs grid-cols-[repeat(2,minmax(0,1fr))] gap-1 overflow-hidden rounded-xl"
              : "w-full min-w-0 max-w-xs"
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
