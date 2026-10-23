import { useRef, useState } from "react";
import IconAttach from "@/assets/icons/attach.svg?react";
import IconCamera from "@/assets/icons/camera.svg?react";
import IconDecisions from "@/assets/icons/decisions.svg?react";
import IconDocument from "@/assets/icons/document.svg?react";
import IconImage from "@/assets/icons/image.svg?react";
import IconList from "@/assets/icons/list-view.svg?react";
import IconTasks from "@/assets/icons/tasks.svg?react";
import PopoverMenu from "@/components/ui/PopoverMenu";
import Sheet from "@/components/ui/Sheet";
import useMediaQuery from "@/hooks/useMediaQuery";
import { DOCUMENT_ACCEPT, PHOTO_ACCEPT } from "@/lib/media";

/**
 * The attach button and its menu: a bottom sheet with a grid on phones, a
 * popover on wider screens.
 *
 * Photos and Camera hand files over flagged for compression; Document keeps the
 * original bytes. Poll, Decision and Task are optional, and each appears only
 * when its handler is supplied.
 *
 * The desktop menu opens upward, because the trigger sits at the bottom of the
 * pane: `side="bottom"` would clamp immediately against the viewport edge and
 * land the menu back on top of the button it came from.
 *
 * @param {(files: File[], options: { compress: boolean }) => void} onFiles
 * @param {boolean} disabled
 * @param {() => void} [onPoll]
 * @param {() => void} [onDecision]
 * @param {() => void} [onTask]
 */
export default function AttachmentPicker({
  onFiles,
  disabled,
  onPoll,
  onDecision,
  onTask,
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const photosRef = useRef(null);
  const cameraRef = useRef(null);
  const documentRef = useRef(null);

  const isDesktop = useMediaQuery("(min-width: 768px)");
  // `(pointer: coarse)` rather than a hover query: a desktop with a touchscreen
  // still has a fine pointer, and a phone has no desktop camera to offer.
  const hasCamera = useMediaQuery("(pointer: coarse)");

  const handleChange = (compress) => (event) => {
    const files = [...(event.target.files || [])];
    // Reset so picking the same file again still fires a change.
    event.target.value = "";
    if (files.length > 0) onFiles(files, { compress });
  };

  const items = [
    {
      key: "photos",
      label: "Photos & videos",
      Icon: IconImage,
      run: () => photosRef.current?.click(),
    },
    hasCamera && {
      key: "camera",
      label: "Camera",
      Icon: IconCamera,
      run: () => cameraRef.current?.click(),
    },
    {
      key: "document",
      label: "Document",
      Icon: IconDocument,
      run: () => documentRef.current?.click(),
    },
    onPoll && { key: "poll", label: "Poll", Icon: IconList, run: onPoll },
    onDecision && {
      key: "decision",
      label: "Decision",
      Icon: IconDecisions,
      run: onDecision,
    },
    onTask && { key: "task", label: "Task", Icon: IconTasks, run: onTask },
  ].filter(Boolean);

  const choose = (run) => {
    setOpen(false);
    run();
  };

  const hidden = { className: "sr-only", tabIndex: -1, "aria-hidden": true };

  return (
    <>
      <input
        ref={photosRef}
        type="file"
        multiple
        accept={PHOTO_ACCEPT}
        onChange={handleChange(true)}
        {...hidden}
      />
      <input
        ref={cameraRef}
        type="file"
        accept={PHOTO_ACCEPT}
        capture="environment"
        onChange={handleChange(true)}
        {...hidden}
      />
      <input
        ref={documentRef}
        type="file"
        multiple
        accept={DOCUMENT_ACCEPT}
        onChange={handleChange(false)}
        {...hidden}
      />

      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Attach"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-40"
      >
        <IconAttach className="h-5 w-5" aria-hidden="true" />
      </button>

      {isDesktop ? (
        <PopoverMenu
          open={open}
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          side="top"
          align="start"
          label="Attach"
          className="w-56"
        >
          {items.map(({ key, label, Icon, run }) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              onClick={() => choose(run)}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-body text-ink transition-colors hover:bg-canvas"
            >
              <Icon className="h-5 w-5 text-brand" aria-hidden="true" />
              {label}
            </button>
          ))}
        </PopoverMenu>
      ) : (
        <Sheet open={open} onClose={() => setOpen(false)} title="Attach">
          <div className="grid grid-cols-3 gap-3 pb-2">
            {items.map(({ key, label, Icon, run }) => (
              <button
                key={key}
                type="button"
                onClick={() => choose(run)}
                className="flex flex-col items-center gap-2 rounded-xl p-2 text-metadata text-ink transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
              >
                <span className="grid h-14 w-14 place-items-center rounded-full bg-brand-soft text-brand">
                  <Icon className="h-6 w-6" aria-hidden="true" />
                </span>
                {label}
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}
