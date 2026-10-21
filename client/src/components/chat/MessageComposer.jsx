import { useEffect, useRef, useState } from 'react';
import IconClose from '@/assets/icons/close.svg?react';
import IconMention from '@/assets/icons/mention.svg?react';
import IconSend from '@/assets/icons/send.svg?react';
import IconMic from '@/assets/icons/mic.svg?react';
import { createClientId } from '@/lib/outbox';
import {
  isAccepted,
  isImage,
  isVideo,
  limitFor,
  MAX_ATTACHMENTS,
  normaliseFile,
} from '@/lib/media';
import { MAX_VIDEO_INPUT_BYTES } from '@/lib/videoCompression';
import AttachmentPicker from './AttachmentPicker';
import AttachmentPreviewDialog from './AttachmentPreviewDialog';
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
 * Selected files and captions are saved to the account outbox before the
 * editor closes. Upload progress and retry controls then live in the timeline.
 *
 * @param {boolean} disabled - no realtime connection
 * @param {(payload: object) => void} onSend
 * @param {Array} members - room members, for the mention picker
 * @param {() => void} onTyping - emits a typing event, throttled by the caller
 * @param {object|null} replyTo - message being replied to
 * @param {() => void} onCancelReply
 * @param {() => void} [onCreatePoll] - opens the poll dialog when supplied
 * @param {() => void} [onCreateDecision] - opens the decision dialog when supplied
 * @param {() => void} [onCreateTask] - opens the task dialog when supplied
 */
