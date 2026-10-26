import EmojiPicker from "./EmojiPicker";
import { useRef, useState } from "react";
import IconReaction from "@/assets/icons/reaction.svg?react";
import PopoverMenu from "@/components/ui/PopoverMenu";

/**
 * Reaction chips, and the picker that adds one.
 *
 * The picker and API share Emoji Mart's canonical native sequences, including
 * skin tones and joined emoji.
 *
 * `reacted` is per viewer and comes from the server already computed, so this
 * component never compares user ids itself. That matters because a reaction by
 * anybody flips `reacted` for everybody else, which is why the server re-reads
 * the whole message on every reaction rather than pushing a delta.
 *
 * @param {object} message
 * @param {(emoji: string) => void} onToggle
 */
export default function MessageReactions({ message, onToggle }) {
  const reactions = message.reactions || [];
  const [pickerOpen, setPickerOpen] = useState(false);
  const triggerRef = useRef(null);

  // The first reaction on a message now comes from the actions menu, so this
  // row only exists once there is something to show or add to.
  if (!reactions.length) return null;

  return (
    <div className="relative flex flex-wrap items-center gap-1.5">
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          aria-pressed={reaction.reacted}
          aria-label={`${reaction.emoji} reaction, ${reaction.count}`}
          onClick={() => onToggle(reaction.emoji)}
          className={`inline-flex min-h-6 items-center gap-1 rounded-full border px-1.5 text-metadata transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
            reaction.reacted
              ? "border-brand bg-brand-soft text-brand"
              : "border-line bg-canvas text-muted hover:text-ink"
          }`}
        >
          <span aria-hidden="true">{reaction.emoji}</span>
          <span className="tabular-nums">{reaction.count}</span>
        </button>
      ))}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setPickerOpen((open) => !open)}
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        aria-label="Add a reaction"
        className="inline-flex min-h-6 items-center rounded-full border border-line bg-canvas px-1.5 text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        <IconReaction className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <PopoverMenu
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        triggerRef={triggerRef}
        side="top"
        align="start"
        label="Choose a reaction"
        popupRole="dialog"
        className="w-[min(352px,calc(100vw-16px))] max-h-[calc(100dvh-16px)] overflow-y-auto"
      >
        <EmojiPicker
          onPick={(emoji) => {
            setPickerOpen(false);
            onToggle(emoji);
          }}
        />
      </PopoverMenu>
    </div>
  );
}
