import {api} from './api';
import {getSessionId,getSessionUserId} from './session';
let mutations=Promise.resolve();let pushGeneration=0;
const serial=work=>{mutations=mutations.catch(()=>{}).then(work);return mutations;};
export {pushSupport,applicationKey} from './pushCapabilities';
import {pushSupport,applicationKey} from './pushCapabilities';
export async function writePushBinding(value){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('conclave-push',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('state');
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{const db=request.result;const tx=db.transaction('state','readwrite');tx.objectStore('state').put(value,'binding');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};};
  });
}
export async function clearBrowserPush({server=false}={}){
  pushGeneration++;
  // Close local access before awaiting network or subscription removal.
  await writePushBinding(null).catch(()=>{});
  return serial(async()=>{
    const reg=await navigator.serviceWorker?.getRegistration('/');if(!reg)return;
    const sub=await reg.pushManager?.getSubscription();
    (await reg.getNotifications?.()||[]).forEach(n=>n.close());
    if(server&&sub&&navigator.onLine!==false)await api.delete('/push/subscriptions',{data:{endpoint:sub.endpoint},timeout:5000}).catch(()=>{});
    await sub?.unsubscribe().catch(()=>{});
  });
}
export async function configureBrowserPush(userId,sessionId,config){
  const version=pushGeneration;
  return serial(async()=>{
    if(!pushSupport()||Notification.permission!=='granted')return false;
    if(version!==pushGeneration||getSessionUserId()!==userId||getSessionId()!==sessionId)return false;
    const reg=await navigator.serviceWorker.getRegistration('/')||await navigator.serviceWorker.register('/service-worker.js');
    await navigator.serviceWorker.ready;
    let sub=await reg.pushManager.getSubscription();const key=applicationKey(config.publicKey);
    if(sub?.options?.applicationServerKey){const old=new Uint8Array(sub.options.applicationServerKey);if(old.length!==key.length||old.some((byte,i)=>byte!==key[i])){await api.delete('/push/subscriptions',{data:{endpoint:sub.endpoint},timeout:5000}).catch(()=>{});await sub.unsubscribe();sub=null;}}
    if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
    if(version!==pushGeneration||getSessionUserId()!==userId||getSessionId()!==sessionId)return false;
    const {data}=await api.post('/push/subscriptions',{subscription:sub.toJSON()},{timeout:10000});
    if(version!==pushGeneration||getSessionUserId()!==userId||getSessionId()!==sessionId)return false;
    await writePushBinding({...data.data,userId,sessionId,apiBase:new URL(api.defaults.baseURL,location.origin).href.replace(/\/$/,'')});
    return true;
  });
}
