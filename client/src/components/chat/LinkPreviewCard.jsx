import { useEffect, useState } from "react";
import { firstHttpUrl, getLinkPreview } from "@/services/linkPreview.service";

export default function LinkPreviewCard({ text, compact = false }) {
  const url = firstHttpUrl(text);
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    let active = true;
    setPreview(null);
    const timer = url
      ? window.setTimeout(
          () => getLinkPreview(url).then((result) => active && setPreview(result)),
          450,
        )
      : null;
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [url]);
  if (!url || !preview) return null;

  return (
    <a
      className={`link-preview-card block min-w-0 overflow-hidden rounded-lg border border-line/70 bg-canvas/80 transition-colors hover:border-brand/50 ${compact ? "max-w-full" : "max-w-sm"}`}
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={(event) => event.stopPropagation()}
    >
      <span className="block border-l-[3px] border-brand px-3 py-2">
        <span className="block truncate text-label font-semibold text-ink">
          {preview.title || preview.host}
        </span>
        {preview.description && (
          <span className="mt-0.5 line-clamp-2 block text-metadata text-muted">
            {preview.description}
          </span>
        )}
        <span className="mt-1 block truncate text-[11px] text-brand">
          {preview.host}
        </span>
      </span>
    </a>
  );
}
