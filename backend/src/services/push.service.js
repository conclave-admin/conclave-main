const crypto=require('node:crypto');
const webpush=require('web-push');
const {pool}=require('../config/db');
const env=require('../config/env');
const ApiError=require('../utils/ApiError');
const policy=require('./notificationPolicy.service');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function configured(){try{return Buffer.from(env.push.publicKey||'','base64url').length===65&&Buffer.from(env.push.privateKey||'','base64url').length===32&&Boolean(env.push.subject)&&['mailto:','https:'].includes(new URL(env.push.subject).protocol);}catch{return false;}}
function validateSubscription(value){
  if(!value || typeof value.endpoint!=='string' || value.endpoint.length>2048) throw new ApiError(400,'Invalid push subscription');
  let url;try{url=new URL(value.endpoint);}catch{throw new ApiError(400,'Invalid push endpoint');}
  const host=url.hostname;
  const allowed=['fcm.googleapis.com','gcm-http.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'];
  const extra=env.push.allowedOrigins;
  if(url.protocol!=='https:' || url.hash || url.username || url.password || (url.port&&url.port!=='443') || !(allowed.includes(host)||host.endsWith('.push.services.mozilla.com')||host.endsWith('.notify.windows.com')||extra.includes(url.origin))) throw new ApiError(400,'Unsupported push service');
  for(const [key,size] of [['p256dh',65],['auth',16]]) {
    const text=value.keys?.[key];
    if(typeof text!=='string'||!/^[A-Za-z0-9_-]+={0,2}$/.test(text)||Buffer.from(text,'base64url').length!==size) throw new ApiError(400,'Invalid subscription encryption keys');
  }
  try{crypto.ECDH.convertKey(Buffer.from(value.keys.p256dh,'base64url'),'prime256v1');}catch{throw new ApiError(400,'Invalid subscription encryption key');}
  return {endpoint:url.href,keys:{p256dh:value.keys.p256dh,auth:value.keys.auth},expirationTime:value.expirationTime||null};
}
async function upsert(db,userId,sessionId,sub,bindingId){
  const renewal=crypto.randomBytes(32).toString('base64url');
  const session=await db.query(`SELECT s.expires_at FROM auth_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>NOW() AND u.deleted_at IS NULL FOR SHARE OF s,u`,[sessionId,userId]);
  if(!session.rows.length)throw new ApiError(401,'Push session expired');
  const count=await db.query('SELECT COUNT(*)::int AS count FROM push_subscriptions WHERE user_id=$1 AND endpoint<>$2',[userId,sub.endpoint]);
  if(count.rows[0].count>=20)throw new ApiError(409,'Too many push subscriptions; disable an older browser first');
  const result=await db.query(`INSERT INTO push_subscriptions(user_id,session_id,endpoint,subscription,renewal_hash,binding_id)
    VALUES($1,$2,$3,$4,$5,COALESCE($6::uuid,gen_random_uuid())) ON CONFLICT(endpoint) DO UPDATE SET user_id=$1,session_id=$2,subscription=$4,renewal_hash=$5,
    binding_id=CASE WHEN push_subscriptions.user_id=$1 AND push_subscriptions.session_id=$2 THEN push_subscriptions.binding_id ELSE gen_random_uuid() END,updated_at=NOW()
    RETURNING id,binding_id`,[userId,sessionId,sub.endpoint,sub,digest(renewal),bindingId||null]);
  return {subscriptionId:result.rows[0].id,bindingId:result.rows[0].binding_id,renewalToken:renewal,publicKey:env.push.publicKey,sessionExpiresAt:session.rows[0].expires_at};
}
async function register(userId,sessionId,value){
  if(!configured())throw new ApiError(503,'Background notifications are not configured');
  const sub=validateSubscription(value);const db=await pool.connect();
  try{await db.query('BEGIN');const result=await upsert(db,userId,sessionId,sub);await db.query('COMMIT');return result;}
  catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
async function renew(token,value){
  if(!configured())throw new ApiError(503,'Background notifications are not configured');
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw new ApiError(401,'Push renewal expired');
  const sub=validateSubscription(value);const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const old=(await db.query('SELECT * FROM push_subscriptions WHERE renewal_hash=$1 FOR UPDATE',[digest(token)])).rows[0];
    if(!old)throw new ApiError(401,'Push renewal expired');
    const next=await upsert(db,old.user_id,old.session_id,sub,old.binding_id);
    if(old.id!==next.subscriptionId){
      await db.query(`INSERT INTO push_jobs(notification_id,subscription_id,binding_id,expires_at)
        SELECT notification_id,$2,$3,expires_at FROM push_jobs WHERE subscription_id=$1 AND completed_at IS NULL
        ON CONFLICT(notification_id,subscription_id) DO NOTHING`,[old.id,next.subscriptionId,next.bindingId]);
      await db.query('DELETE FROM push_subscriptions WHERE id=$1',[old.id]);
    }
    await db.query('COMMIT');return next;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
async function remove(userId,endpoint){await pool.query('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2',[userId,endpoint]);}
async function dispatch(limit=50,transport=webpush.sendNotification){
  if(!configured())return 0;
  const token=crypto.randomUUID();
  const jobs=await pool.query(`UPDATE push_jobs SET attempts=attempts+1,lease_until=NOW()+INTERVAL '60 seconds',lease_token=$2
    WHERE id IN (SELECT id FROM push_jobs WHERE completed_at IS NULL AND next_attempt_at<=NOW()
    AND (lease_until IS NULL OR lease_until<NOW()) ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`,[limit,token]);
  for(const job of jobs.rows){
    try {
      if(!(await pool.query("UPDATE push_jobs SET lease_until=NOW()+INTERVAL '60 seconds' WHERE id=$1 AND lease_token=$2 RETURNING id",[job.id,token])).rowCount)continue;
      const sub=await pool.query(`SELECT p.*,s.expires_at FROM push_subscriptions p JOIN auth_sessions s ON s.id=p.session_id
        JOIN users u ON u.id=p.user_id WHERE p.id=$1 AND p.binding_id=$2 AND s.revoked_at IS NULL AND s.expires_at>NOW() AND u.deleted_at IS NULL`,[job.subscription_id,job.binding_id]);
      const checked=await policy.interruption(job.notification_id);
      let outcome='suppressed';
      if(sub.rows.length && checked.allowed && sub.rows[0].user_id===checked.notification.recipient_id && new Date(job.expires_at)>new Date()){
        await transport(sub.rows[0].subscription,JSON.stringify({id:job.notification_id,bindingId:job.binding_id,roomId:checked.notification.room_id,title:'Conclave',body:'You have new activity in Conclave',url:'/notifications'}),{
          vapidDetails:{subject:env.push.subject,publicKey:env.push.publicKey,privateKey:env.push.privateKey},TTL:300,timeout:10000,urgency:'normal',
        });outcome='accepted';
      }
      await pool.query('UPDATE push_jobs SET completed_at=NOW(),outcome=$3,lease_until=NULL WHERE id=$1 AND lease_token=$2',[job.id,token,outcome]);
    }catch(error){
      if([404,410].includes(error.statusCode)){
        await pool.query('DELETE FROM push_subscriptions WHERE id=$1',[job.subscription_id]);
      }else if(job.attempts>=8 || new Date(job.expires_at)<=new Date() || (error.statusCode>=400&&error.statusCode<500&&error.statusCode!==429)){
        await pool.query("UPDATE push_jobs SET completed_at=NOW(),outcome='failed',lease_until=NULL WHERE id=$1 AND lease_token=$2",[job.id,token]);
      }else{
        const header=error.headers?.['retry-after'];const retry=Number(header)||Math.max(0,(Date.parse(header)-Date.now())/1000)||0;
        const seconds=Math.min(900,Math.max(retry,Math.min(300,5*2**job.attempts)));
        await pool.query("UPDATE push_jobs SET lease_until=NULL,next_attempt_at=NOW()+($3::int*INTERVAL '1 second') WHERE id=$1 AND lease_token=$2",[job.id,token,Math.ceil(seconds)]);
      }
    }
  }
  return jobs.rowCount;
}
async function prune(){await pool.query("DELETE FROM push_jobs WHERE completed_at<NOW()-INTERVAL '30 days'");await pool.query('DELETE FROM push_subscriptions p USING auth_sessions s WHERE p.session_id=s.id AND (s.revoked_at IS NOT NULL OR s.expires_at<NOW())');}
let timer;let work=Promise.resolve();
function start(){if(timer)return;let pruned=0;const run=()=>{work=work.then(async()=>{await dispatch();if(Date.now()-pruned>3600000){await prune();pruned=Date.now();}}).catch(e=>console.error('Push worker deferred',e.message));};timer=setInterval(run,3000);timer.unref();run();}
async function stop(){clearInterval(timer);timer=null;await work;}
module.exports={configured,validateSubscription,register,renew,remove,dispatch,start,stop};
