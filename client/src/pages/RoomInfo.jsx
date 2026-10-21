import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import IconMoreVertical from '@/assets/icons/more-vertical.svg?react';
import IconSearch from '@/assets/icons/search.svg?react';
import IconCalendar from '@/assets/icons/calendar.svg?react';
import IconMember from '@/assets/icons/member.svg?react';
import IconCamera from '@/assets/icons/camera.svg?react';
import Avatar from '@/components/ui/Avatar';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import Input from '@/components/ui/Input';
import PopoverMenu from '@/components/ui/PopoverMenu';
import Spinner from '@/components/ui/Spinner';
import Textarea from '@/components/ui/Textarea';
import useRoom from '@/hooks/useRoom';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import { useToast } from '@/contexts/ToastContext';
import { addMember, createRoom, removeMember, setMemberRole, updateRoom } from '@/services/rooms.service';
import { blockUser, getBlockStatus, getSharedRooms, reportUser, searchUsers, unblockUser, uploadAvatar } from '@/services/users.service';
import SharedMediaBrowser from '@/components/chat/SharedMediaBrowser';
import { clearConversationForMe } from '@/lib/clearedConversations';
import Modal from '@/components/ui/Modal';
import Page from '@/components/layout/Page';
import { usePresence } from '@/contexts/PresenceContext';

const SEARCH_DEBOUNCE_MS = 250;

/**
 * Room information — `/chats/:roomId/info`. Members, and the controls over them.
 *
 * Membership is the only membership this product has. There is no workspace, no
 * organisation and no tenant — `users.role_id` exists in the schema and no
 * controller reads it — so "member management" can only mean members of this
 * room, and this panel is where it lives.
 *
 * Every control here is gated the same way the server gates it, and the server is
 * the one that decides. The UI hides what an admin cannot do, but that is a
 * courtesy: a member who deep-links or races another admin still gets a 403,
 * because the check is in the controller and not here.
 *
 * The last admin is the rule that shapes this screen. `role` is only ever
 * written at insert time plus this screen's own actions, so the room's creator
 * began as its only admin; without the guard in the controller, demoting yourself
 * would leave a room nobody can ever administer again. So the row menu offers
 * "Leave room" on the last admin and then answers 409, which is a worse
 * experience than saying so in the first place.
 */
