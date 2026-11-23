import IconPlay from "@/assets/icons/play-recording.svg?react";
import { LiveRecordingWaveform } from "./AudioWaveform";
import { recordingGesture } from "../../lib/waveform";
import IconDelete from "@/assets/icons/delete.svg?react";
import { ScheduleMessage } from "./MessageLater";
import { useAuth } from "../../contexts/AuthContext";
import { readDraft, writeDraft } from "../../lib/drafts";
import { voiceRecordingFile, voiceRecorderOptions } from "@/lib/voiceRecording";
import { createActivitySender } from "@/lib/conversationActivity";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import IconClose from "@/assets/icons/close.svg?react";
import IconSend from "@/assets/icons/send.svg?react";
import IconMic from "@/assets/icons/mic.svg?react";
import IconReaction from "@/assets/icons/reaction.svg?react";
import { createClientId } from "@/lib/outbox";
import PopoverMenu from "@/components/ui/PopoverMenu";
import {
  isAccepted,
  isImage,
  isVideo,
  limitFor,
  MAX_ATTACHMENTS,
  normaliseFile,
} from "@/lib/media";
import { MAX_VIDEO_INPUT_BYTES } from "@/lib/videoCompression";
import AttachmentPicker from "./AttachmentPicker";
import AttachmentPreviewDialog from "./AttachmentPreviewDialog";
import MentionPicker from "./MentionPicker";
import EmojiPicker from "./EmojiPicker";

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
 * @param {boolean} disabled - conversation permissions prevent sending
 * @param {(payload: object) => void} onSend
 * @param {Array} members - room members, for the mention picker
 * @param {() => void} onTyping - emits a typing event, throttled by this composer
 * @param {object|null} replyTo - message being replied to
 * @param {() => void} onCancelReply
 * @param {() => void} [onCreatePoll] - opens the poll dialog when supplied
 * @param {() => void} [onCreateDecision] - opens the decision dialog when supplied
 * @param {() => void} [onCreateTask] - opens the task dialog when supplied
 */
