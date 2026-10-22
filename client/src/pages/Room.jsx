import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import ForwardMessageDialog from '../components/chat/ForwardMessageDialog';
import FlagAsTaskDialog from '../components/chat/FlagAsTaskDialog';
import CreatePollDialog from '../components/chat/CreatePollDialog';
import MessageComposer from '../components/chat/MessageComposer';
import MessageTimeline from '../components/chat/MessageTimeline';
import PinnedDecisionStrip from '../components/chat/PinnedDecisionStrip';
import PinnedMessagesPanel from '../components/chat/PinnedMessagesPanel';
import PromoteToDecisionDialog from '../components/chat/PromoteToDecisionDialog';
import RoomHeader from '../components/chat/RoomHeader';
import Button from '../components/ui/Button';
import Modal from '../components/ui/Modal';
import Spinner from '../components/ui/Spinner';
import Textarea from '../components/ui/Textarea';
import { useAuth } from '../contexts/AuthContext';
import { useRealtime } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import useMessages from '../hooks/useMessages';
import { messageSummary } from '../lib/messageMeta';
import useRoom from '../hooks/useRoom';

/**
 * One conversation.
 *
 * Read state advances as timeline messages become visible, so opening a room
 * does not clear messages the reader has not reached yet.
 *
 * Edit and delete are dialogs rather than inline: an edit that turns the row
 * into a second composer breaks the grouping around it, and a delete needs a
 * confirmation the row cannot hold without shifting under the pointer.
 *
 * Promote and flag-as-task are dialogs for the same reason, and because both
 * need fields the row cannot hold — a title, an assignee, a due date. They
 * both carry the source message id back to the server, so the decision or task
 * stays linked to the message that produced it.
 */
