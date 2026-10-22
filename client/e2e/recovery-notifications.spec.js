import {test,expect} from '@playwright/test';

// Exercise the real providers and cache reconciliation with a deterministic
// server boundary. SQL authorization, durable delivery and push transport are
// covered separately against PostgreSQL and Redis in realtime-access.test.js.
test.beforeEach(async({page})=>{
  await page.route('**/src/config/devPreview.js*',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:`${await response.text()}
      window.__emit=(name,payload)=>{if(name==='disconnect')previewSocket.connected=false;if(name==='connect')previewSocket.connected=true;listeners.get(name)?.forEach(fn=>fn(payload));};
      window.__patchMessage=(id,patch)=>Object.assign(previewMessages.find(m=>m.id===id),patch);
      window.__notificationFixture=(seen)=>{previewNotifications.forEach(n=>n.seen=seen);};
    `});
  });
  await page.route('**/src/services/sync.service*',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:`${await response.text()}
      window.__syncReads=0;window.__serverCursor='0';window.__syncChanges=[];
      readSyncPage=async(after)=>{window.__syncReads++;const changes=window.__syncChanges.splice(0);return {cursor:window.__serverCursor,changes,hasMore:false,reset:after===undefined};};
    `});
  });
});

test('reconnect reconciles an older edit and deletion without resurrecting it from a late event',async({page})=>{
  await page.goto('/chats/preview-room');
  await expect(page.getByText('Sounds good. This keeps our real-time path focused and reduces operational overhead.',{exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.__syncReads)).toBeGreaterThan(0);
  await page.evaluate(()=>{
    window.__emit('disconnect');
    window.__patchMessage('dev-message-2',{content:'Edited while this device was disconnected',sync_version:2,edited_at:new Date().toISOString()});
    window.__serverCursor='1';window.__syncChanges=[{kind:'message',entity_id:'dev-message-2',room_id:'preview-room'}];
    window.__emit('connect');
  });
  await expect(page.getByText('Edited while this device was disconnected',{exact:true})).toBeVisible();
  await page.evaluate(()=>{
    window.__patchMessage('dev-message-2',{content:null,is_deleted:true,sync_version:3,deleted_at:new Date().toISOString()});
    window.__serverCursor='2';window.__syncChanges=[{kind:'message',entity_id:'dev-message-2',room_id:'preview-room'}];
    window.__emit('sync:changed',{cursor:'2'});
  });
  await expect(page.getByText('Edited while this device was disconnected',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Message deleted',{exact:true}).first()).toBeVisible();
  await page.evaluate(()=>window.__emit('message:updated',{message:{id:'dev-message-2',room_id:'preview-room',content:'stale body',sync_version:1}}));
  await expect(page.getByText('stale body',{exact:true})).toHaveCount(0);
});

test('focus repairs a missed socket event through HTTP replay',async({page})=>{
  await page.goto('/chats/preview-room');
  await expect(page.getByPlaceholder('Message…')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.__syncReads)).toBeGreaterThan(0);
  await page.evaluate(()=>{
    window.__patchMessage('dev-message-1',{content:'Recovered without a message socket event',sync_version:4});
    window.__serverCursor='4';window.__syncChanges=[{kind:'message',entity_id:'dev-message-1',room_id:'preview-room'}];
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.getByText('Recovered without a message socket event',{exact:true})).toBeVisible();
});

test('duplicate notifications and another device marking them read converge on the server count',async({page})=>{
  await page.goto('/notifications');
  await expect(page.getByRole('button',{name:'Mark all as read'})).toBeEnabled();
  await page.evaluate(()=>{
    window.__notificationFixture(true);
    window.__emit('notification:seen',{updated:999});
    window.__emit('notification:seen',{updated:999});
  });
  await expect(page.getByRole('button',{name:'Mark all as read'})).toBeDisabled();
  await page.evaluate(()=>{
    window.__notificationFixture(false);
    window.__emit('notification',{id:'dev-notif-1'});
    window.__emit('notification',{id:'dev-notif-1'});
  });
  await expect(page.getByRole('button',{name:'Mark all as read'})).toBeEnabled();
  await page.getByRole('button',{name:'Mark all as read'}).click();
  await expect(page.getByRole('button',{name:'Mark all as read'})).toBeDisabled();
});

async function mockPush(page,permission='default'){
  await page.addInitScript(initial=>{
    window.__permissionPrompts=0;window.__pushConfigured=0;window.__pushCleared=0;
    let current=initial;
    Object.defineProperty(window,'Notification',{configurable:true,value:{get permission(){return current;},requestPermission:async()=>{window.__permissionPrompts++;current='granted';return current;}}});
    Object.defineProperty(window,'PushManager',{configurable:true,value:class{}});
  },permission);
  await page.route('**/api/push/config',route=>route.fulfill({json:{data:{configured:true,publicKey:'test-key'}}}));
  await page.route('**/src/lib/pushNotifications*',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:`${await response.text()}
      configureBrowserPush=async()=>{window.__pushConfigured++;return true;};
      clearBrowserPush=async()=>{window.__pushCleared++;};
    `});
  });
}

test('push permission needs an explicit gesture and device opt-out survives focus',async({page})=>{
  await mockPush(page);
  await page.goto('/settings');
  await expect(page.getByRole('button',{name:'Enable in this browser'})).toBeVisible();
  expect(await page.evaluate(()=>window.__permissionPrompts)).toBe(0);
  await page.getByRole('button',{name:'Enable in this browser'}).click();
  await expect(page.getByText('This browser is subscribed.',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.__permissionPrompts)).toBe(1);
  await page.getByRole('button',{name:'Disable in this browser'}).click();
  await expect(page.getByRole('button',{name:'Enable in this browser'})).toBeVisible();
  const registrations=await page.evaluate(()=>window.__pushConfigured);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Background notifications are off in this browser.',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.__pushConfigured)).toBe(registrations);
});

test('denied push permission explains browser settings without prompting again',async({page})=>{
  await mockPush(page,'denied');
  await page.goto('/settings');
  await expect(page.getByText('Notifications are blocked in browser settings. Allow them there, then retry.',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.__permissionPrompts)).toBe(0);
  expect(await page.evaluate(()=>window.__pushCleared)).toBeGreaterThan(0);
});
