import { test, expect } from '@playwright/test';
const ORIGIN = 'http://localhost:5174';
const roomId='20000000-0000-4000-8000-000000000009';
const targetId='30000000-0000-4000-8000-000000000009';
const user={id:'10000000-0000-4000-8000-000000000009',display_name:'Shared Browser',email:'shared@example.test'};
const room={id:roomId,name:'Shared Files Room',display_name:'Shared Files Room',type:'group',my_role:'admin',members:[{...user,role:'admin'}],member_count:1};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const item=(id,name,type)=>({id,filename:name,mime_type:type,url:`r2://private/${id}`,size:70,width:160,height:90,
 preview_url:`data:image/png;base64,${png.toString('base64')}`,message_id:targetId,sender_name:'Shared Sender',created_at:'2026-10-20T12:00:00Z'});
async function setup(page) {
 const state={requests:[],history:[],originals:0,failInitial:true,failMore:true,audioGate:null,audioEmpty:false};
 await page.route('**/socket.io/**',route=>route.abort());
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());const path=url.pathname;
  let data=[];
  if(path.endsWith('/users/me'))data=user;
  else if(path.endsWith(`/rooms/${roomId}`))data=room;
  else if(path.endsWith('/rooms'))data=[room];
  else if(path.endsWith(`/messages/room/${roomId}/media`)){
   const kind=url.searchParams.get('kind');const cursor=url.searchParams.get('cursor');state.requests.push({kind,cursor,after:url.searchParams.get('after')});
   if(url.searchParams.get('after'))data={media:[],nextCursor:null};
   else if(kind==='media'&&!cursor&&state.failInitial){state.failInitial=false;return route.fulfill({status:503,json:{success:false,message:'Shared files temporarily unavailable'}});}
   else if(kind==='media'&&cursor&&state.failMore){state.failMore=false;return route.fulfill({status:503,json:{success:false,message:'Next page unavailable'}});}
   else if(kind==='media')data=cursor?{media:[item('photo-2','second-photo.png','image/png')],nextCursor:null}:{media:[item('photo-1','private-photo.png','image/png')],nextCursor:'next-photo-page'};
   else if(kind==='documents')data={media:[item('document-1','a-very-long-document-name-'.repeat(5)+'.pdf','application/pdf')],nextCursor:null};
   else {if(state.audioGate)await state.audioGate;data={media:state.audioEmpty?[]:[item('audio-1','voice.ogg','audio/ogg')],nextCursor:null};}
  }
  else if(path.endsWith(`/messages/room/${roomId}`)){
   state.history.push(url.searchParams.get('around'));
   const anchored=url.searchParams.get('around');
   if(anchored==='gone')return route.fulfill({status:404,json:{success:false,message:'Message no longer available'}});
   data={messages:[{id:anchored||'latest-message',room_id:roomId,sender_id:user.id,sender_name:user.display_name,content:anchored?'SHARED-MESSAGE-TARGET':'LATEST-MESSAGE',created_at:'2026-10-20T12:00:00Z',room_sequence:anchored?5:500,reactions:[],pins:{mine:[],room:null},attachments:[]}],nextCursor:null};
  }
  else if(path.includes('/messages/')&&path.endsWith('/pinned'))data={messages:[]};
  else if(path.includes('/decisions'))data={decisions:[]};
  else if(path.includes('/notifications'))data={notifications:[],unreadCount:0};
  else if(path.endsWith('/preview-url'))data={url:`data:image/png;base64,${png.toString('base64')}`};
  else if(path.includes('/attachments/')){state.originals++;return route.fulfill({contentType:'image/png',body:png});}
  return route.fulfill({json:{success:true,data}});
 });
 await page.goto(`${ORIGIN}/login`);
 await page.evaluate(user=>{
  const payload=btoa(JSON.stringify({sub:user.id,email:user.email,exp:Math.floor(Date.now()/1000)+3600})).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  localStorage.setItem('accessToken',`e30.${payload}.signature`);localStorage.setItem('refreshToken','shared-test-refresh');
 },user);
 await page.goto(`${ORIGIN}/chats/${roomId}/info`);
 return state;
}
test.beforeEach(async({},info)=>test.skip(!info.project.name.startsWith('app-'),'runs real auth on public fixture server using each viewport'));

