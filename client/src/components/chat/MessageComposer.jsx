import { useEffect, useRef, useState } from 'react';
import IconClose from '@/assets/icons/close.svg?react';
import IconMention from '@/assets/icons/mention.svg?react';
import IconSend from '@/assets/icons/send.svg?react';
import { uploadFile } from '@/services/messages.service';
import AttachmentPicker, { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES } from './AttachmentPicker';
import MentionPicker from './MentionPicker';

const MAX_LINES = 5;

/**
 * The composer.
 *
 * Three things it has to get right, and one it must not fake.
 *
 * IME safety: Enter must not send while a composition is in flight. Japanese,
 * Korean and Chinese input commit with Enter, so a naive handler eats the
 * character the user just chose. `isComposing` is the honest check; the
 * keyCode fallback covers browsers that report it inconsistently.
 *
 * Growing: the box starts at one line and grows to five, then scrolls. A
 * fixed-height composer either wastes a row on a one-word reply or clips a
 * pasted paragraph, and the clipboard is where most long messages come from.
 *
 * Mentions record ids. The name goes in the text, the id goes on the wire, and
 * the two are independent from that point — renaming the person later does not
 * rewrite history.
 *
 * It must not fake uploads. A file is uploaded the moment it is picked, before
 * the message is sent, so a failed upload is visible while the text is still
 * editable. Pretending a file is attached until send and then discovering the
 * 25MB limit loses the message along with the file.
 *
 * @param {boolean} disabled - no realtime connection
 * @param {(payload: object) => void} onSend
 * @param {Array} members - room members, for the mention picker
 * @param {() => void} onTyping - emits a typing event, throttled by the caller
 * @param {object|null} replyTo - message being replied to
 * @param {() => void} onCancelReply
 */
