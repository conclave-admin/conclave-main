// Optional, local, real-time encoding: no upload or third-party transcoding.
export const MAX_VIDEO_INPUT_BYTES = 200 * 1024 * 1024;
export const MAX_VIDEO_DURATION = 120;
const OUTPUT_LIMIT = 50 * 1024 * 1024;
export function videoCompressionSupported() {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    Boolean(globalThis.AudioContext || globalThis.webkitAudioContext)
  );
}
export async function compressVideo(file, { signal, onProgress } = {}) {
  if (!videoCompressionSupported())
    throw new Error(
      "Video compression is unavailable in this browser. Use a smaller original or trim the video in your device editor.",
    );
  if (file.size > MAX_VIDEO_INPUT_BYTES)
    throw new Error(
      "Choose a video up to 200 MB for local compression, or trim it first.",
    );
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const mimeType = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType)
    throw new Error(
      "This browser has no supported video encoder. Trim the video or send the original.",
    );
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  const audio = new Context();
  // Resume during the user's click, before waiting for video metadata.
  const resumed = audio.resume();
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  const url = URL.createObjectURL(file);
  const chunks = [];
  let stream;
  let recorder;
  let frame;
  let timer;
  let total = 0;
  let settled = false;
  let resolveWork;
  let rejectWork;
  const work = new Promise((resolve, reject) => {
    resolveWork = resolve;
    rejectWork = reject;
  });
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    signal?.removeEventListener("abort", abort);
    document.removeEventListener("visibilitychange", hidden);
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    if (recorder?.state !== "inactive") {
      try {
        recorder?.stop();
      } catch {}
    }
    stream?.getTracks().forEach((track) => track.stop());
    audio.close().catch(() => {});
    URL.revokeObjectURL(url);
    if (error) {
      rejectWork(error);
      return;
    }
    const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
    if (!blob.size || blob.size > OUTPUT_LIMIT) {
      rejectWork(
        new Error(
          "The compressed video still exceeds 50 MB. Trim the clip and try again.",
        ),
      );
      return;
    }
    if (blob.size >= file.size) {
      resolveWork({ file, compressed: false });
      return;
    }
    const extension = blob.type === "video/mp4" ? "mp4" : "webm";
    resolveWork({
      file: new File(
        [blob],
        `${file.name.replace(/\.[^.]+$/, "")}-compressed.${extension}`,
        { type: blob.type, lastModified: file.lastModified },
      ),
      compressed: true,
    });
  };
  const abort = () =>
    finish(new DOMException("Compression cancelled", "AbortError"));
  const hidden = () => {
    if (document.hidden)
      finish(
        new Error(
          "Compression stopped because the app was hidden. Keep this tab open and try again.",
        ),
      );
  };
  signal?.addEventListener("abort", abort, { once: true });
  document.addEventListener("visibilitychange", hidden);
  timer = setTimeout(
    () =>
      finish(
        new Error(
          "This browser could not read the video. Trim it in your device editor.",
        ),
      ),
    10000,
  );
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  video.style.cssText = "position:fixed;left:-10000px;width:1px;height:1px";
  document.body.appendChild(video);
  video.onerror = () =>
    finish(
      new Error(
        "This browser cannot decode the video. Use your device editor to convert it first.",
      ),
    );
  const startEncoding = async () => {
    if (settled || recorder) return;
    try {
      await resumed;
      if (settled) return;
      if (
        !Number.isFinite(video.duration) ||
        video.duration <= 0 ||
        video.duration > MAX_VIDEO_DURATION
      )
        throw new Error(
          "Local compression supports clips up to 2 minutes. Trim longer videos first.",
        );
      if (!video.videoWidth || !video.videoHeight)
        throw new Error("The video has no readable picture.");
      const scale = Math.min(
        1,
        1280 / Math.max(video.videoWidth, video.videoHeight),
      );
      canvas.width = Math.max(
        2,
        Math.round((video.videoWidth * scale) / 2) * 2,
      );
      canvas.height = Math.max(
        2,
        Math.round((video.videoHeight * scale) / 2) * 2,
      );
      const context = canvas.getContext("2d");
      stream = canvas.captureStream(30);
      const source = audio.createMediaElementSource(video);
      const destination = audio.createMediaStreamDestination();
      source.connect(destination);
      destination.stream
        .getAudioTracks()
        .forEach((track) => stream.addTrack(track));
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 2000000,
        audioBitsPerSecond: 128000,
      });
      recorder.ondataavailable = ({ data }) => {
        if (settled || !data.size) return;
        total += data.size;
        chunks.push(data);
        if (total > OUTPUT_LIMIT)
          finish(
            new Error(
              "The result exceeds 50 MB. Trim the clip to reduce its size.",
            ),
          );
      };
      recorder.onerror = () =>
        finish(
          new Error("Video encoding failed. Your original is still selected."),
        );
      recorder.onstop = () => finish();
      video.onended = () => {
        if (!settled && recorder.state === "recording") recorder.stop();
      };
      const draw = () => {
        if (settled) return;
        try {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          onProgress?.(Math.min(1, video.currentTime / video.duration));
          frame = requestAnimationFrame(draw);
        } catch {
          finish(
            new Error(
              "The video frame could not be encoded. Your original is still selected.",
            ),
          );
        }
      };
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          finish(
            new Error(
              "Video compression took too long. Keep the app open or trim the clip.",
            ),
          ),
        Math.min(195000, video.duration * 1500 + 15000),
      );
      recorder.start(250);
      await video.play();
      draw();
    } catch (error) {
      finish(error);
    }
  };
  video.onloadedmetadata = () => {
    if (video.duration === Infinity) {
      // Locally recorded WebM often omits duration; seek once to discover it.
      video.onseeked = () => {
        video.onseeked = () => {
          video.onseeked = null;
          startEncoding();
        };
        video.currentTime = 0;
      };
      video.currentTime = 1e10;
    } else startEncoding();
  };
  resumed.catch((error) =>
    finish(
      new Error(
        "Audio encoding could not start. Keep the original or use your device editor.",
      ),
    ),
  );
  video.load();
  return work;
}
