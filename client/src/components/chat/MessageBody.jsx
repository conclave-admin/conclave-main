import { useId, useLayoutEffect, useRef, useState } from "react";
import { sharedUrls } from "../../lib/sharedLinks";
const LIMIT = 1000;
function highlight(text, query) {
  if (!query) return text;
  const lower = text.toLocaleLowerCase(),
    needle = query.toLocaleLowerCase();
  let start = 0,
    index;
  const parts = [];
  while ((index = lower.indexOf(needle, start)) !== -1) {
    parts.push(
      text.slice(start, index),
      <mark key={index} className="rounded bg-amber-200 text-black">
        {text.slice(index, index + query.length)}
      </mark>,
    );
    start = index + query.length;
  }
  parts.push(text.slice(start));
  return parts;
}
function inline(text, query) {
  // React escapes every text node. No raw HTML or executable URL protocols.
  return text
    .split(
      /(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|https?:\/\/[^\s<>"']+|@[\w.]+)/g,
    )
    .map((part, i) => {
      if (part.startsWith("`") && part.endsWith("`"))
        return (
          <code
            key={i}
            className="rounded bg-black/10 px-1 font-mono text-[.9em]"
          >
            {highlight(part.slice(1, -1), query)}
          </code>
        );
      if (part.startsWith("**") && part.endsWith("**"))
        return <strong key={i}>{highlight(part.slice(2, -2), query)}</strong>;
      if (part.startsWith("~~") && part.endsWith("~~"))
        return <s key={i}>{highlight(part.slice(2, -2), query)}</s>;
      if (part.startsWith("*") && part.endsWith("*"))
        return <em key={i}>{highlight(part.slice(1, -1), query)}</em>;
      if (/^https?:\/\//i.test(part)) {
        const url = sharedUrls(part)[0];
        if (url)
          return (
            <a
              key={i}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-current/40 underline-offset-2 [overflow-wrap:anywhere]"
            >
              {highlight(part, query)}
            </a>
          );
      }
      if (part.startsWith("@"))
        return (
          <span key={i} className="rounded bg-black/5 px-0.5 font-semibold">
            {highlight(part, query)}
          </span>
        );
      return highlight(part, query);
    });
}
function rich(text, query) {
  return text.split(/(```[\s\S]*?```)/g).map((part, i) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const raw = part.slice(3, -3),
        newline = raw.indexOf("\n"),
        language = newline >= 0 ? raw.slice(0, newline).trim() : "";
      const code = newline >= 0 ? raw.slice(newline + 1) : raw;
      return (
        <figure
          key={i}
          className="my-2 min-w-0 rounded-lg border border-current/15 bg-black/10 p-3"
        >
          {language && (
            <figcaption className="mb-2 text-[11px] opacity-70">
              {language.slice(0, 30)}
            </figcaption>
          )}
          <pre className="max-w-full overflow-x-auto whitespace-pre text-xs">
            <code>{highlight(code, query)}</code>
          </pre>
          <button
            type="button"
            className="mt-2 min-h-8 text-xs underline"
            onClick={async (e) => {
              try {
                await navigator.clipboard.writeText(code);
                e.target.textContent = "Copied";
              } catch {
                e.target.textContent = "Copy unavailable";
              }
            }}
          >
            Copy code
          </button>
        </figure>
      );
    }
    return (
      <span key={i} className="whitespace-pre-wrap">
        {inline(part, query)}
      </span>
    );
  });
}
export default function MessageBody({
  text = "",
  forceExpanded = false,
  query = "",
}) {
  const [expanded, setExpanded] = useState(false),
    [preview, setPreview] = useState(false);
  const id = useId(),
    root = useRef(null),
    anchor = useRef(null);
  const long = text.length > LIMIT || text.split("\n").length > 18;
  const open = expanded || forceExpanded;
  useLayoutEffect(() => {
    if (anchor.current !== null && root.current) {
      const change = root.current.getBoundingClientRect().top - anchor.current;
      const scroll = root.current.closest("[data-message-scroll]");
      if (scroll) scroll.scrollTop += change;
      anchor.current = null;
    }
  }, [expanded]);
  const urls = sharedUrls(text).slice(0, 3);
  return (
    <div ref={root} className="min-w-0 max-w-full">
      <div
        id={id}
        className={
          !open && long
            ? "relative max-h-80 overflow-hidden [mask-image:linear-gradient(black_85%,transparent)]"
            : ""
        }
      >
        {rich(open || !long ? text : text.slice(0, LIMIT), query)}
      </div>
      {long && !forceExpanded && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          className="mt-1 min-h-9 font-semibold underline underline-offset-2"
          onClick={() => {
            anchor.current = root.current?.getBoundingClientRect().top;
            setExpanded((v) => !v);
          }}
        >
          {open ? "Show less" : "Read more"}
        </button>
      )}
      {urls.length > 0 && (
        <div className="mt-2 border-t border-current/15 pt-1">
          <button
            type="button"
            className="min-h-8 text-xs underline"
            aria-expanded={preview}
            onClick={() => setPreview((v) => !v)}
          >
            {preview ? "Hide link cards" : "Show link cards"}
          </button>
          {preview &&
            urls.map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 block rounded-lg border border-current/15 bg-black/5 p-2 text-xs"
              >
                <strong>{new URL(url).hostname}</strong>
                <span className="mt-1 block truncate">{url}</span>
                <span className="opacity-70">
                  Open website · no external preview fetched
                </span>
              </a>
            ))}
        </div>
      )}
    </div>
  );
}
