import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./AuthContext";
import { useRealtime } from "./RealtimeContext";
import { useToast } from "./ToastContext";
import { endCallByApi, getCallIceServers, listPendingCalls } from "@/services/calls.service";
import CallPanel from "@/components/calls/CallPanel";

const CallContext = createContext(null);

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error("Reconnect to place or control a call."));
    const timer = setTimeout(() => reject(new Error("The call service did not respond.")), 10000);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      if (result?.ok) resolve(result.data);
      else reject(new Error(result?.error || "Could not complete the call action."));
    });
  });
}

export function CallProvider({ children }) {
  const { socket } = useRealtime();
  const { user } = useAuth();
  const { toast } = useToast();
  const [call, setCall] = useState(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [duration, setDuration] = useState(0);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [localStream, setLocalStream] = useState(null);
  const callRef = useRef(null);
  const socketRef = useRef(socket);
  const streamRef = useRef(null);
  const peerConnections = useRef(new Map());
  const pendingIce = useRef(new Map());
  const iceConfig = useRef(null);
  const localVideoRef = useRef(null);
  socketRef.current = socket;
  callRef.current = call;

  const updateCall = useCallback((next) => {
    callRef.current = next;
    setCall(next);
  }, []);

  const disposeMedia = useCallback(() => {
    for (const peer of peerConnections.current.values()) {
      clearTimeout(peer.disconnectTimer);
      peer.pc.close();
    }
    peerConnections.current.clear();
    pendingIce.current.clear();
    for (const track of streamRef.current?.getTracks?.() || []) track.stop();
    streamRef.current = null;
    iceConfig.current = null;
    setLocalStream(null);
    setRemoteStreams({});
    setMuted(false);
    setCameraOff(false);
  }, []);

  const clearCall = useCallback(() => {
    disposeMedia();
    updateCall(null);
    setDuration(0);
    window.dispatchEvent(new Event("conclave:calls-changed"));
  }, [disposeMedia, updateCall]);

  const sendSignal = useCallback(async (callId, peerId, signal) => {
    await emitAck(socketRef.current, "call:signal", { callId, toUserId: peerId, signal });
  }, []);

  const createPeerConnection = useCallback(async (callId, peer) => {
    const existing = peerConnections.current.get(peer.id);
    if (existing) return existing.pc;
    if (!iceConfig.current) iceConfig.current = await getCallIceServers();
    const pc = new RTCPeerConnection({ iceServers: iceConfig.current.iceServers, iceCandidatePoolSize: 2 });
    const record = { pc, peer };
    peerConnections.current.set(peer.id, record);
    for (const track of streamRef.current?.getTracks?.() || []) pc.addTrack(track, streamRef.current);
    pc.onicecandidate = (event) => {
      if (event.candidate)
        sendSignal(callId, peer.id, { type: "ice-candidate", data: event.candidate.toJSON() }).catch(() => {});
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      setRemoteStreams((current) => ({ ...current, [peer.id]: { stream, peer } }));
    };
    pc.onconnectionstatechange = () => {
      const current = callRef.current;
      if (pc.connectionState === "connected" && current?.id === callId)
        {
          clearTimeout(record.disconnectTimer);
          updateCall({ ...current, status: "active", connectedAt: current.connectedAt || Date.now() });
        }
      else if (["failed", "disconnected"].includes(pc.connectionState) && current?.id === callId) {
        clearTimeout(record.disconnectTimer);
        record.disconnectTimer = setTimeout(() => {
          if (callRef.current?.id !== callId) return;
          if (pc.connectionState === "connected") return;
        toast({ title: "Call connection failed", description: "Check your network and try again.", tone: "error" });
        emitAck(socketRef.current, "call:end", { callId }).finally(clearCall);
        }, pc.connectionState === "failed" ? 0 : 15000);
      }
    };
    return pc;
  }, [clearCall, sendSignal, toast, updateCall]);

  const startOffer = useCallback(async (callId, peer) => {
    if (!user?.id || !streamRef.current || user.id.localeCompare(peer.id) > 0) return;
    try {
      const pc = await createPeerConnection(callId, peer);
      if (pc.localDescription) return;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendSignal(callId, peer.id, { type: "offer", data: pc.localDescription.toJSON() });
    } catch (error) {
      toast({ title: "Could not connect the call", description: error.message, tone: "error" });
      emitAck(socketRef.current, "call:end", { callId }).finally(clearCall);
    }
  }, [clearCall, createPeerConnection, sendSignal, toast, user?.id]);

  const applySignal = useCallback(async ({ callId, from, signal }) => {
    const current = callRef.current;
    if (!current || current.id !== callId || !streamRef.current || !from) return;
    const peer = current.peers?.find((item) => item.id === from) || { id: from, display_name: "Call participant" };
    try {
      const pc = await createPeerConnection(callId, peer);
      if (signal.type === "offer") {
        await pc.setRemoteDescription(signal.data);
        const candidates = pendingIce.current.get(from) || [];
        for (const candidate of candidates) await pc.addIceCandidate(candidate);
        pendingIce.current.delete(from);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal(callId, from, { type: "answer", data: pc.localDescription.toJSON() });
        updateCall({ ...callRef.current, status: "connecting" });
      } else if (signal.type === "answer") {
        await pc.setRemoteDescription(signal.data);
        const candidates = pendingIce.current.get(from) || [];
        for (const candidate of candidates) await pc.addIceCandidate(candidate);
        pendingIce.current.delete(from);
      } else if (signal.type === "ice-candidate") {
        if (pc.remoteDescription) await pc.addIceCandidate(signal.data);
        else pendingIce.current.set(from, [...(pendingIce.current.get(from) || []), signal.data]);
      }
    } catch (error) {
      toast({ title: "Could not connect the call", description: error.message, tone: "error" });
      emitAck(socketRef.current, "call:end", { callId }).finally(clearCall);
    }
  }, [clearCall, createPeerConnection, sendSignal, toast, updateCall]);

  const startCall = useCallback(async (roomId, peer, callType = "audio") => {
    if (callRef.current) {
      toast({ title: "A call is already active", tone: "error" });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      toast({ title: "Calling is unavailable", description: "Use a supported browser with microphone access.", tone: "error" });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === "video" });
      streamRef.current = stream;
      setLocalStream(stream);
      const created = await emitAck(socketRef.current, "call:start", { roomId, callType });
      updateCall({ ...created.call, peers: created.peers || (peer ? [peer] : []), direction: "outgoing", status: "ringing" });
    } catch (error) {
      disposeMedia();
      toast({ title: "Could not place the call", description: error.message, tone: "error" });
    }
  }, [disposeMedia, toast, updateCall]);

  const acceptCall = useCallback(async () => {
    const current = callRef.current;
    if (!current || current.direction !== "incoming") return;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error("Use a supported browser with microphone access.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: current.callType === "video" });
      streamRef.current = stream;
      setLocalStream(stream);
      const accepted = await emitAck(socketRef.current, "call:accept", { callId: current.id });
      const peers = accepted.peers || [];
      updateCall({ ...current, ...accepted, id: current.id, peers, direction: "incoming", status: "connecting" });
      for (const peer of peers) await startOffer(current.id, peer);
    } catch (error) {
      disposeMedia();
      toast({ title: "Could not answer the call", description: error.message, tone: "error" });
    }
  }, [disposeMedia, startOffer, toast, updateCall]);

  const declineCall = useCallback(async () => {
    const current = callRef.current;
    if (!current) return;
    await emitAck(socketRef.current, "call:decline", { callId: current.id }).catch(() => {});
    clearCall();
  }, [clearCall]);

  const endCall = useCallback(async () => {
    const current = callRef.current;
    if (!current) return;
    const id = current.id;
    await emitAck(socketRef.current, "call:end", { callId: id }).catch(() => endCallByApi(id).catch(() => {}));
    clearCall();
  }, [clearCall]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    for (const track of streamRef.current?.getAudioTracks?.() || []) track.enabled = !next;
    setMuted(next);
  }, [muted]);

  const toggleCamera = useCallback(() => {
    const next = !cameraOff;
    for (const track of streamRef.current?.getVideoTracks?.() || []) track.enabled = !next;
    setCameraOff(next);
  }, [cameraOff]);

  useEffect(() => {
    if (!localVideoRef.current) return;
    localVideoRef.current.srcObject = localStream;
    localVideoRef.current.play?.().catch(() => {});
  }, [localStream, call?.callType]);

  useEffect(() => {
    if (!socket) return undefined;
    const onIncoming = (event) => {
      if (callRef.current?.id === event.callId) return;
      if (callRef.current) {
        emitAck(socket, "call:decline", { callId: event.callId }).catch(() => {});
        return;
      }
      updateCall({ id: event.callId, roomId: event.roomId, roomName: event.roomName, roomType: event.roomType, callType: event.callType, peers: [event.peer], peer: event.peer, direction: "incoming", status: "ringing", startedAt: event.startedAt });
    };
    const loadPending = () => {
      listPendingCalls().then((pending) => {
        if (callRef.current || !pending.length) return;
        const next = pending[0];
        updateCall({ ...next, id: next.callId, peers: [next.peer], direction: "incoming", status: "ringing" });
      }).catch(() => {});
    };
    const onOutgoing = (event) => {
      if (callRef.current) return;
      updateCall({ id: event.callId, roomId: event.roomId, callType: event.callType, peers: event.peers || [], direction: "outgoing", status: "ringing" });
    };
    const onParticipantJoined = (event) => {
      const current = callRef.current;
      if (!current || current.id !== event.callId) return;
      const peers = [...(current.peers || [])];
      if (!peers.some((peer) => peer.id === event.participant.id)) peers.push(event.participant);
      updateCall({ ...current, peers });
      startOffer(current.id, event.participant);
    };
    const onSignal = (event) => applySignal(event);
    const onParticipantLeft = (event) => {
      if (callRef.current?.id !== event.callId) return;
      const record = peerConnections.current.get(event.participantId);
      clearTimeout(record?.disconnectTimer);
      record?.pc.close();
      peerConnections.current.delete(event.participantId);
      pendingIce.current.delete(event.participantId);
      setRemoteStreams((streams) => {
        const next = { ...streams };
        delete next[event.participantId];
        return next;
      });
      updateCall({ ...callRef.current, peers: (callRef.current.peers || []).filter((peer) => peer.id !== event.participantId) });
    };
    const onEnded = (event) => {
      if (callRef.current?.id !== event.callId) return;
      if (event.status === "missed") toast({ title: callRef.current.direction === "outgoing" ? "No answer" : "Missed call", tone: "info" });
      clearCall();
    };
    const onAcceptedElsewhere = (event) => {
      if (callRef.current?.id === event.callId) clearCall();
    };
    const onPrivacy = (event) => {
      if (callRef.current?.peers?.some((peer) => peer.id === event.userId)) endCall();
    };
    const onRoomMember = (event) => {
      if (event.roomId === callRef.current?.roomId && ["removed", "left"].includes(event.action)) endCall();
    };
    socket.on("call:incoming", onIncoming);
    socket.on("connect", loadPending);
    if (socket.connected) loadPending();
    socket.on("call:outgoing", onOutgoing);
    socket.on("call:participant-joined", onParticipantJoined);
    socket.on("call:signal", onSignal);
    socket.on("call:participant-left", onParticipantLeft);
    socket.on("call:ended", onEnded);
    socket.on("call:participant-accepted-elsewhere", onAcceptedElsewhere);
    socket.on("privacy:changed", onPrivacy);
    socket.on("room:members", onRoomMember);
    return () => {
      socket.off("call:incoming", onIncoming);
      socket.off("connect", loadPending);
      socket.off("call:outgoing", onOutgoing);
      socket.off("call:participant-joined", onParticipantJoined);
      socket.off("call:signal", onSignal);
      socket.off("call:participant-left", onParticipantLeft);
      socket.off("call:ended", onEnded);
      socket.off("call:participant-accepted-elsewhere", onAcceptedElsewhere);
      socket.off("privacy:changed", onPrivacy);
      socket.off("room:members", onRoomMember);
    };
  }, [applySignal, clearCall, endCall, socket, startOffer, toast, updateCall]);

  useEffect(() => {
    if (!call || call.status !== "active") return undefined;
    const started = call.connectedAt || Date.now();
    const timer = setInterval(() => setDuration(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [call?.id, call?.status, call?.connectedAt]);

  useEffect(() => {
    if (user?.id) return;
    if (callRef.current) endCallByApi(callRef.current.id).catch(() => {});
    clearCall();
  }, [clearCall, user?.id]);

  const value = useMemo(() => ({ call, startCall, acceptCall, declineCall, endCall, toggleMute, toggleCamera, muted, cameraOff, duration }), [call, startCall, acceptCall, declineCall, endCall, toggleMute, toggleCamera, muted, cameraOff, duration]);
  return (
    <CallContext.Provider value={value}>
      {children}
      <CallPanel call={call} muted={muted} cameraOff={cameraOff} duration={duration} remoteStreams={remoteStreams} localStream={localStream} localVideoRef={localVideoRef} onAccept={acceptCall} onDecline={declineCall} onEnd={endCall} onToggleMute={toggleMute} onToggleCamera={toggleCamera} />
    </CallContext.Provider>
  );
}

export function useCalls() {
  const value = useContext(CallContext);
  if (!value) throw new Error("useCalls must be used inside CallProvider");
  return value;
}
