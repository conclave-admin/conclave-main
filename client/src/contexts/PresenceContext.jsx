import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "./AuthContext";
import { useRealtime } from "./RealtimeContext";
import {
  activityExpiries,
  activeUserIds,
  acceptsActivity,
} from "../lib/conversationActivity";
import {
  presenceLabel,
  presenceStatus,
  roomPresenceSnapshot,
  TYPING_FRESH_MS,
} from "../lib/presenceState";

const PresenceContext = createContext(null);

export function PresenceProvider({ children }) {
  const { socket, isConnected } = useRealtime();
  const { user } = useAuth();
  const [roomPresence, setRoomPresence] = useState(() => new Map());
  const [clock, setClock] = useState(Date.now);
  const hidden = useRef(new Set());

  useEffect(() => {
    setRoomPresence(new Map());
    hidden.current.clear();
    if (!socket) return undefined;
    const clear = () => setRoomPresence(new Map());
    const onRoomPresence = (payload) =>
      setRoomPresence((previous) => {
        const before = previous.get(payload.roomId);
        const next = roomPresenceSnapshot(payload);
        if (payload.available && !acceptsActivity(before, payload)) {
          next.typing = before.typing;
          next.recording = before.recording;
          next.activityVersion = before.activityVersion;
        }
        return new Map(previous).set(payload.roomId, next);
      });
    const onMembers = ({ roomId, userId, action }) => {
      if (!["removed", "left"].includes(action)) return;
      setRoomPresence((previous) => {
        const next = new Map(previous);
        if (userId === user?.id) next.delete(roomId);
        else if (next.has(roomId)) {
          const snapshot = next.get(roomId);
          const online = new Set(snapshot.online);
          online.delete(userId);
          const viewing = new Set(snapshot.viewing);
          viewing.delete(userId);
          const typing = new Map(snapshot.typing);
          typing.delete(userId);
          const recording = new Map(snapshot.recording);
          recording.delete(userId);
          next.set(roomId, { ...snapshot, online, viewing, typing, recording });
        }
        return next;
      });
    };
    const activityUpdate = (
      { roomId, userId, ttlMs = TYPING_FRESH_MS, activityVersion },
      kind,
      active,
    ) =>
      setRoomPresence((previous) => {
        if (hidden.current.has(userId)) return previous;
        const snapshot = previous.get(roomId) || roomPresenceSnapshot({});
        if (!acceptsActivity(snapshot, { activityVersion })) return previous;
        const next = new Map(snapshot[kind]);
        if (active)
          next.set(
            userId,
            Date.now() + Math.max(0, Math.min(TYPING_FRESH_MS, ttlMs)),
          );
        else next.delete(userId);
        return new Map(previous).set(roomId, {
          ...snapshot,
          [kind]: next,
          activityVersion: activityVersion ?? snapshot.activityVersion,
        });
      });
    const onTyping = (payload) => activityUpdate(payload, "typing", true);
    const onStopTyping = (payload) => activityUpdate(payload, "typing", false);
    const onRecording = (payload) => activityUpdate(payload, "recording", true);
    const onStopRecording = (payload) =>
      activityUpdate(payload, "recording", false);
    const onRoomTyping = (payload) =>
      setRoomPresence((previous) => {
        const snapshot =
          previous.get(payload.roomId) || roomPresenceSnapshot({});
        if (!acceptsActivity(snapshot, payload)) return previous;
        return new Map(previous).set(payload.roomId, {
          ...snapshot,
          activityVersion: payload.activityVersion ?? snapshot.activityVersion,
          typing: activityExpiries(payload, "typing"),
          recording: activityExpiries(payload, "recording"),
        });
      });
    const onPrivacy = ({ userId, hidden: hide }) => {
      if (hide) hidden.current.add(userId);
      else hidden.current.delete(userId);
      clear();
    };
    const events = {
      "room-presence": onRoomPresence,
      "room:members": onMembers,
      typing: onTyping,
      "stop-typing": onStopTyping,
      "room-typing": onRoomTyping,
      "start-recording": onRecording,
      "stop-recording": onStopRecording,
      "privacy:changed": onPrivacy,
      disconnect: clear,
      connect: clear,
      "presence:unavailable": clear,
      "presence:resync": clear,
    };
    for (const [name, handler] of Object.entries(events))
      socket.on(name, handler);
    for (const name of [
      "offline",
      "focus",
      "blur",
      "pageshow",
      "conclave:presence-stale",
    ])
      window.addEventListener(name, clear);
    document.addEventListener("visibilitychange", clear);
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      for (const [name, handler] of Object.entries(events))
        socket.off(name, handler);
      for (const name of [
        "offline",
        "focus",
        "blur",
        "pageshow",
        "conclave:presence-stale",
      ])
        window.removeEventListener(name, clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, [socket, user?.id]);

  const getPresence = useCallback(
    (roomId, userId) =>
      hidden.current.has(userId)
        ? "unknown"
        : presenceStatus(
            roomPresence.get(roomId),
            userId,
            isConnected && navigator.onLine !== false,
            clock,
          ),
    [roomPresence, isConnected, clock],
  );
  const getActivity = useCallback(
    (roomId) => {
      const snapshot =
        isConnected && navigator.onLine !== false
          ? roomPresence.get(roomId)
          : null;
      const suppressed = new Set([
        ...hidden.current,
        ...(snapshot?.hidden || []),
      ]);
      return {
        typingUserIds: activeUserIds(
          snapshot?.typing,
          clock,
          suppressed,
          user?.id,
        ),
        recordingUserIds: activeUserIds(
          snapshot?.recording,
          clock,
          suppressed,
          user?.id,
        ),
      };
    },
    [roomPresence, clock, isConnected, user?.id],
  );
  const activityByRoom = useMemo(() => {
    const typingByRoom = new Map();
    const recordingByRoom = new Map();
    for (const id of roomPresence.keys()) {
      const state = getActivity(id);
      typingByRoom.set(id, new Set(state.typingUserIds));
      recordingByRoom.set(id, new Set(state.recordingUserIds));
    }
    return { typingByRoom, recordingByRoom };
  }, [roomPresence, getActivity]);
  const isOnlineIn = useCallback(
    (roomId, userId) =>
      ["online", "viewing", "typing", "recording"].includes(
        getPresence(roomId, userId),
      ),
    [getPresence],
  );
  const labelFor = useCallback(
    (roomId, userId) => {
      const status = getPresence(roomId, userId),
        snapshot = roomPresence.get(roomId),
        last = snapshot?.lastSeen?.[userId];
      return (status === "offline" ||
        (status === "unknown" && snapshot?.available)) &&
        last &&
        isConnected &&
        clock - snapshot.receivedAt < 45000
        ? `Last active ${new Date(last).toLocaleString()}`
        : presenceLabel(status);
    },
    [getPresence, roomPresence, isConnected, clock],
  );
  const value = useMemo(
    () => ({
      roomPresence,
      getPresence,
      isOnlineIn,
      labelFor,
      getActivity,
      ...activityByRoom,
    }),
    [
      roomPresence,
      getPresence,
      isOnlineIn,
      labelFor,
      getActivity,
      activityByRoom,
    ],
  );
  return (
    <PresenceContext.Provider value={value}>
      {children}
    </PresenceContext.Provider>
  );
}
export function usePresence() {
  const value = useContext(PresenceContext);
  if (!value)
    throw new Error("usePresence must be used inside PresenceProvider");
  return value;
}
