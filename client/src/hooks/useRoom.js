import { getSessionUserId } from "../lib/session";
import { isDevAuthBypass } from "../config/devPreview";
import { useSyncReconciler } from "../contexts/SyncContext";
import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeToRoom } from "../lib/roomSubscriptions";
import { getRoom } from "../services/rooms.service";
import { useAuth } from "../contexts/AuthContext";
import { useRealtime } from "../contexts/RealtimeContext";
import { readRoomMetadata, saveRoomMetadata } from "../lib/fileCache";

/** Cached details support offline use; membership events invalidate access. */
export default function useRoom(roomId) {
  const { user } = useAuth();
  const { socket } = useRealtime();
  const userId = user?.id;
  const [room, setRoom] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const revoked = useRef(false);

  const reload = useCallback(
    async (options = {}) => {
      const version = ++generation.current;
      const valid = () =>
        (isDevAuthBypass || getSessionUserId() === userId) &&
        generation.current === version &&
        !revoked.current &&
        (!options?.isCurrent || options.isCurrent());
      try {
        const value =
          navigator.onLine === false
            ? await readRoomMetadata(userId, roomId)
            : await getRoom(roomId);
        if (!valid()) {
          if (options?.strict) throw new Error("Room refresh superseded");
          return null;
        }
        setRoom(value);
        setError(
          value
            ? ""
            : "This conversation has not been saved on this device yet.",
        );
        if (value) await saveRoomMetadata(userId, roomId, value);
        return value;
      } catch (err) {
        if (!valid()) {
          if (options?.strict) throw new Error("Room refresh superseded");
          return null;
        }
        if ([403, 404].includes(err.response?.status)) {
          setRoom(null);
          await saveRoomMetadata(userId, roomId, null);
        }
        setError(
          err.response?.data?.message || "Could not refresh this conversation.",
        );
        if (options?.strict && ![403, 404].includes(err.response?.status))
          throw err;
        return null;
      } finally {
        if (valid()) setIsLoading(false);
      }
    },
    [roomId, userId],
  );

  useSyncReconciler(
    async (batch) => {
      if (
        batch.reset ||
        batch.changes.some(
          (c) =>
            c.kind === "profile" ||
            (c.room_id === roomId &&
              ["room", "membership", "preferences"].includes(c.kind)),
        )
      ) {
        revoked.current = false;
        await reload({ strict: true, isCurrent: batch.isCurrent });
      }
    },
    [userId, roomId],
  );

  useEffect(() => {
    revoked.current = false;
    setRoom(null);
    setError("");
    setIsLoading(true);
    let active = true;
    const version = generation.current;
    (async () => {
      const cached = await readRoomMetadata(userId, roomId);
      if (!active || version !== generation.current || revoked.current) return;
      if (cached) {
        setRoom(cached);
        setIsLoading(false);
      }
      reload();
    })();
    window.addEventListener("online", reload);
    return () => {
      active = false;
      generation.current++;
      window.removeEventListener("online", reload);
    };
  }, [reload, roomId, userId]);

  useEffect(() => {
    if (!socket) return undefined;
    const unsubscribe = subscribeToRoom(socket, roomId);
    const onMembers = (event) => {
      if (event.roomId !== roomId) return;
      if (
        event.userId === userId &&
        ["removed", "left"].includes(event.action)
      ) {
        revoked.current = true;
        generation.current++;
        setRoom(null);
        setIsLoading(false);
        setError("You no longer have access to this conversation.");
        saveRoomMetadata(userId, roomId, null);
      } else {
        if (event.userId === userId && event.action === "joined")
          revoked.current = false;
        if (!revoked.current) reload();
      }
    };
    const onResync = (event) => {
      if (event.roomId !== roomId || revoked.current) return;
      socket.emit("join-room", { roomId });
      reload();
    };
    const onConnect = () => {
      revoked.current = false;
      reload();
    };
    socket.on("connect", onConnect);
    socket.on("room:members", onMembers);
    socket.on("room:resync", onResync);
    return () => {
      unsubscribe();
      socket.off("connect", onConnect);
      socket.off("room:members", onMembers);
      socket.off("room:resync", onResync);
    };
  }, [socket, roomId, userId, reload]);

  return { room, isLoading, error, reload };
}