export default function RoomInfo() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { room, isLoading, error, reload } = useRoom(roomId);
  const { user } = useAuth();
  const { socket } = useRealtime();
  const { isOnlineIn } = usePresence();
  const { toast } = useToast();

  const [term, setTerm] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [isSavingRoom, setIsSavingRoom] = useState(false);
  const debounceRef = useRef(null);
  const avatarFileRef = useRef(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [commonRooms, setCommonRooms] = useState([]);
  const [reportTarget, setReportTarget] = useState(null);
  const [reportReason, setReportReason] = useState('harassment');
  const [reportDetails, setReportDetails] = useState('');
  const [peerBlocked, setPeerBlocked] = useState(false);

  const members = useMemo(() => room?.members || [], [room]);
  const myRole = useMemo(
    () => members.find((member) => member.id === user?.id)?.role || null,
    [members, user],
  );
  const isAdmin = myRole === 'admin';
  const adminCount = members.filter((member) => member.role === 'admin').length;
  const memberIds = useMemo(() => new Set(members.map((member) => member.id)), [members]);

  // Someone else changing the membership is pushed, not polled. This panel is
  // the only place that shows the member list, so it is also the only place that
  // has to act on it — a stale list here reads as "they are still a member".
  useEffect(() => {
    if (!socket) return undefined;
    const onMembers = (payload) => {
      if (payload?.roomId === roomId) reload();
    };
    const onRoom = (payload) => {
      if (payload?.roomId === roomId) reload();
    };
    socket.on('room:members', onMembers);
    socket.on('room:updated', onRoom);
    return () => {
      socket.off('room:members', onMembers);
      socket.off('room:updated', onRoom);
    };
  }, [socket, roomId, reload]);

  useEffect(() => {
    const q = term.trim();
    if (!q) {
      setCandidates([]);
      setIsSearching(false);
      return undefined;
    }
    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const found = await searchUsers(q);
        // Already-in-room people are not candidates. Offering them would produce
        // a 409 from addMember, which is a worse answer than an empty list.
        setCandidates(found.filter((person) => !memberIds.has(person.id)));
      } catch {
        setCandidates([]);
      } finally {
        setIsSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(debounceRef.current);
  }, [term, memberIds]);

  function onError(prefix, err) {
    toast({
      title: prefix,
      description: err.response?.data?.message || 'That did not work. Try again.',
      tone: 'error',
    });
  }

  // A DM's name is derived from the other member on every read, so there is
  // nothing to edit there and the control is not shown at all.
  const canEditRoom = isAdmin && room?.type !== 'dm';
  const isDm = room?.type === 'dm';
  const peer = isDm ? members.find((member) => member.id !== user?.id) : null;
  const roomCreator = members.find((member) => member.id === room?.created_by);

  useEffect(() => {
    if (!isDm || !peer?.id) { setCommonRooms([]); return; }
    getSharedRooms(peer.id).then(setCommonRooms).catch(() => setCommonRooms([]));
  }, [isDm, peer?.id]);
  useEffect(() => {
    if (!isDm || !peer?.id) { setPeerBlocked(false); return; }
    getBlockStatus(peer.id).then((result) => setPeerBlocked(Boolean(result.blocked))).catch(() => setPeerBlocked(false));
  }, [isDm, peer?.id]);


  const formatDate = (value, options = { month: 'long', day: 'numeric', year: 'numeric' }) => {
    if (!value) return 'Not available';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleDateString(undefined, options);
  };

  const formatLastSeen = (value) => {
    if (!value) return 'No recent activity recorded';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'No recent activity recorded' : `Last seen here ${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
  };

  function startEditing() {
    setDraftName(room?.display_name || room?.name || '');
    setDraftDescription(room?.description || '');
    setEditing(true);
  }

  async function saveRoom(event) {
    event.preventDefault();
    setIsSavingRoom(true);
    try {
      await updateRoom(roomId, {
        name: draftName.trim(),
        description: draftDescription,
      });
      setEditing(false);
      await reload();
      toast({ title: 'Room updated', tone: 'success' });
    } catch (err) {
      onError('Could not update the room', err);
    } finally {
      setIsSavingRoom(false);
    }
  }

  async function onPickRoomAvatar(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setIsUploadingAvatar(true);
    try {
      const avatarUrl = await uploadAvatar(file);
      await updateRoom(roomId, { avatar_url: avatarUrl });
      await reload();
      toast({ title: 'Room photo updated', tone: 'success' });
    } catch (err) {
      onError('Could not update the room photo', err);
    } finally {
      setIsUploadingAvatar(false);
    }
  }

  async function invite(person) {
    setBusyId(person.id);
    try {
      await addMember(roomId, person.id);
      setCandidates((prev) => prev.filter((entry) => entry.id !== person.id));
      setTerm('');
      toast({ title: `${person.display_name} added`, tone: 'success' });
    } catch (err) {
      onError('Could not add them', err);
    } finally {
      setBusyId(null);
    }
  }

  async function demote(person) {
    setBusyId(person.id);
    try {
      await setMemberRole(roomId, person.id, 'member');
      toast({ title: `${person.display_name} is no longer an admin`, tone: 'success' });
    } catch (err) {
      onError('Could not change their role', err);
    } finally {
      setBusyId(null);
    }
  }

  async function promote(person) {
    setBusyId(person.id);
    try {
      await setMemberRole(roomId, person.id, 'admin');
      toast({ title: `${person.display_name} is now an admin`, tone: 'success' });
    } catch (err) {
      onError('Could not change their role', err);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(person, leaving) {
    setBusyId(person.id);
    try {
      await removeMember(roomId, person.id);
      toast({
        title: leaving ? 'You left the room' : `${person.display_name} was removed`,
        tone: 'success',
      });
      if (leaving) navigate('/chats');
    } catch (err) {
      onError(leaving ? 'Could not leave' : 'Could not remove them', err);
    } finally {
      setBusyId(null);
    }
  }

  async function messagePerson(person) {
    try {
      const dm = await createRoom({ type: 'dm', memberIds: [person.id] });
      navigate(`/chats/${dm.id}`);
    } catch (err) { onError('Could not open a direct message', err); }
  }

  async function submitReport(event) {
    event.preventDefault();
    try {
      await reportUser(reportTarget.id, { reason: reportReason, details: reportDetails, roomId });
      setReportTarget(null); setReportDetails('');
      toast({ title: 'Report submitted', description: 'Thank you. The report has been recorded for review.', tone: 'success' });
    } catch (err) { onError('Could not submit report', err); }
  }

  if (isLoading) return <Spinner fullPage label="Loading room" />;
  if (error) {
    return (
      <div className="px-4 py-8 md:px-7">
        <EmptyState title="Room unavailable" description={error} />
      </div>
    );
  }

  return (
      <Page width="content">
      <section className="rounded-2xl border border-line bg-surface p-5 shadow-card md:p-7" aria-label={isDm ? 'Conversation overview' : 'Room overview'}>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <div className="flex shrink-0 flex-col items-center gap-2">
            <Avatar name={isDm ? peer?.display_name : room?.display_name || room?.name} src={isDm ? peer?.avatar_url : room?.avatar_url || room?.display_avatar} size="lg" />
            {canEditRoom && (
              <>
                <input ref={avatarFileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={onPickRoomAvatar} className="sr-only" aria-label="Upload a room photo" />
                <Button variant="ghost" onClick={() => avatarFileRef.current?.click()} disabled={isUploadingAvatar} className="gap-1 px-2 text-metadata">
                  <IconCamera className="h-3.5 w-3.5" aria-hidden="true" />{isUploadingAvatar ? 'Uploading…' : 'Room photo'}
                </Button>
              </>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-h1 text-ink">{isDm ? `Conversation with ${peer?.display_name || room?.display_name || room?.name}` : room?.display_name || room?.name || 'Room'}</h1>
              <Badge tone={isDm ? 'brand' : room?.type === 'public' ? 'success' : 'neutral'}>
                {isDm ? 'Direct message' : room?.type === 'department' ? 'Department' : room?.type === 'private' ? 'Private room' : room?.type === 'public' ? 'Public room' : 'Group room'}
              </Badge>
            </div>
            <p className="mt-2 max-w-2xl text-body leading-relaxed text-muted">
              {isDm ? 'A private conversation between the two of you.' : room?.description || 'A shared space for conversation, updates, and decisions.'}
            </p>
            {!isDm && (
              <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-metadata text-muted">
                <span className="inline-flex items-center gap-1.5"><IconMember className="h-4 w-4" aria-hidden="true" />{members.length} {members.length === 1 ? 'member' : 'members'}</span>
                <span className="inline-flex items-center gap-1.5"><IconCalendar className="h-4 w-4" aria-hidden="true" />Created {formatDate(room?.created_at)}</span>
                {roomCreator && <span>Started by {roomCreator.display_name}</span>}
                {room?.slug && <span>#{room.slug}</span>}
              </div>
            )}
          </div>
          {canEditRoom && !editing && (
            <Button variant="secondary" onClick={startEditing} className="shrink-0 self-start">Edit room</Button>
          )}
        </div>
      </section>

      {isDm && peer && (
        <section className="mt-6 rounded-2xl border border-line bg-surface p-5 md:p-6" aria-labelledby="person-details-heading">
          <div className="flex items-start gap-4">
            <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${isOnlineIn(roomId, peer.id) ? 'bg-success' : 'bg-muted/40'}`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <h2 id="person-details-heading" className="text-h2 text-ink">About {peer.display_name}</h2>
              <p className="mt-1 text-metadata text-muted">
                {isOnlineIn(roomId, peer.id) ? 'Active in this conversation' : formatLastSeen(peer.last_seen_at)}
              </p>
              <p className="mt-4 whitespace-pre-wrap text-body leading-relaxed text-ink">{peer.bio || 'No profile introduction yet.'}</p>
              <p className="mt-4 text-metadata text-muted">On Conclave since {formatDate(peer.account_created_at || peer.created_at, { month: 'long', year: 'numeric' })}</p>
            </div>
          </div>
        </section>
      )}

      {isDm && (
        <section className="mt-6 rounded-2xl border border-line bg-surface p-5 md:p-6" aria-labelledby="common-groups-heading">
          <h2 id="common-groups-heading" className="text-h2 text-ink">Groups in common</h2>
          {commonRooms.length ? <ul className="mt-3 divide-y divide-line">{commonRooms.map((group) => <li key={group.id} className="flex items-center gap-3 py-3"><Avatar name={group.display_name || group.name} src={group.display_avatar || group.avatar_url} /><div className="min-w-0 flex-1"><p className="truncate text-body text-ink">{group.display_name || group.name}</p><p className="text-metadata text-muted">{group.member_count || group.members?.length || 0} members</p></div><Button variant="secondary" onClick={() => navigate(`/chats/${group.id}`)}>Open</Button></li>)}</ul> : <p className="mt-2 text-metadata text-muted">You and {peer?.display_name} are not in any other groups together.</p>}
        </section>
      )}

      {/* Shown outside the form too, so a room's purpose is readable by every
          member — editing it is admin-only, seeing it is not. */}
      {canEditRoom && editing && (
        <form onSubmit={saveRoom} className="mt-6 rounded-xl border border-line bg-surface p-6">
          <h2 className="text-h2 text-ink">Edit room</h2>
          <div className="mt-4 space-y-4">
            <Input
              label="Name"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              maxLength={100}
              required
            />
            <Textarea
              label="Description"
              value={draftDescription}
              onChange={(event) => setDraftDescription(event.target.value)}
              maxLength={1000}
              placeholder="What this room is for"
            />
          </div>
          <p className="mt-2 text-metadata text-muted">
            The room&rsquo;s address in the URL does not change when you rename it.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Button type="submit" disabled={!draftName.trim() || isSavingRoom}>
              {isSavingRoom ? 'Saving…' : 'Save changes'}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={isSavingRoom}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {isAdmin && !isDm && (
        <section className="mt-6">
          <h2 className="text-h2 text-ink">Add people</h2>
          <div className="relative mt-3">
            <IconSearch
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search by name"
              aria-label="Search people to add"
              className="min-h-12 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-body text-ink outline-none transition-shadow placeholder:text-muted/70 focus:border-brand focus:ring-2 focus:ring-brand/15"
            />
          </div>

          {isSearching && <Spinner label="Searching" />}

          {!isSearching && term.trim() && candidates.length === 0 && (
            <p className="mt-3 text-metadata text-muted">
              Nobody matching “{term.trim()}” is available to add.
            </p>
          )}

          {candidates.length > 0 && (
            <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {candidates.map((person) => (
                <li key={person.id} className="flex items-center gap-3 px-4 py-3">
                  <Avatar name={person.display_name} src={person.avatar_url} />
                  <span className="min-w-0 flex-1 truncate text-body text-ink">
                    {person.display_name}
                  </span>
                  <Button
                    variant="secondary"
                    disabled={busyId === person.id}
                    onClick={() => invite(person)}
                    className="shrink-0 px-3 text-metadata"
                  >
                    {busyId === person.id ? 'Adding…' : 'Add'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!isDm && <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-h2 text-ink">Room members</h2>
            <p className="mt-1 text-metadata text-muted">{members.length} {members.length === 1 ? 'person' : 'people'}{!isDm && adminCount ? ` · ${adminCount} ${adminCount === 1 ? 'admin' : 'admins'}` : ''}</p>
          </div>
          {isAdmin && !isDm && <p className="text-metadata text-muted">Admins can add people and manage roles.</p>}
        </div>
        <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {members.map((member) => {
            const isSelf = member.id === user?.id;
            const isLastAdmin = member.role === 'admin' && adminCount <= 1;
            return (
              <li key={member.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Avatar name={member.display_name} src={member.avatar_url} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-body text-ink">{member.display_name}</span>
                    {isSelf && <span className="shrink-0 text-metadata text-muted">You</span>}
                  </div>
                  <p className="mt-0.5 truncate text-metadata text-muted">
                    {isOnlineIn(roomId, member.id) ? 'Active in this room' : formatLastSeen(member.last_seen_at)}
                    {member.joined_at && ` · Joined ${formatDate(member.joined_at, { month: 'short', day: 'numeric', year: 'numeric' })}`}
                  </p>
                </div>

                    {!isDm && member.role === 'admin' && (
                  <Badge tone="brand" className="shrink-0">
                    Admin
                  </Badge>
                )}

                {/* Admin controls are separate from member safety and DM actions. */}
                {!isDm && !isSelf && (
                  <div className="relative shrink-0">
                    {isAdmin ? <RowMenu
                      person={member}
                      isSelf={isSelf}
                      isAdmin={isAdmin}
                      isLastAdmin={isLastAdmin}
                      busy={busyId === member.id}
                      onRemove={remove}
                      onPromote={promote}
                      onDemote={demote}
                    /> : null}
                    <div className="flex shrink-0 flex-wrap justify-end gap-1"><Button variant="secondary" onClick={() => messagePerson(member)} className="px-3 text-metadata">Message</Button><Button variant="ghost" onClick={() => setReportTarget(member)} className="px-2 text-metadata">Report</Button><Button variant="ghost" onClick={async () => { try { await blockUser(member.id); toast({ title: `${member.display_name} blocked`, description: 'Direct messages with this person are blocked.', tone: 'success' }); } catch (err) { onError('Could not block user', err); } }} className="px-2 text-metadata">Block</Button></div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>}

      <SharedMediaBrowser key={`${user.id}:${roomId}`} roomId={roomId} userId={user.id} />

      <section className="mt-6 rounded-2xl border border-error/20 bg-surface p-5 md:p-6" aria-label="Conversation actions">
        <h2 className="text-h2 text-ink">Your conversation controls</h2>
        <p className="mt-1 text-metadata text-muted">These actions affect your account or this device only.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => { clearConversationForMe(user.id, roomId); toast({ title: 'Messages cleared on this device', tone: 'success' }); }}>Clear messages for me</Button>
          {peer && <><Button variant="ghost" onClick={() => setReportTarget(peer)}>Report {peer.display_name}</Button><Button variant="ghost" onClick={async () => { try { if (peerBlocked) await unblockUser(peer.id); else await blockUser(peer.id); setPeerBlocked((value) => !value); toast({ title: peerBlocked ? `${peer.display_name} unblocked` : `${peer.display_name} blocked`, description: peerBlocked ? 'Direct messages are available again.' : 'You will not be able to exchange direct messages.', tone: 'success' }); } catch (err) { onError(peerBlocked ? 'Could not unblock user' : 'Could not block user', err); } }}>{peerBlocked ? `Unblock ${peer.display_name}` : `Block ${peer.display_name}`}</Button></>}
          {!isDm && <Button variant="ghost" className="text-error" disabled={busyId === user.id} onClick={() => remove({ ...user, display_name: user.display_name }, true)}>Leave room</Button>}
        </div>
      </section>

      <Modal open={Boolean(reportTarget)} onClose={() => setReportTarget(null)} title={`Report ${reportTarget?.display_name || 'user'}`}>
        <form onSubmit={submitReport} className="space-y-4">
          <label className="block text-label text-ink">Reason<select value={reportReason} onChange={(event) => setReportReason(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-body"><option value="harassment">Harassment</option><option value="spam">Spam</option><option value="inappropriate_content">Inappropriate content</option><option value="impersonation">Impersonation</option><option value="other">Other</option></select></label>
          <Textarea label="Details (optional)" value={reportDetails} onChange={(event) => setReportDetails(event.target.value)} maxLength={1000} />
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setReportTarget(null)}>Cancel</Button><Button type="submit">Submit report</Button></div>
        </form>
      </Modal>
      </Page>
  );
}

function RowMenu({ person, isSelf, isAdmin, isLastAdmin, busy, onRemove, onPromote, onDemote }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${person.display_name}`}
        className="grid h-7 w-7 place-items-center rounded-lg text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-40"
      >
        <IconMoreVertical className="h-4 w-4" aria-hidden="true" />
      </button>

      <PopoverMenu
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        align="end"
        label={`Actions for ${person.display_name}`}
        className="w-44"
      >
        {isAdmin && !isSelf && person.role === 'member' && (
          <MenuItem
            label="Make admin"
            onClick={() => {
              setOpen(false);
              onPromote(person);
            }}
          />
        )}
        {isAdmin && !isSelf && person.role === 'admin' && (
          <MenuItem
            label="Remove admin"
            disabled={isLastAdmin}
            title={isLastAdmin ? 'A room must keep at least one admin' : undefined}
            onClick={() => {
              setOpen(false);
              onDemote(person);
            }}
          />
        )}
        <MenuItem
          label={isSelf ? 'Leave room' : 'Remove from room'}
          danger
          disabled={isLastAdmin}
          title={isLastAdmin ? 'A room must keep at least one admin' : undefined}
          onClick={() => {
            setOpen(false);
            onRemove(person, isSelf);
          }}
        />
      </PopoverMenu>
    </>
  );
}

function MenuItem({ label, onClick, danger, disabled, title }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-body transition-colors hover:bg-canvas disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent ${
        danger ? 'text-error' : 'text-ink'
      }`}
    >
      {label}
    </button>
  );
}
