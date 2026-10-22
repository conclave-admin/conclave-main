// Cache only the public application shell. Account data and private attachment
// bytes are handled by the authenticated app and its account-scoped IndexedDB.
const CACHE = 'conclave-shell-v2';
const assetUrl = (value) => {
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin && url.pathname.startsWith('/assets/') ? url.href : null;
  } catch { return null; }
};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch('/', { cache: 'reload' });
    if (!response.ok) throw new Error('Application shell unavailable');
    const html = await response.clone().text();
    await cache.put('/', response);
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => assetUrl(match[1])).filter(Boolean);
    await cache.addAll([...new Set(assets)]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('conclave-shell-') && name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

// Capture lazy modules loaded before the new Worker took control of the page.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_ASSETS' || !Array.isArray(event.data.urls)) return;
  event.waitUntil((async () => {
    // A new document may arrive while activation is claiming the previous one.
    // The ready-page handshake must also claim it before offline use.
    await self.clients.claim();
    const cache = await caches.open(CACHE);
    await Promise.all(event.data.urls.slice(0, 128).map(assetUrl).filter(Boolean).map(async (url) => {
      if (await cache.match(url, { ignoreVary: true })) return;
      try {
        const response = await fetch(url);
        if (response.ok) await cache.put(url, response);
      } catch { /* Already-cached modules remain usable during an outage. */ }
    }));
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (assetUrl(url.href)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      // Public hashed assets have identical bytes for this origin. Module
      // requests and worker prefetches can carry different Origin headers.
      const cached = await cache.match(request, { ignoreVary: true });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone()).catch(() => {});
      return response;
    })());
  } else if (request.mode === 'navigate' && !url.pathname.startsWith('/api/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
          await cache.put('/', response.clone()).catch(() => {});
        }
        return response;
      } catch {
        return await cache.match('/') || Response.error();
      }
    })());
  }
});

// Push contains no message text or actor names. A binding scoped to the active
// account/session prevents delayed notifications appearing after logout/login.
function pushState(value,write=false){return new Promise((resolve,reject)=>{
  const request=indexedDB.open('conclave-push',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('state');request.onerror=()=>reject(request.error);
  request.onsuccess=()=>{const db=request.result;const tx=db.transaction('state',write?'readwrite':'readonly');const op=write?tx.objectStore('state').put(value,'binding'):tx.objectStore('state').get('binding');tx.oncomplete=()=>{db.close();resolve(write?value:op.result);};tx.onerror=()=>{db.close();reject(tx.error);};};
});}
self.addEventListener('push',event=>event.waitUntil((async()=>{
  let data;try{data=event.data?.json();}catch{return;}
  const binding=await pushState();
  if(!binding||binding.bindingId!==data?.bindingId||typeof data.id!=='string'||data.id.length>100)return;
  if(binding.sessionExpiresAt&&Date.parse(binding.sessionExpiresAt)<=Date.now())return;
  const windows=await self.clients.matchAll({type:'window'});
  if(data.roomId&&windows.some(client=>client.focused&&client.visibilityState==='visible'&&new URL(client.url).pathname===`/chats/${data.roomId}`)){windows.forEach(client=>client.postMessage({type:'SYNC_REQUEST'}));return;}
  await self.registration.showNotification('Conclave',{body:'You have new activity in Conclave',tag:`conclave:${data.id}`,renotify:false,data:{id:data.id,bindingId:data.bindingId,url:'/notifications'}});
  for(const client of await self.clients.matchAll({type:'window'}))client.postMessage({type:'SYNC_REQUEST'});
})()));
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const binding=await pushState();if(!binding||binding.bindingId!==event.notification.data?.bindingId)return;
    const target=new URL('/notifications',self.location.origin).href;
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=clients.find(client=>new URL(client.url).origin===self.location.origin);
    if(existing){await existing.focus();existing.postMessage({type:'SYNC_REQUEST'});await existing.navigate(target);}else await self.clients.openWindow(target);
  })());
});
self.addEventListener('pushsubscriptionchange',event=>event.waitUntil((async()=>{
  const binding=await pushState();if(!binding)return;
  try{
    const config=await(await fetch(`${binding.apiBase}/push/config`)).json();
    if(!config.data?.configured)return;
    const key=Uint8Array.from(atob(config.data.publicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
    const subscription=event.newSubscription||await self.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
    const response=await fetch(`${binding.apiBase}/push/renew`,{method:'POST',headers:{'content-type':'application/json',authorization:`PushRenew ${binding.renewalToken}`},body:JSON.stringify({subscription:subscription.toJSON()})});
    if(!response.ok)throw new Error('Renewal unavailable');
    const value=(await response.json()).data;const current=await pushState();
    if(current?.renewalToken===binding.renewalToken)await pushState({...binding,...value},true);
  }catch{
    // A signed-in page repairs registration; no API login tokens live here.
    for(const client of await self.clients.matchAll({type:'window'}))client.postMessage({type:'PUSH_SUBSCRIPTION_CHANGED'});
  }
})()));