export default function Room() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const anchorId = searchParams.get('message') || null;
  const { isConnected, socket } = useRealtime();
  const { setRoomHeader } = useOutletContext();
  const { user } = useAuth();
  const viewerId = user?.id;
  const { toast } = useToast();
  const [browserOnline, setBrowserOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const { room, isLoading: roomLoading, error: roomError } = useRoom(roomId);
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [deleting, setDeleting] = useState(null);
  const [promoting, setPromoting] = useState(null);
  const [flagging, setFlagging] = useState(null);
  const [creatingPoll, setCreatingPoll] = useState(false);
  const [forwarding, setForwarding] = useState(null);
  const [threadRoot, setThreadRoot] = useState(null);
  const [jumpTarget, setJumpTarget] = useState(null);
  const [highlightedId, setHighlightedId] = useState(null);

  const scrollContainerRef = useRef(null);

  useEffect(() => {
    const online = () => setBrowserOnline(true);
    const offline = () => setBrowserOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);

  const members = room?.members || [];
  const myRole = room?.my_role;

  const {
    messages,
    isLoading: messagesLoading,
    error: messagesError,
    hasMore,
    isLoadingOlder,
    loadOlder,
    sendMessage,
    sendMedia,
    stopTyping,
    editMessage,
    removeMessage,
    toggleReaction,
    pinMessage,
    unpinMessage,
    typingUserIds,
    recordingUserIds,
    readPointers,
    readSequences,
    deliveredSequences,
    deliveryIds,
    lastSeenSequence,
  } = useMessages(roomError && !room ? null : roomId, members, anchorId);

  useEffect(() => {
    setHighlightedId(null);
    setJumpTarget(anchorId ? { id: anchorId } : null);
  }, [roomId, anchorId]);

  useEffect(() => {
    if (!jumpTarget?.id || messagesLoading || roomLoading) return;
    const node = scrollContainerRef.current?.querySelector(`[data-message-id="${CSS.escape(String(jumpTarget.id))}"]`);
    if (!node) {
      if (messagesError || !hasMore) {
        setJumpTarget(null);
        if (!messagesError) toast({ title: 'Message unavailable', description: 'It may have been deleted or cleared on this device.', tone: 'error' });
      } else if (!isLoadingOlder) loadOlder();
      return;
    }
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedId(jumpTarget.id);
    const timer = setTimeout(() => { setHighlightedId(null); setJumpTarget(null); }, 2200);
    return () => clearTimeout(timer);
  }, [jumpTarget, messages, hasMore, isLoadingOlder, loadOlder, messagesLoading, roomLoading, messagesError, toast]);

  const jumpToMessage = (message) => {
    if (!message?.id) return;
    if (anchorId && !messages.some((item) => item.id === message.id)) {
      navigate(`/chats/${roomId}?message=${encodeURIComponent(message.id)}`);
    } else setJumpTarget(message);
  };

  // Read ticks are derived from `last_seen_at`, so the members array has to be
  // the one the socket updates. The array from GET /rooms is a snapshot from
  // page load; feeding it straight to the timeline would mean a tick that only
  // moves on a reload, which is the failure this phase exists to fix.
  const membersWithPointers = useMemo(
    () =>
      members.map((member) => ({
        ...member,
        last_seen_at: readPointers.get(member.id) || member.last_seen_at,
        last_seen_sequence: readSequences.get(member.id) ?? member.last_seen_sequence,
        last_delivered_sequence: deliveredSequences.get(member.id) ?? member.last_delivered_sequence,
      })),
    [members, readPointers, readSequences, deliveredSequences],
  );

  const handleMessageVisible = (message) => {
    if (socket?.connected && message?.id && !String(message.id).startsWith('optimistic-')) {
      socket.emit('message-read', { roomId, messageId: message.id });
    }
  };

  useEffect(() => {
    if (!room) return undefined;
    setRoomHeader(<RoomHeader room={room} isConnected={isConnected} />);
    return () => setRoomHeader(null);
  }, [room, isConnected, setRoomHeader]);

  const handleTyping = () => {
    if (socket?.connected) socket.emit('typing', { roomId });
  };

  const handleEdit = async () => {
    const text = editDraft.trim();
    if (!text) return;
    try {
      await editMessage(editing.id, text);
      setEditing(null);
    } catch (err) {
      toast({
        title: 'Edit failed',
        description: err.response?.data?.message || 'Could not save this message.',
        tone: 'error',
      });
    }
  };

  const handleDelete = async () => {
    try {
      await removeMessage(deleting.id);
      setDeleting(null);
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err.response?.data?.message || 'Could not delete this message.',
        tone: 'error',
      });
    }
  };

  // Both scopes go through the same two calls the panel makes, so a message
  // pinned from the menu and one pinned from the panel are the same request and
  // land in the same places.
  const handlePin = (message, scope) => {
    pinMessage(message.id, scope)
      .then(() => {
        toast({
          title: scope === 'room' ? 'Pinned for everyone' : 'Bookmarked',
          description:
            scope === 'room'
              ? 'It is now in the pinned messages panel.'
              : 'Only you can see this bookmark.',
          tone: 'success',
        });
      })
      .catch((err) => {
        toast({
          title: 'Pin failed',
          description: err.response?.data?.message || 'Could not pin this message.',
          tone: 'error',
        });
      });
  };

  const handleUnpin = (message, scope) => {
    unpinMessage(message.id, scope).catch((err) => {
      toast({
        title: 'Unpin failed',
        description: err.response?.data?.message || 'Could not remove this pin.',
        tone: 'error',
      });
    });
  };

  const handleToggleReaction = (message, emoji) => {
    toggleReaction(message, emoji).catch((err) => {
      toast({
        title: 'Reaction failed',
        description: err.response?.data?.message || 'Could not save that reaction.',
        tone: 'error',
      });
    });
  };

  // Both dialogs report success themselves; these callbacks are the room's
  // reaction to it. Promoting navigates to the decision, because the next
  // question after "did it work" is "let me read it back", and making the
  // reader find it on the board turns a two-step action into a hunt.
  const handlePromoted = (decision) => {
    toast({ title: 'Promoted to decision', description: decision.title, tone: 'success' });
    navigate(`/decisions/${decision.id}`);
  };

  const handleTaskCreated = (task) => {
    toast({ title: 'Task created', description: task.title, tone: 'success' });
  };

  if (roomLoading) return <Spinner label="Opening room" />;

  if (roomError && !room) {
    return (
      <p role="alert" className="m-6 rounded-lg bg-error/10 p-4 text-body text-error">
        {roomError}
      </p>
    );
  }

  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] bg-surface">
      {/*
        Rows are addressed explicitly rather than by source order.
        PinnedDecisionStrip returns null for any room with no pins, and a null
        child is not a grid item — so auto-placement renumbered the remaining
        two, putting the composer in the `1fr` row and the scroller in `auto`.
        With no messages the scroller then collapsed to the empty state's
        min-h-48 and the composer stretched over everything below it, floating
        its own content at the top. Pinning row-start means the layout is the
        same whether or not there are pins.

        `minmax(0, 1fr)` rather than `1fr`: a bare `1fr` floors at `auto`, so a
        long transcript can push the row open past the pane. 0 is the same guard
        as `min-h-0` on the scroller, stated on the track itself.
      */}
      {/* Row-start on both, for the reason in the note below: a null child is
          not a grid item, so auto-placement would renumber the rows when either
          strip is empty. */}
      <div className="row-start-1 min-w-0">
        {anchorId && <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2 text-metadata text-muted" role="status">
          <span>Viewing a shared message</span>
          <Button variant="ghost" onClick={() => navigate(`/chats/${roomId}`, { replace: true })}>Return to latest</Button>
        </div>}
        <PinnedMessagesPanel
          roomId={roomId}
          isAdmin={myRole === 'admin'}
          viewerId={viewerId}
          onJumpToMessage={jumpToMessage}
        />
        <PinnedDecisionStrip roomId={roomId} />
      </div>

        <div
          ref={scrollContainerRef}
          className="row-start-2 min-h-0 overflow-y-auto overscroll-contain [overflow-anchor:none]"
        >
        {/* Catch-up belongs to the cross-room digest. Room read pointers move
            as individual messages enter the viewport. */}
        {messagesLoading ? (
          <Spinner label="Loading messages" />
        ) : messagesError && !messages.length ? (
          <p
            role="alert"
            className="mx-4 mt-5 rounded-lg bg-error/10 p-4 text-body text-error md:mx-2"
          >
            {messagesError}
          </p>
        ) : (
          <MessageTimeline
            messages={messages}
            scrollContainerRef={scrollContainerRef}
            viewerId={viewerId}
            members={membersWithPointers}
            isAdmin={myRole === 'admin'}
            roomId={roomId}
            deliveryIds={deliveryIds}
            typingUserIds={typingUserIds}
            recordingUserIds={recordingUserIds}
            hasMore={hasMore}
            isLoadingOlder={isLoadingOlder}
            onLoadOlder={loadOlder}
            onReply={setReplyTo}
            onEdit={(message) => {
              setEditing(message);
              setEditDraft(message.content || '');
            }}
            onDelete={setDeleting}
            onPromote={setPromoting}
            onFlagTask={setFlagging}
            onToggleReaction={handleToggleReaction}
            onPin={handlePin}
            onUnpin={handleUnpin}
            lastSeenSequence={lastSeenSequence}
            onMessageVisible={handleMessageVisible}
            onOpenThread={setThreadRoot}
            onForward={setForwarding}
            onJumpToMessage={jumpToMessage}
            highlightedId={highlightedId}
          />
        )}
      </div>

      <MessageComposer
        className="row-start-3"
        onEditLast={() => {
          const last = [...messages].reverse().find((message) => message.sender_id === viewerId && !message.is_deleted && !message._optimistic);
          if (last) { setEditing(last); setEditDraft(last.content || ''); }
        }}
        onSend={async (payload) => { await sendMessage(payload); if (anchorId) navigate(`/chats/${roomId}`, { replace: true }); }}
        onSendMedia={async (items) => { await sendMedia(items); if (anchorId) navigate(`/chats/${roomId}`, { replace: true }); }}
        isOnline={browserOnline && isConnected}
        onCreatePoll={() => setCreatingPoll(true)}
        onCreateDecision={() => setPromoting({ manual: true })}
        onCreateTask={() => setFlagging({ manual: true })}
        members={members}
        activityScope={roomId}
        onTyping={handleTyping}
        onStopTyping={stopTyping}
        onRecording={() => { if (socket?.connected) socket.emit('start-recording', { roomId }); }}
        onStopRecording={() => { if (socket?.connected) socket.emit('stop-recording', { roomId }); }}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />

      <ForwardMessageDialog message={forwarding} onClose={() => setForwarding(null)} />

      {threadRoot && (
        <aside role="complementary" aria-label="Message thread" className="fixed inset-x-0 bottom-16 top-16 z-40 flex flex-col border-l border-line bg-surface shadow-modal md:bottom-0 md:left-auto md:w-[min(400px,40vw)]">
          <header className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <h2 className="text-h2 text-ink">Thread</h2>
              <p className="text-metadata text-muted">{messages.filter((message) => message.reply_to_id === threadRoot.id).length} replies</p>
            </div>
            <button type="button" onClick={() => setThreadRoot(null)} aria-label="Close thread" className="rounded-lg px-3 py-2 text-label text-muted hover:bg-canvas">Close</button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <article className="rounded-xl bg-canvas p-3">
              <p className="text-metadata font-medium text-muted">{threadRoot.sender_name || 'Member'}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-body text-ink">{messageSummary(threadRoot)}</p>
            </article>
            <div className="my-4 border-t border-line" />
            <div className="space-y-3">
              {messages.filter((message) => message.reply_to_id === threadRoot.id).map((message) => (
                <article key={message.id} className="rounded-xl border border-line p-3">
                  <p className="text-metadata font-medium text-muted">{message.sender_name || 'Member'}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-body text-ink">{messageSummary(message)}</p>
                </article>
              ))}
            </div>
          </div>
          <div className="border-t border-line p-3">
            <button type="button" onClick={() => { setReplyTo(threadRoot); setThreadRoot(null); }} className="w-full rounded-lg bg-brand px-4 py-2.5 text-label font-semibold text-surface">Reply in thread</button>
          </div>
        </aside>
      )}

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title="Edit message"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleEdit} disabled={!editDraft.trim()}>
              Save
            </Button>
          </>
        }
      >
        <Textarea
          value={editDraft}
          onChange={(event) => setEditDraft(event.target.value)}
          rows={4}
          aria-label="Message text"
        />
        <p className="mt-2 text-metadata text-muted">An edited message keeps its original time.</p>
      </Modal>

      <Modal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete message"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleDelete}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-body text-ink">
          This replaces the message with “Message deleted” for everyone in the room.
        </p>
      </Modal>

      <PromoteToDecisionDialog
        open={Boolean(promoting)}
        onClose={() => setPromoting(null)}
        message={promoting}
        roomId={roomId}
        onPromoted={handlePromoted}
      />

      <FlagAsTaskDialog
        open={Boolean(flagging)}
        onClose={() => setFlagging(null)}
        message={flagging}
        roomId={roomId}
        members={members}
        onCreated={handleTaskCreated}
      />

      <CreatePollDialog
        open={creatingPoll}
        onClose={() => setCreatingPoll(false)}
        roomId={roomId}
      />
    </section>
  );
}
