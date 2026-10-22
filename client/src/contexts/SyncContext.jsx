import {createContext,useCallback,useContext,useEffect,useMemo,useRef} from 'react';
import {useAuth} from './AuthContext';
import {useRealtime} from './RealtimeContext';
import {readSyncPage} from '../services/sync.service';
import {isDevAuthBypass} from '../config/devPreview';
import {createSyncRunner} from '../lib/synchronization';
const Context=createContext(null);
export function SyncProvider({children}){
  const {user,sessionId,refreshUser}=useAuth();const {socket,isConnected}=useRealtime();
  const listeners=useMemo(()=>new Map(),[user?.id]);const runner=useRef(null);const refreshRef=useRef(refreshUser);refreshRef.current=refreshUser;
  const requestSync=useCallback((reset=false)=>runner.current?.request(reset),[]);
  const register=useCallback(handler=>{const id=Symbol();listeners.set(id,handler);runner.current?.request(true);return()=>listeners.delete(id);},[listeners]);
  useEffect(()=>{
    if(!user?.id)return undefined;
    let cursor;try{cursor=localStorage.getItem(`conclave.sync.${user.id}`)||undefined;if(cursor&&(!/^\d{1,19}$/.test(cursor)||BigInt(cursor)>9223372036854775807n))cursor=undefined;}catch{}
    const engine=createSyncRunner({
      loadCursor:()=>cursor,saveCursor:value=>{cursor=value;try{localStorage.setItem(`conclave.sync.${user.id}`,value);}catch{}},
      readPage:readSyncPage,
      apply:async batch=>{
        if(!isDevAuthBypass&&(batch.reset||batch.changes.some(c=>c.kind==='profile'&&c.user_id===user.id))) await refreshRef.current?.();
        await Promise.all([...listeners.values()].map(handler=>handler(batch)));
      },
    });runner.current=engine;
    const request=()=>engine.request();const visible=()=>{if(document.visibilityState==='visible')request();};
    socket?.on('sync:changed',request);
    const stop=()=>engine.stop();window.addEventListener('conclave:sync-stop',stop);
    const worker=event=>{if(['SYNC_REQUEST','PUSH_SUBSCRIPTION_CHANGED'].includes(event.data?.type))request();};
    navigator.serviceWorker?.addEventListener('message',worker);
    for(const name of ['online','focus','pageshow'])window.addEventListener(name,request);
    document.addEventListener('visibilitychange',visible);
    const timer=setInterval(request,15000);request();
    return()=>{window.removeEventListener('conclave:sync-stop',stop);engine.stop();if(runner.current===engine)runner.current=null;clearInterval(timer);socket?.off('sync:changed',request);navigator.serviceWorker?.removeEventListener('message',worker);for(const name of ['online','focus','pageshow'])window.removeEventListener(name,request);document.removeEventListener('visibilitychange',visible);};
  },[user?.id,sessionId,isConnected,socket,listeners]);
  const value=useMemo(()=>({register,requestSync}),[register,requestSync]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useSyncReconciler(callback,deps=[]){
  const context=useContext(Context);const latest=useRef(callback);latest.current=callback;
  useEffect(()=>context?.register(batch=>latest.current(batch)),[context?.register,...deps]);
  return context?.requestSync;
}
