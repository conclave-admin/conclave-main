const test=require('node:test');const assert=require('node:assert/strict');
const {allowsInterruption}=require('../src/services/notificationPolicy.service');
const {validateSubscription}=require('../src/services/push.service');
const crypto=require('node:crypto');
test('notification interruption preferences apply global, type and room overrides',()=>{
  assert.equal(allowsInterruption({},'new_message'),true);
  assert.equal(allowsInterruption({push_enabled:false},'mention'),false);
  assert.equal(allowsInterruption({activity_level:'none'},'mention'),false);
  assert.equal(allowsInterruption({activity_level:'mentions'},'new_message'),false);
  assert.equal(allowsInterruption({activity_level:'mentions'},'mention'),true);
  assert.equal(allowsInterruption({muted:{mention:true}},'mention'),false);
  assert.equal(allowsInterruption({},'mention',true),false);
});
test('subscription validation rejects private endpoints, provider lookalikes and malformed keys',()=>{
  const curve=crypto.createECDH('prime256v1');const keys={p256dh:curve.generateKeys().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')};
  assert.equal(validateSubscription({endpoint:'https://fcm.googleapis.com/fcm/send/example',keys}).endpoint,'https://fcm.googleapis.com/fcm/send/example');
  for(const endpoint of ['http://fcm.googleapis.com/path','https://127.0.0.1/path','https://localhost/path','https://fcm.googleapis.com.evil.test/path','https://fcm.googleapis.com:8443/path','https://user:secret@fcm.googleapis.com/path'])assert.throws(()=>validateSubscription({endpoint,keys}),error=>error.status===400);
  assert.throws(()=>validateSubscription({endpoint:'https://fcm.googleapis.com/path',keys:{...keys,auth:'bad'}}),error=>error.status===400);
  assert.throws(()=>validateSubscription({endpoint:'https://fcm.googleapis.com/path',keys:{...keys,p256dh:Buffer.alloc(65).toString('base64url')}}),error=>error.status===400);
});