export default function MessageComposer({
  disabled,
  onSend,
  members = [],
  onTyping,
  replyTo,
  onCancelReply,
}) {
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [mentionQuery, setMentionQuery] = useState(null);
  const [mentionedIds, setMentionedIds] = useState([]);

  const textareaRef = useRef(null);
  const typingTimer = useRef(null);

  // Auto-grow. Reset to auto first so shrinking works, then clamp at five
  // lines — beyond that the box scrolls rather than eating the timeline.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * MAX_LINES)}px`;
  }, [content]);

  useEffect(
    () => () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
    },
    [],
  );

  const signalTyping = () => {
    onTyping?.();
    // Throttled: the server expires a typing state after a few seconds of
    // silence, so re-announcing on a timer while the keys keep moving is what
    // keeps the indicator honest without a packet per keystroke.
    if (typingTimer.current) return;
    typingTimer.current = setTimeout(() => {
      typingTimer.current = null;
    }, 2500);
  };

  const handleTextChange = (event) => {
    const { value, selectionStart } = event.target;
    setContent(value);
    setError('');
    signalTyping();

    // The mention query is whatever follows an @ that has no space after it,
    // ending at the caret. Cheap, and correct for the only case that matters:
    // typing a name immediately after the @.
    const before = value.slice(0, selectionStart);
    const match = before.match(/@([^\s@]*)$/);
    setMentionQuery(match ? match[1] : null);
  };

  const applyMention = (member) => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? content.length;
    const before = content.slice(0, caret);
    const after = content.slice(caret);
    const match = before.match(/@([^\s@]*)$/);
    if (!match) return;

    const start = before.length - match[0].length;
    const insertion = `@${member.display_name} `;
    setContent(`${content.slice(0, start)}${insertion}${after}`);
    setMentionQuery(null);
    setMentionedIds((prev) => (prev.includes(member.id) ? prev : [...prev, member.id]));

    requestAnimationFrame(() => {
      const position = start + insertion.length;
      el?.setSelectionRange(position, position);
      el?.focus();
    });
  };

  const handleFiles = async (files) => {
    setError('');
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setError(`A message can hold at most ${MAX_ATTACHMENTS} files.`);
      return;
    }

    const accepted = files.slice(0, room);
    if (files.length > room) {
      setError(`Only ${room} more file${room === 1 ? '' : 's'} fit in this message.`);
    }

    for (const file of accepted) {
      if (file.size > MAX_UPLOAD_BYTES) {
        setError(`"${file.name}" is larger than the 25MB limit.`);
        continue;
      }
      const localId = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setAttachments((prev) => [
        ...prev,
        { localId, filename: file.name, size: file.size, uploading: true },
      ]);

      try {
        const stored = await uploadFile(file);
        setAttachments((prev) =>
          prev.map((item) =>
            item.localId === localId ? { ...item, ...stored, uploading: false } : item,
          ),
        );
      } catch (err) {
        setAttachments((prev) => prev.filter((item) => item.localId !== localId));
        setError(err.response?.data?.message || `Could not upload "${file.name}".`);
      }
    }
  };

  const removeAttachment = (localId) => {
    setAttachments((prev) => prev.filter((item) => item.localId !== localId));
  };

  const reset = () => {
    setContent('');
    setAttachments([]);
    setMentionedIds([]);
    setMentionQuery(null);
    onCancelReply?.();
  };

  const submit = (event) => {
    event?.preventDefault();
    const text = content.trim();
    const uploaded = attachments.filter((item) => !item.uploading && item.url);

    if (attachments.some((item) => item.uploading)) {
      setError('Wait for the upload to finish.');
      return;
    }
    if (!text && uploaded.length === 0) return;
    if (disabled) return;

    try {
      onSend({
        content: text,
        replyToId: replyTo?.id,
        attachments: uploaded.map((item) => ({ url: item.url })),
        mentionedUserIds: mentionedIds,
      });
      reset();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleKeyDown = (event) => {
    // A composition is in flight (IME). Enter is committing a character, not
    // sending a message.
    if (event.nativeEvent?.isComposing || event.keyCode === 229) return;

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} className="relative shrink-0 bg-surface px-4 pb-6 pt-2">
      {replyTo && (
        <div className="mb-2 flex items-center gap-3 rounded-lg border-l-2 border-brand bg-canvas px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-metadata text-brand">Replying to {replyTo.sender_name || 'a message'}</p>
            <p className="truncate text-metadata text-muted">
              {replyTo.content || (replyTo.is_deleted ? 'deleted message' : 'attachment')}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancelReply}
            aria-label="Cancel reply"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <IconClose className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {attachments.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1.5">
          {attachments.map((item) => (
            <li
              key={item.localId}
              className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-body text-ink">{item.filename}</span>
              <span className="shrink-0 text-metadata text-muted">
                {item.uploading ? 'Uploading…' : 'Ready'}
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(item.localId)}
                aria-label={`Remove ${item.filename}`}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:text-error"
              >
                <IconClose className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="relative flex items-end gap-2 rounded-lg border border-line bg-surface px-3 py-2 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/10">
        <div className="flex shrink-0 gap-1 pb-1">
          <AttachmentPicker onFiles={handleFiles} disabled={disabled} />
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              textareaRef.current?.focus();
              setMentionQuery('');
            }}
            aria-label="Mention someone"
            className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-40"
          >
            <IconMention className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="Message…"
          aria-label="Message"
          className="block min-h-6 min-w-0 flex-1 resize-none border-0 bg-transparent py-1 text-body text-ink outline-none placeholder:text-muted"
        />

        <button
          type="submit"
          disabled={disabled || (!content.trim() && attachments.length === 0)}
          aria-label="Send message"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand pb-0.5 text-surface transition-opacity disabled:opacity-40"
        >
          <IconSend className="h-5 w-5" aria-hidden="true" />
        </button>

        {mentionQuery !== null && (
          <MentionPicker
            members={members}
            query={mentionQuery}
            onSelect={applyMention}
            onDismiss={() => setMentionQuery(null)}
          />
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 px-1 text-metadata text-error">
          {error}
        </p>
      )}
    </form>
  );
}
