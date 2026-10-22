import test from 'node:test';import assert from 'node:assert/strict';
import {createSyncRunner,mergeServerMessages} from '../src/lib/synchronization.js';
import {pushSupport,applicationKey} from '../src/lib/pushCapabilities.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('change replay persists progress only after all cache work succeeds',async()=>{
  const saved=[];const applied=[];let done;const runner=createSyncRunner({loadCursor:()=>undefined,saveCursor:c=>saved.push(c),readPage:async()=>({cursor:'5',changes:[],hasMore:false}),apply:async page=>{applied.push(page);await new Promise(resolve=>{done=resolve;});}});
  const pending=runner.request();await flush();assert.deepEqual(saved,[]);done();await pending;assert.deepEqual(saved,['5']);runner.stop();
});
test('failed reconciliation retries the same cursor and does not lose pending work',async()=>{
  let cursor='4';let attempt=0;let retry;const reads=[];
  const runner=createSyncRunner({loadCursor:()=>cursor,saveCursor:c=>{cursor=c;},readPage:async after=>{reads.push(after);return{cursor:'5',changes:[],hasMore:false};},apply:async()=>{if(!attempt++)throw new Error('Offline');},later:fn=>{retry=fn;return 1;},cancel:()=>{}});
  await runner.request();assert.equal(cursor,'4');retry();await flush();assert.equal(cursor,'5');assert.deepEqual(reads,['4','4']);runner.stop();
});
test('replay pages and overlapping requests are serialized; newly registered views can force a full snapshot',async()=>{
  let cursor='1';let active=0;let maximum=0;const reads=[];
  const runner=createSyncRunner({loadCursor:()=>cursor,saveCursor:c=>{cursor=c;},readPage:async after=>{active++;maximum=Math.max(maximum,active);await flush();active--;reads.push(after);return{cursor:after==='1'?'2':'3',changes:[],hasMore:after==='1'};},apply:async()=>{}});
  const first=runner.request();runner.request(true);await first;assert.equal(maximum,1);assert.ok(reads.includes(undefined));assert.equal(cursor,'3');runner.stop();
});
test('logout cancels late responses before they can populate another account cache',async()=>{
  let finish;let applied=false;let saved=false;
  const runner=createSyncRunner({loadCursor:()=>undefined,saveCursor:()=>{saved=true;},readPage:()=>new Promise(resolve=>{finish=resolve;}),apply:async()=>{applied=true;}});
  const pending=runner.request();runner.stop();finish({cursor:'9',changes:[]});await pending;assert.equal(applied,false);assert.equal(saved,false);
});
test('a failed forced snapshot queued behind replay is still a full snapshot on retry',async()=>{
  let cursor='4';let retry;let failed=false;const reads=[];
  const runner=createSyncRunner({loadCursor:()=>cursor,saveCursor:c=>{cursor=c;},
    readPage:async after=>{reads.push(after);await flush();return {cursor:'5',changes:[],hasMore:false,reset:after===undefined};},
    apply:async page=>{if(page.reset&&!failed){failed=true;throw new Error('Snapshot unavailable');}},
    later:fn=>{retry=fn;return 1;},cancel:()=>{}});
  const first=runner.request();runner.request(true);await first;retry();await flush();await flush();
  assert.deepEqual(reads,['4',undefined,undefined]);runner.stop();
});
test('message reconciliation preserves newer tombstones, related state and pending drafts',()=>{
  const draft={id:'draft',client_id:'client',_optimistic:true,created_at:'2026-10-22'};
  const deleted={id:'gone',sync_version:5,is_deleted:true,content:null,room_sequence:1,created_at:'2026-10-20'};
  const rows=mergeServerMessages([draft,deleted,{id:'old',sync_version:2,room_sequence:2}],[{id:'gone',sync_version:4,content:'Must not return'},{id:'old',sync_version:3,content:'Edited',reactions:[{emoji:'👍'}],room_sequence:2,created_at:'2026-10-21'}],[]);
  assert.equal(rows.find(r=>r.id==='gone').content,null);assert.equal(rows.find(r=>r.id==='old').content,'Edited');assert.equal(rows.find(r=>r.id==='draft'),draft);
  assert.equal(mergeServerMessages(rows,[],['old']).some(r=>r.id==='old'),false);
  assert.equal(rows.at(-1),draft,'a pending draft stays after saved history');
});
test('push support requires a secure context and all browser capabilities',()=>{
  assert.equal(pushSupport({isSecureContext:false,navigator:{serviceWorker:{}},Notification:{},PushManager:{}}),false);
  assert.equal(pushSupport({isSecureContext:true,navigator:{serviceWorker:{}},Notification:{},PushManager:{}}),true);
  assert.equal(applicationKey('AQID').join(','),'1,2,3');
});
