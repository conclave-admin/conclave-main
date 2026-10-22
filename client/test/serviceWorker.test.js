import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('the ready-page asset handshake claims its document and caches only public assets', async () => {
  const handlers = new Map(); const steps = []; const fetched = []; const pending = [];
  const origin = 'https://conclave.example.test';
  const cache = { match: async () => null, put: async () => { steps.push('cached'); } };
  const source = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    URL,
    self: { location: { origin }, clients: { claim: async () => { steps.push('claimed'); } },
      addEventListener: (name, handler) => handlers.set(name, handler) },
    caches: { open: async () => { steps.push('opened'); return cache; } },
    fetch: async (url) => { fetched.push(url); return { ok: true }; },
  });
  handlers.get('message')({ data: { type: 'CACHE_ASSETS', urls: [
    `${origin}/assets/room.js`, `${origin}/api/messages`, 'https://other.example.test/assets/private.js',
  ] }, waitUntil: (work) => pending.push(work) });
  await Promise.all(pending);
  assert.equal(steps[0], 'claimed');
  assert.deepEqual(fetched, [`${origin}/assets/room.js`]);
  assert.ok(steps.includes('cached'));
});

async function pushWorker(){
  const handlers=new Map();const shown=[];const messages=[];const opened=[];let binding={bindingId:'binding',renewalToken:'renewal',apiBase:'https://api.example.test/api'};let clients=[];
  const context={URL,Date,Uint8Array,atob,
    self:{location:{origin:'https://conclave.example.test'},registration:{showNotification:async(title,options)=>shown.push({title,...options}),pushManager:{subscribe:async()=>({toJSON:()=>({endpoint:'https://fcm.googleapis.com/rotated'})})}},
      clients:{matchAll:async()=>clients,openWindow:async url=>opened.push(url)},addEventListener:(name,handler)=>handlers.set(name,handler)},
    fetch:async url=>({ok:true,json:async()=>url.endsWith('/config')?{data:{configured:true,publicKey:'AQID'}}:{data:{bindingId:'binding',renewalToken:'new-renewal'}}}),
  };
  vm.createContext(context);vm.runInContext(await readFile(new URL('../public/service-worker.js',import.meta.url),'utf8'),context);
  context.pushState=async(value,write)=>{if(write)binding=value;return binding;};
  const event=async(name,extra)=>{let work;handlers.get(name)({...extra,waitUntil:value=>{work=value;}});await work;};
  return{context,shown,messages,opened,event,setBinding:value=>{binding=value;},binding:()=>binding,setClients:value=>{clients=value;}};
}
test('closed-app push shows only generic content and ignores stale account bindings',async()=>{
  const f=await pushWorker();
  await f.event('push',{data:{json:()=>({id:'notification',bindingId:'other',body:'Private secret'})}});assert.equal(f.shown.length,0);
  await f.event('push',{data:{json:()=>({id:'notification',bindingId:'binding',body:'Private secret'})}});
  assert.equal(f.shown.length,1);assert.equal(f.shown[0].body,'You have new activity in Conclave');assert.equal(f.shown[0].tag,'conclave:notification');assert.equal(f.shown[0].renotify,false);
  f.setBinding(null);await f.event('push',{data:{json:()=>({id:'later',bindingId:'binding'})}});assert.equal(f.shown.length,1);
});
test('foreground conversation suppresses interruption and notification clicks remain on this origin',async()=>{
  const f=await pushWorker();let focused=false;let target;
  const client={focused:true,visibilityState:'visible',url:'https://conclave.example.test/chats/room',postMessage:value=>f.messages.push(value),focus:async()=>{focused=true;},navigate:async url=>{target=url;}};
  f.setClients([client]);await f.event('push',{data:{json:()=>({id:'n',bindingId:'binding',roomId:'room'})}});assert.equal(f.shown.length,0);assert.equal(f.messages[0].type,'SYNC_REQUEST');
  await f.event('notificationclick',{notification:{close(){},data:{bindingId:'binding',url:'https://evil.test/'}}});
  assert.equal(focused,true);assert.equal(target,'https://conclave.example.test/notifications');
});
test('subscription change renews its scoped credential without storing API login tokens',async()=>{
  const f=await pushWorker();await f.event('pushsubscriptionchange',{});
  assert.equal(f.binding().renewalToken,'new-renewal');assert.equal(f.binding().bindingId,'binding');assert.equal(f.binding().accessToken,undefined);
});
