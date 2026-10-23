import { useEffect, useState } from "react";
import {
  getAttachmentPreviewBlob,
  getCachedAttachmentBlob,
} from "../services/attachments.service";

export default function useAttachmentImage(
  attachment,
  { enabled = true } = {},
) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const reset = () => setAttempt((value) => value + 1);
    window.addEventListener("conclave:media-cache-removed", reset);
    return () =>
      window.removeEventListener("conclave:media-cache-removed", reset);
  }, []);
  useEffect(() => {
    if (!enabled) {
      setSrc(attachment.preview_url || null);
      return undefined;
    }
    const controller = new AbortController();
    let objectUrl;
    setSrc(
      attachment.preview_url?.startsWith("data:image/")
        ? attachment.preview_url
        : null,
    );
    setFailed(false);
    (async () => {
      const cached = await getCachedAttachmentBlob(attachment);
      const blob =
        cached ||
        (await getAttachmentPreviewBlob(attachment, {
          signal: controller.signal,
        }));
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setSrc(objectUrl);
    })().catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    attachment.id,
    attachment.url,
    attachment.local_blob,
    attachment.preview_url,
    attempt,
    enabled,
  ]);
  return {
    src,
    failed,
    retry: () => setAttempt((value) => value + 1),
    fail: () => {
      setSrc(null);
      setFailed(true);
    },
  };
}
