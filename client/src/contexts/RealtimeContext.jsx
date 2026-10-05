import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { isDevAuthBypass, previewSocket } from '../config/devPreview';
import useHeartbeat from '../hooks/useHeartbeat';
import { connectSocket, disconnectSocket } from '../lib/socket';
import { useAuth } from './AuthContext';
const RealtimeContext = createContext(null);
export function RealtimeProvider({ children }) {
  const { isAuthenticated } = useAuth(); const [socket, setSocket] = useState(isDevAuthBypass ? previewSocket : null); const [isConnected, setIsConnected] = useState(isDevAuthBypass);
  useEffect(() => { if (isDevAuthBypass) return; if (!isAuthenticated) { disconnectSocket(); setSocket(null); setIsConnected(false); return; } const instance = connectSocket(); const onConnect = () => setIsConnected(true); const onDisconnect = () => setIsConnected(false); instance.on('connect', onConnect); instance.on('disconnect', onDisconnect); setSocket(instance); setIsConnected(instance.connected); return () => { instance.off('connect', onConnect); instance.off('disconnect', onDisconnect); disconnectSocket(); setSocket(null); setIsConnected(false); }; }, [isAuthenticated]);
  useHeartbeat(socket); const value = useMemo(() => ({ socket, isConnected }), [socket, isConnected]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
export function useRealtime() { const value = useContext(RealtimeContext); if (!value) throw new Error('useRealtime must be used inside RealtimeProvider'); return value; }
