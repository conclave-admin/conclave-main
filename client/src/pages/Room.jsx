import { useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import CatchUpDigest from '../components/chat/CatchUpDigest';
import MessageComposer from '../components/chat/MessageComposer';
import MessageTimeline from '../components/chat/MessageTimeline';
import PinnedDecisionStrip from '../components/chat/PinnedDecisionStrip';
import RoomHeader from '../components/chat/RoomHeader';
import Button from '../components/ui/Button';
import Modal from '../components/ui/Modal';
import Spinner from '../components/ui/Spinner';
import Textarea from '../components/ui/Textarea';
import { useAuth } from '../contexts/AuthContext';
import { useChats } from '../contexts/ChatsContext';
import { useRealtime } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import useMessages from '../hooks/useMessages';
import useRoom from '../hooks/useRoom';

/**
 * One conversation.
 *
 * Marking the room read lives here rather than on the list row's click
 * handler, because the click handler is not the only way in. The rail, a deep
 * link, the browser's back button and a future notification all land on this
 * component, and a badge that only clears when the pointer happens to be the
 * thing that navigated is a badge that is usually wrong.
 *
 * The optimistic zero in `markSeen` means the badge disappears the instant the
 * room opens, before the request completes — which is the behaviour you want,
 * and safe because the server's answer is not in doubt.
 *
 * Edit and delete are dialogs rather than inline: an edit that turns the row
 * into a second composer breaks the grouping around it, and a delete needs a
 * confirmation the row cannot hold without shifting under the pointer.
 */
export default function Room() {
  const { roomId } = useParams();
  const { isConnected, socket } = useRealtime();
  const { setRoomHeader } = useOutletContext();
  const { markSeen } = useChats();
  const { user } = useAuth();
  const viewerId = user?.id;
  const { toast } = useToast();
  const { room, isLoading: roomLoading, error: roomError } = useRoom(roomId);
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [deleting, setDeleting] = useState(null);

  const scrollContainerRef = useRef(null);

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
    stopTyping,
    editMessage,
    removeMessage,
    toggleReaction,
    typingUserIds,
    readPointers,
    deliveryIds,
  } = useMessages(roomId, members);

  // Read ticks are derived from `last_seen_at`, so the members array has to be
  // the one the socket updates. The array from GET /rooms is a snapshot from
  // page load; feeding it straight to the timeline would mean a tick that only
  // moves on a reload, which is the failure this phase exists to fix.
  const membersWithPointers = useMemo(
    () =>
      members.map((member) => ({
        ...member,
        last_seen_at: readPointers.get(member.id) || member.last_seen_at,
      })),
    [members, readPointers],
  );

  useEffect(() => {
    markSeen(roomId);
  }, [roomId, markSeen]);

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

  const handleToggleReaction = (message, emoji) => {
    toggleReaction(message, emoji).catch((err) => {
      toast({
        title: 'Reaction failed',
        description: err.response?.data?.message || 'Could not save that reaction.',
        tone: 'error',
      });
    });
  };

  if (roomLoading) return <Spinner label="Opening room" />;

  if (roomError) {
    return (
      <p role="alert" className="m-6 rounded-lg bg-error/10 p-4 text-body text-error">
        {roomError}
      </p>
    );
  }

  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_1fr_auto] bg-surface">
      <PinnedDecisionStrip roomId={roomId} />

      <div
        ref={scrollContainerRef}
        className="min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <CatchUpDigest />
        {messagesLoading ? (
          <Spinner label="Loading messages" />
        ) : messagesError ? (
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
            hasMore={hasMore}
            isLoadingOlder={isLoadingOlder}
            onLoadOlder={loadOlder}
            onReply={setReplyTo}
            onEdit={(message) => {
              setEditing(message);
              setEditDraft(message.content || '');
            }}
            onDelete={setDeleting}
            onToggleReaction={handleToggleReaction}
          />
        )}
      </div>

      <MessageComposer
        disabled={!isConnected}
        onSend={sendMessage}
        members={members}
        onTyping={handleTyping}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />

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
    </section>
  );
}
