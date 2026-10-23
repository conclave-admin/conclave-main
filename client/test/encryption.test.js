import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from '../src/lib/cryptoProtocol.js';

await crypto.ready;
function roster(...vaults){return {members:vaults.map(v=>({id:v.userId,identity_public_key:v.identityKey})),devices:vaults.map(v=>{const p=crypto.publicDevice(v);return{id:p.id,user_id:v.userId,box_key:p.boxKey,signing_key:p.signingKey,certificate_signature:p.signature};})};}
function message(encrypted,payload,vault){return {id:'saved',room_id:payload.roomId,client_id:payload.clientId,sender_id:vault.userId,attachments:[],encrypted_payload:{...encrypted,identityKey:vault.identityKey,senderCertificate:{scheme:crypto.SCHEME,userId:vault.userId,deviceId:vault.device.id,boxKey:vault.device.boxKey,signingKey:vault.device.signingKey},senderCertificateSignature:crypto.publicDevice(vault).signature}};}
test('only authorized device keys decrypt signed messages; JSONB key order cannot break verification',()=>{
  const a=crypto.createVault('alice'),b=crypto.createVault('bob'),outsider=crypto.createVault('mallory');
  const payload={roomId:'room',clientId:'client',content:'Private long message '.repeat(300)};
  const sealed=crypto.sealMessage(a,roster(a,b),payload),row=message(sealed,payload,a);
  assert.equal(crypto.openMessage(b,row).content,payload.content);
  assert.equal(crypto.openMessage(a,row).content,payload.content);
  assert.throws(()=>crypto.openMessage(outsider,row),/no key/);
  const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort().reverse().map(([k,v])=>[k,reorder(v)])):value;
  assert.equal(crypto.openMessage(b,reorder(row)).content,payload.content);
  assert.ok(!JSON.stringify(row).includes(payload.content));
  assert.throws(()=>crypto.openMessage(b,{...row,room_id:'other'}),/context/);
  assert.throws(()=>crypto.openMessage(b,{...row,encrypted_payload:{...row.encrypted_payload,ciphertext:row.encrypted_payload.ciphertext.slice(0,-5)+'AAAAA'}}));
});
test('changed account identities and unsigned devices block sends',()=>{
  const a=crypto.createVault('alice'),b=crypto.createVault('bob');const p={roomId:'r',clientId:'c',content:'secret'};
  crypto.sealMessage(a,roster(a,b),p);
  const replacement=crypto.createVault('bob');assert.throws(()=>crypto.sealMessage(a,roster(a,replacement),p),/identity changed/);
  const invalid=roster(a,b);invalid.devices[1].certificate_signature=invalid.devices[0].certificate_signature;
  assert.throws(()=>crypto.sealMessage(a,invalid,p));
});
test('encrypted attachments authenticate bytes and context and preserve originals',async()=>{
  const blob=new Blob(['a private document'],{type:'application/pdf'});
  const sealed=await crypto.sealFile(blob,'room','client');
  assert.ok(!(await sealed.blob.text()).includes('a private document'));
  assert.equal(await(await crypto.openFile(sealed.blob,sealed.crypto,'application/pdf')).text(),'a private document');
  await assert.rejects(crypto.openFile(sealed.blob,{...sealed.crypto,associated:'different'},'application/pdf'));
  const bytes=new Uint8Array(await sealed.blob.arrayBuffer());bytes[bytes.length-1]^=1;
  await assert.rejects(crypto.openFile(new Blob([bytes]),sealed.crypto));
});
test('recovery keys restore history while wrong keys, tampering and other accounts fail',()=>{
  const vault=crypto.createVault('alice');const backup=crypto.sealBackup(vault);
  assert.equal(crypto.openBackup('alice',backup.payload,backup.recoveryKey).device.boxSecret,vault.device.boxSecret);
  assert.throws(()=>crypto.openBackup('other',backup.payload,backup.recoveryKey));
  assert.throws(()=>crypto.openBackup('alice',backup.payload,crypto.sealBackup(vault).recoveryKey));
  assert.ok(!JSON.stringify(backup.payload).includes(vault.identitySecret));
});
test('approved linking transfers history keys to exactly the selected new device',()=>{
  const a=crypto.createVault('alice'),b=crypto.createVault('bob'),pending=crypto.createVault('alice',false);
  const payload={roomId:'room',clientId:'client',content:'old history'},row=message(crypto.sealMessage(a,roster(a,b),payload),payload,a);
  const d=crypto.publicDevice(pending),link=crypto.sealLink(a,{id:d.id,box_key:d.boxKey,signing_key:d.signingKey});
  const linked=crypto.openLink(pending,link.payload);
  assert.equal(crypto.openMessage(linked,row).content,'old history');
  assert.equal(linked.device.id,pending.device.id);
  assert.throws(()=>crypto.openLink(crypto.createVault('alice',false),link.payload));
});

test('recovered key bundles reject inconsistent signing secret suffixes and own-identity substitution',()=>{
  const vault=crypto.createVault('alice'),bad=structuredClone(vault);
  const bytes=Buffer.from(bad.identitySecret,'base64url');bytes[bytes.length-1]^=1;bad.identitySecret=bytes.toString('base64url');
  const backup=crypto.sealBackup(bad);
  assert.throws(()=>crypto.openBackup('alice',backup.payload,backup.recoveryKey),/identity is invalid/);
  const substituted=crypto.createVault('alice');
  assert.throws(()=>crypto.sealMessage(vault,roster(substituted),{roomId:'r',clientId:'c',content:'secret'}),/identity changed/);
});