test('shared files paginate, retry without losing rows, switch sections and jump to a bounded message view',async({page})=>{
 const state=await setup(page);const panel=page.getByRole('region',{name:'Shared files'});
 await expect(panel.getByRole('alert')).toContainText('Shared files temporarily unavailable');
 await expect(panel.getByText('No photos or videos have been shared yet.',{exact:true})).toHaveCount(0);
 await panel.getByRole('button',{name:'Retry shared files'}).click();
 await expect(panel.getByRole('img',{name:'private-photo.png',exact:true})).toBeVisible();expect(state.originals).toBe(0);
 await panel.getByRole('button',{name:'Load more shared files'}).click();
 await expect(panel.getByRole('alert')).toContainText('Next page unavailable');
 await expect(panel.locator('[data-shared-file-id="photo-1"]')).toBeVisible();
 await panel.getByRole('button',{name:'Retry shared files'}).click();
 await expect(panel.locator('[data-shared-file-id]')).toHaveCount(2);
 await expect(panel.getByRole('button',{name:'Load more shared files'})).toHaveCount(0);
 await panel.getByRole('button',{name:'Documents',exact:true}).click();
 await expect(panel.locator('[data-shared-file-id="document-1"]')).toBeVisible();
 expect(state.originals).toBe(0);
 await panel.getByRole('button',{name:'Audio',exact:true}).click();
 await expect(panel.locator('[data-shared-file-id="audio-1"]')).toBeVisible();
 expect(state.originals).toBe(0);
 const saved=page.waitForEvent('download');
 await panel.getByRole('button',{name:'Download voice.ogg',exact:true}).click();
 expect((await saved).suggestedFilename()).toBe('voice.ogg');expect(state.originals).toBe(1);
 state.audioEmpty=true;
 await panel.getByRole('button',{name:'Refresh shared files',exact:true}).click();
 await expect(panel.getByText('No audio has been shared yet.',{exact:true})).toBeVisible();
 await panel.getByRole('button',{name:'Media',exact:true}).click();
 await panel.getByRole('link',{name:'Show message for private-photo.png',exact:true}).click();
 await expect(page).toHaveURL(new RegExp(`message=${targetId}`));
 await expect(page.locator(`[data-message-id="${targetId}"]`)).toHaveClass(/message-jump-highlight/);
 await expect(page.getByText('SHARED-MESSAGE-TARGET',{exact:true})).toBeVisible();
 expect(state.history.length).toBeGreaterThan(0);
 expect(state.history.every(anchor=>anchor===targetId)).toBe(true);
 await page.getByRole('button',{name:'Return to latest',exact:true}).click();
 await expect(page.getByText('LATEST-MESSAGE',{exact:true})).toBeVisible();
 expect([...new Set(state.history)]).toEqual([targetId,null]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
});

test('switching sections cancels stale results and clearing hides shared files for this device',async({page})=>{
 const state=await setup(page);const panel=page.getByRole('region',{name:'Shared files'});
 let release;state.audioGate=new Promise(resolve=>{release=resolve;});
 await panel.getByRole('button',{name:'Audio',exact:true}).click();
 await expect(panel.getByRole('status')).toContainText('Loading shared audio');
 await expect.poll(()=>state.requests.some(request=>request.kind==='audio')).toBe(true);
 await panel.getByRole('button',{name:'Documents',exact:true}).click();
 await expect(panel.locator('[data-shared-file-id="document-1"]')).toBeVisible();release();
 await expect(panel.getByRole('button',{name:'Documents',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(panel.locator('[data-shared-file-id="document-1"]')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
 await page.getByRole('button',{name:'Clear messages for me',exact:true}).click();
 await expect(panel.getByText('No shared files in this section since you cleared the conversation.',{exact:true})).toBeVisible();
 expect(state.requests.at(-1).after).toBeTruthy();
});

test('a removed original message shows a useful error and offers return to latest',async({page})=>{
 await setup(page);await page.goto(`${ORIGIN}/chats/${roomId}?message=gone`);
 await expect(page.getByRole('alert')).toContainText('Message no longer available');
 await page.getByRole('button',{name:'Return to latest',exact:true}).click();
 await expect(page.getByText('LATEST-MESSAGE',{exact:true})).toBeVisible();
});