export default function MessageComposer({
  disabled,
  isOnline = true,
  onSend,
  onSendMedia,
  members = [],
  onTyping,
  replyTo,
  onCancelReply,
  onCreatePoll,
  onCreateDecision,
  onCreateTask,
  onEditLast,
  // The room pane is a grid and addresses its rows explicitly, so the composer
  // needs to accept the placement the parent decides rather than hardcoding one.
  className = '',
}) {
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [pendingFiles, setPendingFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState(null);
  const [mentionedIds, setMentionedIds] = useState([]);
  const [recording, setRecording] = useState(false);

  const textareaRef = useRef(null);
  const typingTimer = useRef(null);
  // Bumped when the preview is abandoned so an upload still in flight knows its
  // result is no longer wanted and must not touch state that has moved on.
  const sendToken = useRef(0);
  const textSendingRef = useRef(false);
  const recorderRef = useRef(null);
  const recordingStreamRef = useRef(null);
  const recordingChunksRef = useRef([]);
  // Photos picked through Photos or Camera are shrunk before upload. A WeakSet
  // keeps that flag beside the File without changing the list the dialog gets.
  const compressRef = useRef(new WeakSet());

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
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
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

    // Reconcile the recorded ids against the text that is actually there.
    // mentionedIds only ever grew, so deleting "@Priya" after selecting her left
    // the id in place and the mention still fired on send — a notification for
    // somebody the message no longer names. Ids are rebuilt from the members
    // whose @token is still present, which is the same fact the server acts on.
    setMentionedIds((prev) => {
      if (prev.length === 0) return prev;
      return prev.filter((id) => {
        const person = members.find((entry) => entry.id === id);
        if (!person) return false;
        return value.includes(`@${person.display_name}`);
      });
    });

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

    // With no token to replace, append at the caret instead of giving up. The
    // picker can be opened without an `@` (the button used to do exactly that),
    // and returning early there left the list open and the text untouched with
    // no indication anything had been attempted.
    const start = match ? before.length - match[0].length : caret;
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

  /**
   * Accept the picked files into the preview, or explain why none of them fit.
   *
   * The type check runs here rather than waiting for the server's 415 so the
   * message can name the file: a rejection after a multi-second round trip says
   * only what the server decided, and the browser's own `accept` filter is not
   * enough on its own because it does not run when a file arrives by any other
   * path.
   *
   * The preview only ever opens with a non-empty list — if nothing survived,
   * the composer stays put and says so, rather than presenting an empty modal.
   *
   * @param {File[]} files
   */
  const handleFiles = (files, { compress = false } = {}) => {
    const rejected = [];
    const accepted = [];

    for (const raw of files) {
      const file = normaliseFile(raw);
      const limit = limitFor(file);
      const inputLimit = isVideo(file) ? MAX_VIDEO_INPUT_BYTES : limit;

      if (file.size > inputLimit) {
        rejected.push(`"${file.name}" is larger than the ${inputLimit / (1024 * 1024)}MB selection limit. Trim or resize it before selecting.`);
      } else if (!isAccepted(file.type, file.name)) {
        rejected.push(`"${file.name}" is not a file type this app can store.`);
      } else {
        if (compress && isImage(file)) compressRef.current.add(file);
        accepted.push(file);
      }
    }

    if (accepted.length > MAX_ATTACHMENTS) {
      rejected.push(
        `You can select at most ${MAX_ATTACHMENTS} files at once; the extra ${
          accepted.length - MAX_ATTACHMENTS
        } were not added.`,
      );
      accepted.length = MAX_ATTACHMENTS;
    }

    const note = rejected.join(' ');
    setError(note);

    if (accepted.length > 0) {
      setPendingFiles(accepted);
    }
  };

  const removeFile = (index) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
    setError('');
  };

  const cancelPreview = () => {
    if (sending) return;
    sendToken.current += 1;
    setPendingFiles([]);
    setError('');
  };

  // Persist the whole selection before closing the editor. Upload work belongs
  // to the account outbox, so offline sends and navigation cannot lose files.
  const submitPreview = async (captions) => {
    if (sending || !pendingFiles.length) return;
    const token = ++sendToken.current;
    setSending(true);
    setError('');
    try {
      const albumId = pendingFiles.length > 1 ? createClientId() : undefined;
      const items = pendingFiles.map((file, index) => {
        const caption = (captions[index] || '').trim();
        return {
          content: caption, albumId, replyToId: index === 0 ? replyTo?.id : undefined,
          attachments: [],
          mentionedUserIds: members.filter((person) => caption.includes(`@${person.display_name}`)).map((person) => person.id),
          media: { blob: file, filename: file.name, compress: compressRef.current.has(file) },
        };
      });
      await onSendMedia(items);
      if (sendToken.current !== token) return;
      setPendingFiles([]);
      reset();
    } catch (err) {
      if (sendToken.current === token) setError(err.message || 'Could not save these files. They are still here.');
    } finally {
      if (sendToken.current === token) setSending(false);
    }
  };

  const reset = () => {
    setContent('');
    setMentionedIds([]);
    setMentionQuery(null);
    onCancelReply?.();
  };

  const submit = async (event) => {
    event?.preventDefault();
    const text = content.trim();
    if (!text || disabled || textSendingRef.current) return;
    textSendingRef.current = true;

    try {
      await onSend({
        content: text,
        replyToId: replyTo?.id,
        attachments: [],
        mentionedUserIds: mentionedIds,
      });
      reset();
    } catch (err) {
      setError(err.message);
    } finally {
      textSendingRef.current = false;
    }
  };

  const toggleVoiceRecording = async () => {
    if (recording && recorderRef.current) {
      const recorder = recorderRef.current;
      recorder.onstop = () => {
        const type = recorder.mimeType || 'audio/webm';
        const file = new File(recordingChunksRef.current, `voice-note-${Date.now()}.webm`, { type });
        recordingChunksRef.current = [];
        setRecording(false);
        if (file.size) setPendingFiles([file]);
      };
      recorder.stop();
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStreamRef.current = stream;
      recordingChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) recordingChunksRef.current.push(event.data); };
      recorder.start();
      setRecording(true);
    } catch {
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      setError('Microphone access is unavailable. Check your browser permission and try again.');
    }
  };

  const handleKeyDown = (event) => {
    // A composition is in flight (IME). Enter is committing a character, not
    // sending a message.
    if (event.nativeEvent?.isComposing || event.keyCode === 229) return;

    if (event.key === 'Escape' && replyTo) {
      event.preventDefault();
      onCancelReply?.();
      return;
    }
    if (event.key === 'ArrowUp' && !content && onEditLast) {
      event.preventDefault();
      onEditLast();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={submit}
      className={`relative mx-auto w-full max-w-3xl shrink-0 bg-surface px-4 pb-6 pt-2 ${className}`}
    >
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

      {!isOnline && (
        <p role="status" className="mb-2 rounded-md bg-canvas px-2.5 py-1.5 text-metadata text-muted">
          Connection unavailable. Messages will wait here until you reconnect.
        </p>
      )}

      <div className="relative flex items-end gap-2 rounded-lg border border-line bg-surface px-3 py-2 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/10">
        <div className="flex shrink-0 gap-1 pb-1">
          <button type="button" onClick={toggleVoiceRecording} disabled={disabled || sending || pendingFiles.length > 0}
            aria-label={recording ? 'Stop voice note recording' : 'Record voice note'}
            className={`grid h-8 w-8 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-40 ${recording ? 'bg-error/10 text-error' : 'text-muted hover:bg-canvas hover:text-ink'}`}>
            <IconMic className="h-5 w-5" aria-hidden="true" />
          </button>
          <AttachmentPicker
            onFiles={handleFiles}
            disabled={disabled}
            onPoll={onCreatePoll}
            onDecision={onCreateDecision}
            onTask={onCreateTask}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              const el = textareaRef.current;
              const caret = el?.selectionStart ?? content.length;
              const before = content.slice(0, caret);
              const after = content.slice(caret);

              // Insert the @ for real. The button used to just open the picker,
              // which then did nothing: applyMention looks for an `@…` token
              // before the caret, found none, and returned before inserting text
              // or recording an id — so the list opened and no mention was ever
              // made.
              //
              // Appending rather than inserting when the text does not already
              // end in a mention keeps a second press from stacking `@`s, and
              // leaves an in-progress token (`@Pr`) alone to keep filtering on.
              if (!/@[^\s@]*$/.test(before)) {
                const separator = before && !/\s$/.test(before) ? ' ' : '';
                const next = `${before}${separator}@${after}`;
                setContent(next);
                const position = caret + separator.length + 1;
                requestAnimationFrame(() => {
                  el?.setSelectionRange(position, position);
                  el?.focus();
                });
              }

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
          disabled={disabled || !content.trim()}
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

      {error && pendingFiles.length === 0 && (
        <p role="alert" className="mt-2 px-1 text-metadata text-error">
          {error}
        </p>
      )}

      <AttachmentPreviewDialog
        open={pendingFiles.length > 0}
        files={pendingFiles}
        initialCaption={content}
        sending={sending}
        error={error}
        onSend={submitPreview}
        onCancel={cancelPreview}
        onRemoveFile={removeFile}
        onReplaceFile={(index, file) => setPendingFiles((current) => current.map((item, position) => position === index ? file : item))}
      />
    </form>
  );
}
