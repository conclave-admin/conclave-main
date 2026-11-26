import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { isDevAuthBypass, previewSocket } from "../config/devPreview";
import useHeartbeat from "../hooks/useHeartbeat";
import { connectSocket, disconnectSocket } from "../lib/socket";
import { useAuth } from "./AuthContext";
const RealtimeContext = createContext(null);
export function RealtimeProvider({ children }) {
  const { isAuthenticated, sessionId } = useAuth();
  const [socket, setSocket] = useState(isDevAuthBypass ? previewSocket : null);
  const [isConnected, setIsConnected] = useState(isDevAuthBypass);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const online = () => setIsOnline(true);
    const offline = () => setIsOnline(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);
  useEffect(() => {
    if (isDevAuthBypass) return;
    if (!isAuthenticated) {
      disconnectSocket();
      setSocket(null);
      setIsConnected(false);
      return;
    }
    const instance = connectSocket();
    const onConnect = () => {
      if (navigator.onLine === false) { instance.disconnect(); return; }
      setIsConnected(true);
    };
    const offline = () => { setIsConnected(false); instance.disconnect(); };
    const online = () => { if (navigator.onLine !== false) instance.connect(); };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    if (navigator.onLine === false) offline();
    const onDisconnect = () => setIsConnected(false);
    instance.on("connect", onConnect);
    instance.on("disconnect", onDisconnect);
    setSocket(instance);
    setIsConnected(instance.connected);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      instance.off("connect", onConnect);
      instance.off("disconnect", onDisconnect);
      disconnectSocket();
      setSocket(null);
      setIsConnected(false);
    };
  }, [isAuthenticated, sessionId]);
  useHeartbeat(socket);
  const value = useMemo(() => ({ socket, isConnected: isOnline && isConnected, isOnline }), [socket, isConnected, isOnline]);
  return (
    <RealtimeContext.Provider value={value}>
      {children}
    </RealtimeContext.Provider>
  );
}
export function useRealtime() {
  const value = useContext(RealtimeContext);
  if (!value)
    throw new Error("useRealtime must be used inside RealtimeProvider");
  return value;
}
