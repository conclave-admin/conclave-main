// Thumbnails travel with the authorized message, so they also work offline and
// never require a token or an original download. PDFs remain document cards.
export const MAX_PREVIEW_BYTES = 12 * 1024;

function thumbnail(source, width, height) {
  const canvas = document.createElement("canvas");
  for (const edge of [240, 160, 96]) {
    const scale = Math.min(1, edge / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.55);
    if (
      data.startsWith("data:image/jpeg;base64,") &&
      data.length <= (MAX_PREVIEW_BYTES * 4) / 3 + 23
    )
      return data;
  }
  return null;
}

function dimensions(width, height) {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= 32768 &&
    height <= 32768
  );
}

export async function generateMediaMetadata(blob, signal) {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  if (
    blob.type.startsWith("image/") &&
    typeof createImageBitmap === "function"
  ) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob, {
        imageOrientation: "from-image",
      });
      if (!dimensions(bitmap.width, bitmap.height)) return {};
      return {
        width: bitmap.width,
        height: bitmap.height,
        preview_url: thumbnail(bitmap, bitmap.width, bitmap.height),
      };
    } catch {
      return {};
    } finally {
      bitmap?.close();
    }
  }
  if (!blob.type.startsWith("video/")) return {};
  // Metadata decoding is bounded and codec failure must never prevent sending.
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(blob);
    let metadata = {};
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
      video.onloadeddata = null;
      video.ondurationchange = null;
      video.removeAttribute("src");
      video.load();
      video.remove();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(metadata);
    };
    const abort = () => finish(new DOMException("Cancelled", "AbortError"));
    const timer = setTimeout(() => finish(), 6000);
    signal?.addEventListener("abort", abort, { once: true });
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onloadedmetadata = () => {
      if (dimensions(video.videoWidth, video.videoHeight)) {
        metadata = { width: video.videoWidth, height: video.videoHeight };
      }
      if (
        Number.isFinite(video.duration) &&
        video.duration > 0 &&
        video.duration <= 604800
      )
        metadata.duration = video.duration;
    };
    let probingDuration = false;
    video.ondurationchange = () => {
      if (
        Number.isFinite(video.duration) &&
        video.duration > 0 &&
        video.duration <= 604800
      )
        metadata.duration = video.duration;
    };
    video.onloadeddata = () => {
      // Some WebM recordings omit duration. Seeking the local Blob to the end
      // lets the decoder discover it; retain the first frame if probing stalls.
      if (metadata.width) {
        try {
          metadata.preview_url = thumbnail(
            video,
            metadata.width,
            metadata.height,
          );
        } catch {
          /* optional */
        }
      }
      if (metadata.duration)
        video.currentTime = Math.min(0.1, metadata.duration / 2);
      else if (video.duration === Infinity) {
        probingDuration = true;
        video.currentTime = 1e10;
      } else capture();
    };
    const capture = () => {
      if (dimensions(video.videoWidth, video.videoHeight))
        metadata = {
          ...metadata,
          width: video.videoWidth,
          height: video.videoHeight,
        };
      if (
        Number.isFinite(video.duration) &&
        video.duration > 0 &&
        video.duration <= 604800
      )
        metadata.duration = video.duration;
      try {
        if (metadata.width)
          metadata.preview_url = thumbnail(
            video,
            metadata.width,
            metadata.height,
          );
      } catch {
        /* A poster is optional when the browser cannot decode it. */
      }
      finish();
    };
    video.onseeked = () => {
      if (probingDuration) {
        probingDuration = false;
        video.currentTime = metadata.duration
          ? Math.min(0.1, metadata.duration / 2)
          : 0;
      } else capture();
    };
    video.onerror = () => finish();
    video.setAttribute("aria-hidden", "true");
    video.style.cssText =
      "position:fixed;left:-10000px;width:1px;height:1px;pointer-events:none";
    document.body.appendChild(video);
    video.src = url;
    video.load();
  });
}
