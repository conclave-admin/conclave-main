import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = new EventTarget();
const values = new Map();
globalThis.localStorage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
const session = await import('../src/lib/session.js');
const user='00000000-0000-4000-8000-000000000001',room='00000000-0000-4000-8000-000000000002';
test('public-computer session and token refresh never persist auth credentials',()=>{
 const token=`e30.${btoa(JSON.stringify({sub:user,sid:room}))}.public-fixture`;
 session.saveSession({accessToken:token,refreshToken:'public-refresh-fixture',user:{id:user}});
 session.useMemoryOnlySession();assert.equal(session.getAccessToken(),token);assert.equal(session.getSessionUserId(),user);
 for(const key of ['accessToken','refreshToken','conclave.session-user'])assert.equal(values.has(key),false);
 session.saveSession({accessToken:token,refreshToken:'rotated-public-fixture'});assert.equal(session.getRefreshToken(),'rotated-public-fixture');assert.equal(values.has('refreshToken'),false);
 session.clearSession();assert.equal(session.getAccessToken(),null);
});
