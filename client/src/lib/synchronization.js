export function mergeServerMessages(current, incoming, missingIds = []) {
  const removed = new Set(missingIds); const result = new Map(current.filter(m=>!removed.has(m.id)).map(m=>[m.id,m]));
  for(const row of incoming) {
    const previous=result.get(row.id);
    let next=row;
    if(previous&&(Number(previous.sync_version||0)>Number(row.sync_version||0)||(previous.is_deleted||previous.deleted_at)&&!row.is_deleted&&!row.deleted_at))next=previous;
    const profile=Number(previous?.sender_profile_version||0)>Number(row.sender_profile_version||0)?previous:row;
    if(profile?.sender_profile_version)next={...next,sender_name:profile.sender_name,sender_avatar:profile.sender_avatar,sender_profile_version:profile.sender_profile_version};
    result.set(row.id,next);
  }
  return [...result.values()].sort((a,b)=>{
    if(a.room_sequence!=null&&b.room_sequence!=null)return Number(a.room_sequence)-Number(b.room_sequence);
    return new Date(a.created_at)-new Date(b.created_at)||String(a.id).localeCompare(String(b.id));
  });
}
// One serialized replay per account. Persist progress only after EVERY cache
// reconciler succeeds. Failure retries the same page, never skipping a change.
export function createSyncRunner({readPage,apply,loadCursor,saveCursor,onError=()=>{},later=setTimeout,cancel=clearTimeout}) {
  let stopped=false;let dirty=false;let full=false;let work=null;let retry;let failures=0;
  const request=(reset=false)=>{
    if(stopped)return Promise.resolve();dirty=true;full ||= reset;
    if(work)return work;
    let resetOnRetry=false;
    work=(async()=>{
      while(dirty&&!stopped){
        dirty=false;const force=full;full=false;let cursor=force?undefined:loadCursor();let first=true;let more;
        resetOnRetry=force;
        do {
          const page=await readPage(cursor);
          resetOnRetry ||= page.reset;
          if(stopped)return;
          await apply({...page,reset:page.reset||(first&&force),isCurrent:()=>!stopped});
          if(stopped)return;
          saveCursor(page.cursor);cursor=page.cursor;more=page.hasMore;first=false;resetOnRetry=false;
        }while(more&&!stopped);
        failures=0;
      }
    })().catch(error=>{
      if(stopped)return;dirty=false;full ||= resetOnRetry;onError(error);failures++;
      if(retry)cancel(retry);retry=later(()=>{retry=null;request();},Math.min(60000,2000*2**Math.min(failures,5)));
    }).finally(()=>{work=null;if(dirty&&!stopped)request();});
    return work;
  };
  return {request,stop(){stopped=true;if(retry)cancel(retry);}};
}