const MessageComposer = forwardRef(function MessageComposer(
  {
    disabled,
    isOnline = true,
    onSend,
    onSendMedia,
    members = [],
    onTyping,
    onStopTyping,
    onRecording,
    onStopRecording,
    activityScope,
    replyTo,
    onCancelReply,
    onCreatePoll,
    onCreateDecision,
    onCreateTask,
    onEditLast,
    // The room pane is a grid and addresses its rows explicitly, so the composer
    // needs to accept the placement the parent decides rather than hardcoding one.
    className = "",
  },
  ref,
) {
  const { user: draftUser } = useAuth();
  const draftOwner = `${draftUser?.id}:${activityScope}`;
  const [content, setContent] = useState(
    () => readDraft(draftUser?.id, activityScope).text,
  );
  const draftSnapshot = useRef({
    owner: draftOwner,
    userId: draftUser?.id,
    roomId: activityScope,
    text: content,
    reply: replyTo,
  });
  if (draftSnapshot.current.owner === draftOwner) {
    draftSnapshot.current = {
      owner: draftOwner,
      userId: draftUser?.id,
      roomId: activityScope,
      text: content,
      reply: replyTo,
    };
  }
  const persistDraft = () => {
    const { userId, roomId, text, reply } = draftSnapshot.current;
    writeDraft(
      userId,
      roomId,
      text,
      reply
        ? {
            id: reply.id,
            sender_name: reply.sender_name,
            content: reply.content,
            room_sequence: reply.room_sequence,
            created_at: reply.created_at,
            expires_at: reply.expires_at,
          }
        : null,
    );
  };
  useLayoutEffect(() => {
    const draft = readDraft(draftUser?.id, activityScope);
    draftSnapshot.current = {
      owner: draftOwner,
      userId: draftUser?.id,
      roomId: activityScope,
      text: draft.text,
      reply: draft.reply,
    };
    setContent(draft.text);
    selectionRef.current = { start: draft.text.length, end: draft.text.length };
    return () => {
      persistDraft();
    };
  }, [draftOwner]);
  useEffect(() => {
    const saveOnExit = () => persistDraft();
    window.addEventListener("pagehide", saveOnExit);
    return () => window.removeEventListener("pagehide", saveOnExit);
  }, [draftOwner]);
  const [error, setError] = useState("");
  const [pendingFiles, setPendingFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState(null);
  const [mentionedIds, setMentionedIds] = useState([]);
  const [recording, setRecording] = useState(false);
  const [voicePaused, setVoicePaused] = useState(false);
  const [voiceLocked, setVoiceLocked] = useState(false);
  const voiceDisposition = useRef({});
  const voicePointer = useRef(null);
  const holdTimer = useRef(null);
  const ignoreVoiceClick = useRef(false);
  const [emojiOpen, setEmojiOpen] = useState(false);

  const textareaRef = useRef(null);
  useEffect(() => {
    // Desktop chat apps put typing one keystroke away. On touch screens,
    // opening the keyboard immediately would hide the conversation instead.
    if (
      !disabled &&
      window.matchMedia("(min-width: 768px) and (pointer: fine)").matches
    )
      textareaRef.current?.focus({ preventScroll: true });
  }, [activityScope, disabled]);
  const emojiTriggerRef = useRef(null);
  const selectionRef = useRef({ start: content.length, end: content.length });
  const callbacks = useMemo(() => ({ current: null }), [activityScope]);
  callbacks.current = { onTyping, onStopTyping, onRecording, onStopRecording };
  const activityRef = useRef(null);
  const signalFlags = useRef({ disabled, isOnline });
  signalFlags.current = { disabled, isOnline };
  const captureVersion = useRef(0);
  const acquiringMic = useRef(false);
  const stopVoiceRef = useRef(null);
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
    el.style.height = "auto";
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * MAX_LINES)}px`;
  }, [content]);

  useEffect(() => {
    setRecording(false);
    const sender = createActivitySender({
      typing: () => callbacks.current.onTyping?.(),
      stopTyping: () => callbacks.current.onStopTyping?.(),
      recording: () => callbacks.current.onRecording?.(),
      stopRecording: () => callbacks.current.onStopRecording?.(),
      canSignal: () =>
        !signalFlags.current.disabled &&
        signalFlags.current.isOnline &&
        document.visibilityState === "visible" &&
        document.hasFocus(),
    });
    activityRef.current = sender;
    const suspend = (event) => {
      sender.stop();
      if (recorderRef.current && recorderRef.current.state !== "inactive")
        stopVoiceRef.current?.();
      else if (
        document.visibilityState !== "visible" ||
        event?.type === "pagehide"
      ) {
        captureVersion.current++;
        acquiringMic.current = false;
      }
    };
    const visibility = () => {
      if (document.visibilityState !== "visible") suspend();
    };
    window.addEventListener("blur", suspend);
    window.addEventListener("pagehide", suspend);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      sender.dispose();
      clearTimeout(holdTimer.current);
      voicePointer.current = null;
      captureVersion.current++;
      acquiringMic.current = false;
      if (recorderRef.current) {
        recorderRef.current.onstop = null;
        recorderRef.current.ondataavailable = null;
        if (recorderRef.current.state !== "inactive")
          recorderRef.current.stop();
      }
      recorderRef.current = null;
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      window.removeEventListener("blur", suspend);
      window.removeEventListener("pagehide", suspend);
      document.removeEventListener("visibilitychange", visibility);
    };
    // Capture callbacks for this conversation so cleanup targets the old room.
  }, [activityScope, callbacks]);
  useEffect(() => {
    if (disabled && recording) stopVoiceRef.current?.();
    if (disabled || !isOnline) activityRef.current?.stop();
    else if (recording && !voicePaused) activityRef.current?.startRecording();
    else if (voicePaused) activityRef.current?.endRecording();
  }, [disabled, isOnline, recording, voicePaused]);

  const handleTextChange = (event) => {
    const { value, selectionStart, selectionEnd } = event.target;
    selectionRef.current = { start: selectionStart, end: selectionEnd };
    setContent(value);
    setError("");
    activityRef.current?.textChanged(value);

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

  const insertEmoji = (emoji) => {
    const { start, end } = selectionRef.current;
    const next = `${content.slice(0, start)}${emoji}${content.slice(end)}`;
    const caret = start + emoji.length;
    selectionRef.current = { start: caret, end: caret };
    setContent(next);
    setError("");
    setMentionQuery(null);
    setMentionedIds((current) =>
      current.filter((id) => {
        const person = members.find((member) => member.id === id);
        return person && next.includes(`@${person.display_name}`);
      }),
    );
    activityRef.current?.textChanged(next);
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  };

  useEffect(() => setEmojiOpen(false), [activityScope]);

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
    setMentionedIds((prev) =>
      prev.includes(member.id) ? prev : [...prev, member.id],
    );

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
  const handleFiles = (files, { compress = false, append = false } = {}) => {
    const rejected = [];
    const accepted = [];

    for (const raw of files) {
      const file = normaliseFile(raw);
      const limit = limitFor(file);
      const inputLimit = isVideo(file) ? MAX_VIDEO_INPUT_BYTES : limit;

      if (file.size > inputLimit) {
        rejected.push(
          `"${file.name}" is larger than the ${inputLimit / (1024 * 1024)}MB selection limit. Trim or resize it before selecting.`,
        );
      } else if (!isAccepted(file.type, file.name)) {
        rejected.push(`"${file.name}" is not a file type this app can store.`);
      } else {
        if (compress && isImage(file)) compressRef.current.add(file);
        accepted.push(file);
      }
    }

    const available = append
      ? Math.max(0, MAX_ATTACHMENTS - pendingFiles.length)
      : MAX_ATTACHMENTS;
    if (accepted.length > available) {
      rejected.push(
        `You can select at most ${MAX_ATTACHMENTS} files at once; the extra ${
          accepted.length - available
        } were not added.`,
      );
      accepted.length = available;
    }

    const note = rejected.join(" ");
    setError(note);

    if (accepted.length > 0) {
      setPendingFiles(append ? [...pendingFiles, ...accepted] : accepted);
    }
  };

  // Lets a drop zone outside this component (the conversation pane, in
  // Room.jsx) reuse the exact same validation/compression/preview path a
  // picked or pasted file goes through, instead of a second, divergent one.
  useImperativeHandle(ref, () => ({
    addFiles: (files, options) => handleFiles(files, options),
  }));

  const removeFile = (index) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
    setError("");
  };

  const cancelPreview = () => {
    if (sending) return;
    sendToken.current += 1;
    setPendingFiles([]);
    setError("");
  };

  // Persist the whole selection before closing the editor. Upload work belongs
  // to the account outbox, so offline sends and navigation cannot lose files.
  const submitPreview = async (captions) => {
    if (sending || !pendingFiles.length) return;
    const token = ++sendToken.current;
    setSending(true);
    setError("");
    try {
      const albumId = pendingFiles.length > 1 ? createClientId() : undefined;
      const items = pendingFiles.map((file, index) => {
        const caption = (captions[index] || "").trim();
        return {
          content: caption,
          albumId,
          replyToId: index === 0 ? replyTo?.id : undefined,
          attachments: [],
          mentionedUserIds: members
            .filter((person) => caption.includes(`@${person.display_name}`))
            .map((person) => person.id),
          media: {
            blob: file,
            filename: file.name,
            compress: compressRef.current.has(file),
          },
        };
      });
      activityRef.current?.endTyping();
      await onSendMedia(items);
      if (sendToken.current !== token) return;
      setPendingFiles([]);
      reset();
    } catch (err) {
      if (sendToken.current === token)
        setError(
          err.message || "Could not save these files. They are still here.",
        );
    } finally {
      if (sendToken.current === token) setSending(false);
    }
  };

  const reset = () => {
    activityRef.current?.endTyping();
    draftSnapshot.current = {
      owner: draftOwner,
      userId: draftUser?.id,
      roomId: activityScope,
      text: "",
      reply: null,
    };
    writeDraft(draftUser?.id, activityScope, "");
    setContent("");
    selectionRef.current = { start: 0, end: 0 };
    setMentionedIds([]);
    setMentionQuery(null);
    onCancelReply?.();
  };

  const submit = async (event) => {
    event?.preventDefault();
    const text = content.trim();
    if (!text || disabled || textSendingRef.current) return;
    activityRef.current?.endTyping();
    textSendingRef.current = true;

    try {
      await onSend({
        content: text,
        broadcastMention: text.match(/(?:^|\s)@(here|channel)\b/)?.[1],
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
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      finishVoice();
      return;
    }
    if (acquiringMic.current || disabled) return;
    acquiringMic.current = true;
    const version = ++captureVersion.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (version === captureVersion.current) acquiringMic.current = false;
      if (
        version !== captureVersion.current ||
        signalFlags.current.disabled ||
        document.visibilityState !== "visible"
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      voiceDisposition.current = {};
      setVoicePaused(false);
      recordingStreamRef.current = stream;
      const chunks = [];
      recordingChunksRef.current = chunks;
      const recorder = new MediaRecorder(
        stream,
        voiceRecorderOptions(MediaRecorder),
      );
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
        if (
          chunks.reduce((size, chunk) => size + chunk.size, 0) >
            25 * 1024 * 1024 &&
          recorder.state !== "inactive"
        ) {
          failed = true;
          recorder.stop();
          setError(
            "Voice note reached the 25 MB limit. Please record a shorter message.",
          );
        }
      };
      let failed = false;
      recorder.onstop = () => {
        if (version !== captureVersion.current) return;
        activityRef.current?.endRecording();
        setRecording(false);
        if (recorderRef.current === recorder) recorderRef.current = null;
        if (recordingStreamRef.current === stream) {
          stream.getTracks().forEach((track) => track.stop());
          recordingStreamRef.current = null;
        }
        recordingChunksRef.current = [];
        setVoicePaused(false);
        setVoiceLocked(false);
        if (!failed && !voiceDisposition.current.cancel) {
          try {
            const file = voiceRecordingFile(chunks, recorder.mimeType);
            if (file.size > limitFor(file)) {
              setError("Voice note is too large. Record a shorter message.");
              return;
            }
            if (file.size && voiceDisposition.current.send) {
              setSending(true);
              Promise.resolve()
                .then(() =>
                  onSendMedia([
                    {
                      content: "",
                      replyToId: replyTo?.id,
                      attachments: [],
                      mentionedUserIds: [],
                      media: {
                        blob: file,
                        filename: file.name,
                        compress: false,
                      },
                    },
                  ]),
                )
                .then(() => {
                  if (version === captureVersion.current) onCancelReply?.();
                })
                .catch((error) => {
                  if (version === captureVersion.current) {
                    setPendingFiles([file]);
                    setError(
                      error.message ||
                        "Could not send. Your voice note is ready to retry.",
                    );
                  }
                })
                .finally(() => {
                  if (version === captureVersion.current) setSending(false);
                });
            } else if (file.size) setPendingFiles([file]);
          } catch (error) {
            setError(error.message);
          }
        }
      };
      recorder.onerror = () => {
        if (version !== captureVersion.current) return;
        failed = true;
        if (recorder.state !== "inactive") recorder.stop();
        else recorder.onstop();
        activityRef.current?.endRecording();
        setError(
          "Voice recording stopped because the microphone or recorder became unavailable.",
        );
      };
      for (const track of stream.getTracks())
        track.addEventListener?.("ended", () => {
          if (
            version === captureVersion.current &&
            recorder.state !== "inactive"
          )
            stopVoiceRef.current?.();
        });
      recorder.start(500);
      activityRef.current?.startRecording();
      setRecording(true);
    } catch {
      if (version !== captureVersion.current) return;
      acquiringMic.current = false;
      activityRef.current?.endRecording();
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      setError(
        "Microphone access is unavailable. Check your browser permission and try again.",
      );
    }
  };

  const finishVoice = ({ cancel = false, send = false } = {}) => {
    voiceDisposition.current = { cancel, send };
    clearTimeout(holdTimer.current);
    if (acquiringMic.current && !recorderRef.current) {
      captureVersion.current++;
      acquiringMic.current = false;
      setVoiceLocked(false);
      return;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    activityRef.current?.endRecording();
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
  };
  const pauseVoice = () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      recorder.pause();
      setVoicePaused(true);
      activityRef.current?.endRecording();
    } else if (recorder?.state === "paused") {
      recorder.resume();
      setVoicePaused(false);
      activityRef.current?.startRecording();
    }
  };
  const voicePointerDown = (event) => {
    if (recording) {
      ignoreVoiceClick.current = false;
      return;
    }
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    voicePointer.current = {
      x: event.clientX,
      y: event.clientY,
      held: false,
      locked: false,
    };
    ignoreVoiceClick.current = true;
    holdTimer.current = setTimeout(() => {
      if (!voicePointer.current) return;
      voicePointer.current.held = true;
      setVoiceLocked(false);
      toggleVoiceRecording();
    }, 220);
  };
  const voicePointerMove = (event) => {
    const gesture = voicePointer.current;
    if (!gesture?.held || gesture.locked) return;
    const action = recordingGesture(
      event.clientX - gesture.x,
      event.clientY - gesture.y,
    );
    if (action === "cancel") {
      voicePointer.current = null;
      finishVoice({ cancel: true });
    } else if (action === "lock") {
      gesture.locked = true;
      setVoiceLocked(true);
    }
  };
  const voicePointerUp = () => {
    clearTimeout(holdTimer.current);
    const gesture = voicePointer.current;
    voicePointer.current = null;
    if (!gesture) return;
    if (!gesture.held) {
      setVoiceLocked(true);
      toggleVoiceRecording();
    } else if (!gesture.locked) finishVoice({ send: true });
  };
  stopVoiceRef.current = () => {
    voicePointer.current = null;
    finishVoice();
  };

  const handleKeyDown = (event) => {
    // A composition is in flight (IME). Enter is committing a character, not
    // sending a message.
    if (event.nativeEvent?.isComposing || event.keyCode === 229) return;

    if (event.key === "Escape" && replyTo) {
      event.preventDefault();
      onCancelReply?.();
      return;
    }
    if (event.key === "ArrowUp" && !content && onEditLast) {
      event.preventDefault();
      onEditLast();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const handlePaste = (event) => {
    const items = Array.from(event.clipboardData?.items || []);
    const pastedFiles = items
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
    const files = (
      pastedFiles.length
        ? pastedFiles
        : Array.from(event.clipboardData?.files || [])
    ).map((file, index) =>
      file.name
        ? file
        : new File(
            [file],
            `pasted-file-${index + 1}${file.type === "image/png" ? ".png" : ""}`,
            { type: file.type },
          ),
    );
    if (!files.length) return;
    event.preventDefault();
    if (disabled) return;
    const text = event.clipboardData.getData("text/plain");
    if (text) {
      const { start, end } = selectionRef.current;
      const next = `${content.slice(0, start)}${text}${content.slice(end)}`;
      selectionRef.current = {
        start: start + text.length,
        end: start + text.length,
      };
      setContent(next);
      activityRef.current?.textChanged(next);
    }
    handleFiles(files, { compress: true });
  };

  return (
    <form
      onSubmit={submit}
      onBlurCapture={(event) => {
        const form = event.currentTarget;
        if (form.contains(event.relatedTarget)) return;
        requestAnimationFrame(() => {
          if (!form.contains(document.activeElement)) persistDraft();
        });
      }}
      className={`message-composer relative mx-auto w-full max-w-4xl shrink-0 px-0 py-0 ${className}`}
    >
      {replyTo && (
        <div className="mb-2 flex items-center gap-3 rounded-lg border-l-2 border-brand bg-canvas px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-metadata text-brand">
              Replying to {replyTo.sender_name || "a message"}
            </p>
            <p className="truncate text-metadata text-muted">
              {replyTo.content ||
                (replyTo.is_deleted ? "deleted message" : "attachment")}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancelReply}
            aria-label="Cancel reply"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <IconClose className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {!isOnline && (
        <p
          role="status"
          className="mb-2 rounded-md bg-canvas px-2.5 py-1.5 text-metadata text-muted"
        >
          Connection unavailable. Messages will wait here until you reconnect.
        </p>
      )}

      <div className="composer-pill relative flex items-end gap-1 rounded-[26px] border border-line bg-surface p-1.5 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/10">
        <div
          className={`${recording ? "hidden" : "flex"} shrink-0 items-center gap-0.5`}
        >
          <AttachmentPicker
            onFiles={handleFiles}
            disabled={disabled}
            onPoll={onCreatePoll}
            onDecision={onCreateDecision}
            onTask={onCreateTask}
            onMention={() => {
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
                const separator = before && !/\s$/.test(before) ? " " : "";
                const next = `${before}${separator}@${after}`;
                setContent(next);
                const position = caret + separator.length + 1;
                requestAnimationFrame(() => {
                  el?.setSelectionRange(position, position);
                  el?.focus();
                });
              }

              textareaRef.current?.focus();
              setMentionQuery("");
            }}
          />
          <button
            ref={emojiTriggerRef}
            type="button"
            disabled={disabled}
            onClick={() => {
              const input = textareaRef.current;
              if (input)
                selectionRef.current = {
                  start: input.selectionStart,
                  end: input.selectionEnd,
                };
              setEmojiOpen((open) => !open);
            }}
            aria-label="Insert emoji"
            aria-haspopup="dialog"
            aria-expanded={emojiOpen}
            className="grid h-11 w-11 place-items-center rounded-full text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-40"
          >
            <IconReaction className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <textarea
          disabled={disabled}
          ref={textareaRef}
          value={content}
          onChange={handleTextChange}
          onSelect={(event) => {
            selectionRef.current = {
              start: event.target.selectionStart,
              end: event.target.selectionEnd,
            };
          }}
          onBlur={() => activityRef.current?.endTyping()}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="Message…"
          aria-label="Message"
          className={`${recording ? "hidden" : "block"} min-h-10 min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-2 text-body text-ink outline-none placeholder:text-muted`}
        />

        {recording && (
          <div className="flex min-h-11 min-w-0 flex-1 items-center gap-1 px-1">
            <button
              type="button"
              aria-label="Discard recording"
              onClick={() => finishVoice({ cancel: true })}
              className="voice-control text-error"
            >
              <IconDelete className="h-5 w-5" aria-hidden="true" />
            </button>
            <LiveRecordingWaveform
              stream={recordingStreamRef.current}
              paused={voicePaused}
            />
            {voiceLocked && (
              <>
                <button
                  type="button"
                  aria-label={
                    voicePaused ? "Resume recording" : "Pause recording"
                  }
                  onClick={pauseVoice}
                  className="voice-control text-brand"
                >
                  {voicePaused ? (
                    <IconPlay className="h-5 w-5" aria-hidden="true" />
                  ) : (
                    <span className="flex gap-1" aria-hidden="true">
                      <span className="h-4 w-1 rounded-sm bg-current" />
                      <span className="h-4 w-1 rounded-sm bg-current" />
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label="Send voice note"
                  onClick={() => finishVoice({ send: true })}
                  className="voice-control bg-brand text-white"
                >
                  <IconSend className="h-5 w-5" aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        )}
        {recording && !voiceLocked && (
          <span className="pointer-events-none absolute -top-8 right-2 rounded-full bg-surface px-3 py-1 text-xs text-muted shadow">
            ← Cancel · ↑ Lock
          </span>
        )}
        {content.trim() && !recording ? (
          <button
            type="submit"
            disabled={disabled || sending || !content.trim()}
            aria-label="Send message"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand pb-0.5 text-white transition-opacity disabled:opacity-40"
          >
            <IconSend className="h-5 w-5" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onPointerDown={voicePointerDown}
            onPointerMove={voicePointerMove}
            onPointerUp={voicePointerUp}
            onPointerCancel={() => {
              clearTimeout(holdTimer.current);
              const locked = voicePointer.current?.locked;
              voicePointer.current = null;
              if (!locked) finishVoice({ cancel: true });
            }}
            onClick={(event) => {
              if (ignoreVoiceClick.current && event.detail !== 0) {
                ignoreVoiceClick.current = false;
                return;
              }
              ignoreVoiceClick.current = false;
              if (!recording) setVoiceLocked(true);
              toggleVoiceRecording();
            }}
            title={
              recording
                ? "Stop and preview"
                : "Tap to record · Hold for a quick voice note"
            }
            style={{ touchAction: "none" }}
            disabled={disabled || sending || pendingFiles.length > 0}
            aria-label={
              recording ? "Stop voice note recording" : "Record voice note"
            }
            className={`grid h-11 w-11 place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-40 ${recording ? "bg-error/10 text-error" : "text-muted hover:bg-canvas hover:text-ink"}`}
          >
            {recording ? (
              <span
                className="h-3.5 w-3.5 rounded-sm bg-current"
                aria-hidden="true"
              />
            ) : (
              <IconMic className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
        )}

        {mentionQuery !== null && (
          <MentionPicker
            members={members}
            query={mentionQuery}
            onSelect={applyMention}
            onDismiss={() => setMentionQuery(null)}
          />
        )}
      </div>

      <PopoverMenu
        open={emojiOpen}
        onClose={() => setEmojiOpen(false)}
        triggerRef={emojiTriggerRef}
        side="top"
        align="start"
        label="Choose an emoji"
        popupRole="dialog"
        className="w-[min(352px,calc(100vw-16px))] max-h-[calc(100dvh-16px)] overflow-y-auto"
      >
        <EmojiPicker onPick={insertEmoji} />
      </PopoverMenu>

      {!disabled &&
        !pendingFiles.length &&
        /^[0-9a-f-]{36}$/i.test(activityScope || "") &&
        content.trim() && (
          <ScheduleMessage
            room={{ id: activityScope }}
            text={content}
            onScheduled={reset}
          />
        )}
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
        sendDisabled={disabled}
        error={error}
        onSend={submitPreview}
        onCancel={cancelPreview}
        onRemoveFile={removeFile}
        onAddFiles={(files) =>
          handleFiles(files, { compress: true, append: true })
        }
        onReplaceFile={(index, file) =>
          setPendingFiles((current) =>
            current.map((item, position) => (position === index ? file : item)),
          )
        }
      />
    </form>
  );
});

export default MessageComposer;
