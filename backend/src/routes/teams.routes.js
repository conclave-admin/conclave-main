const router = require('express').Router();
const crypto = require('node:crypto');
const { pool, query } = require('../config/db');
const auth = require('../middlewares/auth.middleware');
const wrap = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/apiResponse');
const rate = require('../middlewares/rateLimit.middleware');
const { revokeRoomAccess } = require('../services/realtimeAccess.service');
const { queueTeamInvite } = require('../services/accountSecurity.service');
const { createTeamProject } = require('../services/project.service');
const { projectNameConflict } = require('../utils/projectIdentity');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = (value) => { if (!UUID.test(value || '')) throw new ApiError(400, 'Invalid identifier'); return value; };
const trimmed = (value, max, label, required = false) => {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim()))
    throw new ApiError(400, `Invalid ${label}`);
  return value.trim();
};
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const makeToken = () => crypto.randomBytes(32).toString('base64url');
async function tx(fn) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const result = await fn(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(); }
}
async function team(db, teamId, userId, allowed = ['owner','admin','member'], lock = false) {
  const result = await db.query(
    `SELECT t.*,tm.role AS my_role FROM teams t JOIN rooms r ON r.id=t.general_room_id JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=$2
     WHERE t.id=$1 ${lock ? 'FOR UPDATE OF t' : ''}`,
    [validId(teamId), userId]);
  const row = result.rows[0];
  if (!row) throw new ApiError(404, 'Team unavailable');
  if (!allowed.includes(row.my_role)) throw new ApiError(403, 'Team administrator required');
  return row;
}
function active(t) { if (t.archived_at) throw new ApiError(409, 'Team is archived'); }
function creationMode(req) {
  if (req.body?.encryptionMode && req.body.encryptionMode !== 'none') throw new ApiError(400, 'Encrypted conversations are unavailable');
}
async function slug(db, name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'general';
  for (let i=0;i<100;i++) {
    const candidate = i ? `${base}-${crypto.randomBytes(4).toString('hex')}` : base;
    if (!(await db.query('SELECT 1 FROM rooms WHERE slug=$1',[candidate])).rowCount) return candidate;
  }
  throw new ApiError(409,'Could not allocate a room name');
}
async function roomMember(db, roomId, userId, role='member', start=0, owner=false) {
  await db.query(`INSERT INTO room_members(room_id,user_id,role,history_start_sequence,team_owner_grant,independent_admin)
    VALUES($1,$2,$3,$4,$5,$3='admin' AND NOT $5) ON CONFLICT(room_id,user_id) DO UPDATE SET
    role=CASE WHEN $5 THEN 'admin' ELSE room_members.role END,
    team_owner_grant=room_members.team_owner_grant OR $5`,[roomId,userId,role,start,owner]);
  if(start>0) await db.query(`UPDATE room_members SET cleared_sequence=GREATEST(cleared_sequence,$3),
    history_start_sequence=GREATEST(history_start_sequence,$3) WHERE room_id=$1 AND user_id=$2`,[roomId,userId,start]);
}
async function joinTeam(db, t, userId) {
  const user = (await db.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL',[userId])).rows[0];
  if (!user) throw new ApiError(409,'Account unavailable');
  await db.query(`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')
    ON CONFLICT(team_id,user_id) DO NOTHING`,[t.id,userId]);
  await roomMember(db,t.general_room_id,userId);
}

router.use(auth);
router.post('/discovery-requests/:roomId',rate({max:20}),wrap(async(req,res)=>{
  const result=await tx(async db=>{
    const room=(await db.query(`SELECT r.id,r.team_id,r.team_discoverable,t.archived_at
      FROM rooms r JOIN teams t ON t.id=r.team_id WHERE r.id=$1 FOR UPDATE OF r,t`,[validId(req.params.roomId)])).rows[0];
    if(!room||!room.team_discoverable||room.archived_at) throw new ApiError(404,'Room unavailable');
    const member=(await db.query('SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2',[room.team_id,req.user.id])).rowCount;
    if(member) throw new ApiError(409,'Already a team member; ask a room admin for access');
    await db.query(`INSERT INTO team_join_requests(team_id,user_id,source_room_id,status)
      VALUES($1,$2,$3,'pending') ON CONFLICT(team_id,user_id) DO UPDATE
      SET source_room_id=EXCLUDED.source_room_id,status='pending',requested_at=NOW(),reviewed_at=NULL,reviewed_by=NULL`,
      [room.team_id,req.user.id,room.id]);
    return {teamId:room.team_id,status:'pending'};
  });
  return ok(res,result,202);
}));
router.post('/',rate({max:10}),wrap(async(req,res)=>{
  const name=trimmed(req.body?.name,120,'team name',true);
  const description=trimmed(req.body?.description || '',2000,'description');
  const creationKey=validId(req.body?.creationKey);
  const result=await tx(async db=>{
    creationMode(req);
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${req.user.id}:${creationKey}`]);
    const previous=(await db.query('SELECT t.* FROM teams t JOIN rooms r ON r.id=t.general_room_id WHERE t.created_by=$1 AND t.creation_key=$2',[req.user.id,creationKey])).rows[0];
    if(previous){if(previous.name!==name||previous.description!==description) throw new ApiError(409,'Creation key was used for another team');return {...previous,my_role:'owner'};}
    const t=(await db.query('INSERT INTO teams(name,description,created_by,owner_id,creation_key) VALUES($1,$2,$3,$3,$4) RETURNING *',[name,description,req.user.id,creationKey])).rows[0];
    await db.query(`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'owner')`,[t.id,req.user.id]);
    const r=(await db.query(`INSERT INTO rooms(name,type,created_by,slug,team_id)
      VALUES('general','group',$1,$2,$3) RETURNING id`,[req.user.id,await slug(db,`general-${t.id.slice(0,8)}`),t.id])).rows[0];
    await roomMember(db,r.id,req.user.id,'admin',0,true);
    await db.query('UPDATE teams SET general_room_id=$2 WHERE id=$1',[t.id,r.id]);
    return {...t,general_room_id:r.id,my_role:'owner'};
  });
  return ok(res,result,201);
}));
router.get('/',wrap(async(req,res)=>{
  const rows=await query(`SELECT t.id,t.name,t.description,t.general_room_id,t.archived_at,tm.role AS my_role,
    (SELECT count(*)::int FROM team_members x WHERE x.team_id=t.id) AS member_count
    FROM teams t JOIN rooms r ON r.id=t.general_room_id JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=$1
    ORDER BY t.archived_at NULLS FIRST,t.created_at DESC LIMIT 100`,[req.user.id]);
  return ok(res,{teams:rows.rows});
}));
router.get('/:teamId',wrap(async(req,res)=>{
  const t=await team({query},req.params.teamId,req.user.id);
  const [members,rooms,projects,invites,requests]=await Promise.all([
    query(`SELECT u.id,u.display_name,u.avatar_url,tm.role,tm.joined_at,
      CASE WHEN $2::boolean THEN u.email END AS email
      FROM team_members tm JOIN users u ON u.id=tm.user_id
      WHERE tm.team_id=$1 AND u.deleted_at IS NULL ORDER BY tm.role='owner' DESC,tm.role='admin' DESC,u.display_name LIMIT 200`,[t.id,t.my_role!=='member']),
    query(`SELECT r.id,r.name,r.type,r.team_discoverable,rm.role AS my_role
      FROM rooms r JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=$2
      WHERE r.team_id=$1 ORDER BY r.id=$3 DESC,r.name LIMIT 200`,[t.id,req.user.id,t.general_room_id]),
    query(`SELECT DISTINCT p.id,p.name,p.description,p.status FROM projects p
      LEFT JOIN project_rooms pr ON pr.project_id=p.id LEFT JOIN room_members rm ON rm.room_id=pr.room_id AND rm.user_id=$2
      WHERE p.team_id=$1 AND (p.created_by=$2 OR rm.user_id IS NOT NULL OR $3::boolean) ORDER BY p.name LIMIT 100`,[t.id,req.user.id,t.my_role!=='member']),
    t.my_role==='member' ? Promise.resolve({rows:[]}) : query(`SELECT id,email_normalized,expires_at,max_uses,uses,revoked_at,created_at
      FROM team_invites WHERE team_id=$1 ORDER BY created_at DESC LIMIT 100`,[t.id]),
    t.my_role==='member' ? Promise.resolve({rows:[]}) : query(`SELECT q.user_id,u.display_name,q.source_room_id,q.status,q.requested_at
      FROM team_join_requests q JOIN users u ON u.id=q.user_id WHERE q.team_id=$1 AND q.status='pending' ORDER BY q.requested_at LIMIT 100`,[t.id])]);
  return ok(res,{team:t,members:members.rows,rooms:rooms.rows,projects:projects.rows,invites:invites.rows,requests:requests.rows});
}));
router.patch('/:teamId',wrap(async(req,res)=>{
  const name=trimmed(req.body?.name,120,'team name',true), description=trimmed(req.body?.description || '',2000,'description');
  const result=await tx(async db=>{ const t=await team(db,req.params.teamId,req.user.id,['owner','admin'],true);active(t);
    return (await db.query('UPDATE teams SET name=$2,description=$3,updated_at=NOW() WHERE id=$1 RETURNING *',[t.id,name,description])).rows[0]; });
  return ok(res,result);
}));
router.post('/:teamId/invites',rate({max:20}),wrap(async(req,res)=>{
  const email=req.body?.email ? trimmed(req.body.email,320,'email').toLowerCase() : null;
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400,'Invalid email');
  const maxUses=email ? 1 : Math.min(100,Math.max(1,Number(req.body?.maxUses)||10));
  const hours=Math.min(720,Math.max(1,Number(req.body?.expiresInHours)||168));
  const token=makeToken();
  const invite=await tx(async db=>{const t=await team(db,req.params.teamId,req.user.id,['owner','admin'],true);active(t);
    const row=(await db.query(`INSERT INTO team_invites(team_id,token_hash,email_normalized,created_by,expires_at,max_uses)
      VALUES($1,$2,$3,$4,NOW()+($5::int * INTERVAL '1 hour'),$6) RETURNING id,team_id,email_normalized,expires_at,max_uses,uses`,
      [t.id,tokenHash(token),email,req.user.id,hours,maxUses])).rows[0];
    return {...row,emailQueued:email?await queueTeamInvite(db,row,token,email,t.name):false};});
  return ok(res,{...invite,token},201);
}));
router.delete('/:teamId/invites/:inviteId',wrap(async(req,res)=>{
  await tx(async db=>{const t=await team(db,req.params.teamId,req.user.id,['owner','admin'],true);active(t);
    await db.query('UPDATE team_invites SET revoked_at=COALESCE(revoked_at,NOW()) WHERE team_id=$1 AND id=$2',[t.id,validId(req.params.inviteId)]);});
  return ok(res,{revoked:true});
}));
router.post('/:teamId/requests/:userId',wrap(async(req,res)=>{
  const decision=req.body?.decision;
  if(!['approve','reject'].includes(decision)) throw new ApiError(400,'Choose approve or reject');
  const result=await tx(async db=>{
    const t=await team(db,req.params.teamId,req.user.id,['owner','admin'],true);active(t);
    const userId=validId(req.params.userId);
    const request=(await db.query(`SELECT * FROM team_join_requests WHERE team_id=$1 AND user_id=$2 AND status='pending' FOR UPDATE`,[t.id,userId])).rows[0];
    if(!request) throw new ApiError(404,'Request unavailable');
    let roomStatus=null;
    if(decision==='approve'){
      await joinTeam(db,t,userId);
      if(request.source_room_id){
        const room=(await db.query('SELECT id FROM rooms WHERE id=$1 AND team_id=$2',[request.source_room_id,t.id])).rows[0];
        if(room){
          await roomMember(db,room.id,userId);roomStatus='joined';
        }
      }
    }
    await db.query(`UPDATE team_join_requests SET status=$3,reviewed_by=$4,reviewed_at=NOW() WHERE team_id=$1 AND user_id=$2`,
      [t.id,userId,decision==='approve'?'approved':'rejected',req.user.id]);
    return {status:decision==='approve'?'approved':'rejected',roomStatus};
  });
  return ok(res,result);
}));
router.patch('/:teamId/rooms/:roomId/discovery',wrap(async(req,res)=>{
  if(typeof req.body?.discoverable!=='boolean') throw new ApiError(400,'Choose discovery visibility');
  const result=await tx(async db=>{
    const t=await team(db,req.params.teamId,req.user.id,['owner','admin'],true);active(t);
    const room=(await db.query(`SELECT r.id,r.type,rm.role FROM rooms r JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=$3
      WHERE r.id=$1 AND r.team_id=$2 FOR UPDATE OF r`,[validId(req.params.roomId),t.id,req.user.id])).rows[0];
    if(!room||room.role!=='admin') throw new ApiError(403,'Team and room admin required');
    if(req.body.discoverable&&room.type!=='public') throw new ApiError(409,'Only public rooms can appear in discovery');
    return (await db.query('UPDATE rooms SET team_discoverable=$2 WHERE id=$1 RETURNING id,team_discoverable',[room.id,req.body.discoverable])).rows[0];
  });
  return ok(res,result);
}));
router.post('/invites/preview',rate({max:40}),wrap(async(req,res)=>{
  const token=req.body?.token;
  if(typeof token!=='string'||token.length>150) throw new ApiError(400,'Invalid invitation');
  const result=await query(`SELECT t.name,u.display_name AS inviter,i.email_normalized IS NOT NULL AS email_bound,
    i.expires_at,i.uses,i.max_uses FROM team_invites i JOIN teams t ON t.id=i.team_id
    JOIN users u ON u.id=i.created_by WHERE i.token_hash=$1 AND i.revoked_at IS NULL
    AND i.expires_at>NOW() AND i.uses<i.max_uses AND t.archived_at IS NULL`,[tokenHash(token)]);
  if(!result.rowCount) throw new ApiError(404,'Invitation unavailable');
  return ok(res,result.rows[0]);
}));
router.post('/invites/accept',rate({max:20}),wrap(async(req,res)=>{
  const token=req.body?.token;
  if(typeof token!=='string'||token.length>150) throw new ApiError(400,'Invalid invitation');
  const result=await tx(async db=>{
    const i=(await db.query(`SELECT i.*,t.name,t.general_room_id,t.archived_at FROM team_invites i JOIN teams t ON t.id=i.team_id
      WHERE i.token_hash=$1 FOR UPDATE OF i,t`,[tokenHash(token)])).rows[0];
    if(!i||i.revoked_at||i.expires_at<=new Date()||i.archived_at) throw new ApiError(404,'Invitation unavailable');
    const u=(await db.query('SELECT email,email_verified_at,deleted_at FROM users WHERE id=$1',[req.user.id])).rows[0];
    if(!u||u.deleted_at) throw new ApiError(403,'Account unavailable');
    if(i.email_normalized && (u.email?.toLowerCase()!==i.email_normalized||!u.email_verified_at))
      throw new ApiError(403,'Verify the invited email address before accepting');
    const existing=await db.query('SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2',[i.team_id,req.user.id]);
    if(!existing.rowCount&&i.uses>=i.max_uses) throw new ApiError(404,'Invitation unavailable');
    if(!existing.rowCount){await joinTeam(db,{id:i.team_id,general_room_id:i.general_room_id},req.user.id);await db.query('UPDATE team_invites SET uses=uses+1 WHERE id=$1',[i.id]);}
    return {teamId:i.team_id,generalRoomId:i.general_room_id,existing:!!existing.rowCount};
  });
  return ok(res,result);
}));
router.post('/:teamId/archive',wrap(async(req,res)=>{await tx(async db=>{const t=await team(db,req.params.teamId,req.user.id,['owner','admin'],true);await db.query('UPDATE teams SET archived_at=COALESCE(archived_at,NOW()) WHERE id=$1',[t.id]);});return ok(res,{archived:true});}));
router.post('/:teamId/restore',wrap(async(req,res)=>{await tx(async db=>{const t=await team(db,req.params.teamId,req.user.id,['owner','admin'],true);await db.query('UPDATE teams SET archived_at=NULL WHERE id=$1',[t.id]);});return ok(res,{archived:false});}));
router.patch('/:teamId/members/:userId',wrap(async(req,res)=>{
  if(!['admin','member'].includes(req.body?.role)) throw new ApiError(400,'Invalid role');
  await tx(async db=>{const t=await team(db,req.params.teamId,req.user.id,['owner'],true);active(t);
    const id=validId(req.params.userId);
    const current=(await db.query('SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2 FOR UPDATE',[t.id,id])).rows[0];
    if(!current) throw new ApiError(404,'Member unavailable');
    if(current.role==='owner') throw new ApiError(409,'Transfer ownership first');
    await db.query('UPDATE team_members SET role=$3 WHERE team_id=$1 AND user_id=$2',[t.id,id,req.body.role]);});
  return ok(res,{updated:true});
}));
router.post('/:teamId/transfer-owner',wrap(async(req,res)=>{
  const target=validId(req.body?.userId);
  await tx(async db=>{const t=await team(db,req.params.teamId,req.user.id,['owner'],true);active(t);
    if(target===req.user.id) return;
    const member=(await db.query('SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2',[t.id,target])).rowCount;
    if(!member) throw new ApiError(404,'Member unavailable');
    await db.query(`UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`,[t.id,req.user.id]);
    await db.query(`UPDATE team_members SET role='owner' WHERE team_id=$1 AND user_id=$2`,[t.id,target]);
    await db.query(`UPDATE room_members rm SET role=CASE WHEN independent_admin THEN 'admin' ELSE 'member' END,
      team_owner_grant=FALSE WHERE rm.user_id=$2 AND rm.team_owner_grant AND rm.room_id IN
      (SELECT id FROM rooms WHERE team_id=$1)`,[t.id,req.user.id]);
    const rooms=(await db.query('SELECT id,message_sequence FROM rooms WHERE team_id=$1',[t.id])).rows;
    for(const room of rooms) {
      const alreadyMember=(await db.query('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2',[room.id,target])).rowCount>0;
      await roomMember(db,room.id,target,'admin',alreadyMember?0:room.message_sequence,true);
    }
    await db.query('UPDATE teams SET owner_id=$2,updated_at=NOW() WHERE id=$1',[t.id,target]);
  });
  return ok(res,{ownerId:target});
}));
async function depart(req,res,userId){
  const io=req.app.get('io');
  const roomIds=await tx(async db=>{const t=await team(db,req.params.teamId,req.user.id,['owner','admin','member'],true);active(t);
    const target=(await db.query('SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2',[t.id,userId])).rows[0];
    if(!target) throw new ApiError(404,'Member unavailable');
    if(target.role==='owner') throw new ApiError(409,'Transfer ownership first');
    if(userId!==req.user.id && t.my_role==='member') throw new ApiError(403,'Team administrator required');
    if(userId!==req.user.id && t.my_role==='admin' && target.role!=='member' && target.role!=='admin') throw new ApiError(403,'Cannot remove owner');
    const rooms=(await db.query('SELECT id FROM rooms WHERE team_id=$1',[t.id])).rows.map(x=>x.id);
    await db.query(`DELETE FROM room_members WHERE user_id=$2 AND room_id=ANY($1::uuid[])`,[rooms,userId]);
    for(const roomId of rooms) await revokeRoomAccess(io,roomId,userId);
    await db.query("UPDATE tasks SET assignee_id=NULL WHERE assignee_id=$2 AND room_id=ANY($1::uuid[]) AND status<>'done'",[rooms,userId]);
    await db.query('UPDATE team_invites SET revoked_at=NOW() WHERE team_id=$1 AND created_by=$2 AND revoked_at IS NULL',[t.id,userId]);
    await db.query('DELETE FROM team_pending_room_grants WHERE team_id=$1 AND user_id=$2',[t.id,userId]);
    await db.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',[t.id,userId]);
    return rooms;
  });
  for(const roomId of roomIds) io?.to(`user:${userId}`).emit('room:resync',{roomId});
  return ok(res,{removed:true,roomIds});
}
router.post('/:teamId/leave',wrap(async(req,res)=>depart(req,res,req.user.id)));
router.delete('/:teamId/members/:userId',wrap(async(req,res)=>depart(req,res,validId(req.params.userId))));
router.post('/:teamId/rooms',wrap(async(req,res)=>{
  const name=trimmed(req.body?.name,120,'room name',true);
  const type=req.body?.type || 'group';
  if(!['group','public'].includes(type)) throw new ApiError(400,'Choose a group or public room');
  const result=await tx(async db=>{const t=await team(db,req.params.teamId,req.user.id,['owner','admin','member'],true);active(t);
    creationMode(req);
    const room=(await db.query(`INSERT INTO rooms(name,type,created_by,slug,team_id)
      VALUES($1,$2,$3,$4,$5) RETURNING id,name,type,team_id`,[name,type,req.user.id,await slug(db,name),t.id])).rows[0];
    await roomMember(db,room.id,req.user.id,'admin');
    if(t.owner_id!==req.user.id) await roomMember(db,room.id,t.owner_id,'admin',0,true);
    else await db.query('UPDATE room_members SET team_owner_grant=TRUE,independent_admin=FALSE WHERE room_id=$1 AND user_id=$2',[room.id,req.user.id]);
    return room;});
  return ok(res,result,201);
}));
router.post('/:teamId/projects',wrap(async(req,res)=>{
  const result=await tx(db=>createTeamProject(db,{
    teamId:req.params.teamId,userId:req.user.id,name:req.body?.name,
    description:req.body?.description,roomIds:req.body?.roomIds
  }));
  return ok(res,result,201);
}));
async function roomTransfer(db,t,roomId,actorId,apply=false){
  const room=(await db.query(`SELECT r.*,rm.role AS actor_role FROM rooms r
    JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=$2 WHERE r.id=$1
    ${apply?'FOR UPDATE OF r':''}`,[roomId,actorId])).rows[0];
  if(!room||room.type==='dm'||room.team_id) throw new ApiError(409,'Only unassigned non-DM rooms can move');
  if(room.actor_role!=='admin') throw new ApiError(403,'Room admin required');
  const external=(await db.query(`SELECT count(*)::int AS count FROM room_members rm
    WHERE rm.room_id=$1 AND NOT EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=$2 AND tm.user_id=rm.user_id)`,[roomId,t.id])).rows[0].count;
  const links=(await db.query(`SELECT count(*)::int AS count FROM project_rooms WHERE room_id=$1`,[roomId])).rows[0].count;
  const owner=(await db.query('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2',[roomId,t.owner_id])).rowCount>0;
  const blockers=[...(external?[`${external} room members must join this team first`]:[]),...(links?['Remove the room from its existing project first']:[])];
  if(apply){if(blockers.length) throw new ApiError(409,blockers.join('; '));
    await db.query('UPDATE rooms SET team_id=$2 WHERE id=$1',[roomId,t.id]);
    if(!owner) await roomMember(db,roomId,t.owner_id,'admin',room.message_sequence,true);
    else await db.query(`UPDATE room_members SET role='admin',team_owner_grant=TRUE,
      independent_admin=(role='admin') WHERE room_id=$1 AND user_id=$2`,[roomId,t.owner_id]);
  }
  return {roomId,blockers,ownerGainsMembership:!owner,historyStartsAfterSequence:owner?null:room.message_sequence};
}
router.get('/:teamId/transfer-preview',wrap(async(req,res)=>{
  const t=await team({query},req.params.teamId,req.user.id,['owner','admin']);active(t);
  const roomId=req.query.roomId, projectId=req.query.projectId;
  if(roomId) return ok(res,await roomTransfer({query},t,validId(roomId),req.user.id));
  if(projectId){const p=(await query('SELECT id,created_by,team_id FROM projects WHERE id=$1',[validId(projectId)])).rows[0];
    if(!p||p.team_id||p.created_by!==req.user.id) throw new ApiError(404,'Project unavailable');
    const links=(await query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE r.team_id IS DISTINCT FROM $2)::int AS outside_team
      FROM project_rooms pr JOIN rooms r ON r.id=pr.room_id WHERE pr.project_id=$1`,[projectId,t.id])).rows[0];
    const blockers=[];
    if(!links.total) blockers.push('Add at least one team room before moving this project');
    if(links.outside_team) blockers.push('Move all linked rooms into this team first');
    return ok(res,{projectId,blockers});}
  throw new ApiError(400,'Choose a room or project');
}));
router.post('/:teamId/rooms/:roomId',wrap(async(req,res)=>{
  const result=await tx(async db=>{const t=await team(db,req.params.teamId,req.user.id,['owner','admin'],true);active(t);
    return roomTransfer(db,t,validId(req.params.roomId),req.user.id,true);});
  return ok(res,result);
}));
router.post('/:teamId/projects/:projectId',wrap(async(req,res)=>{
  const result=await tx(async db=>{const t=await team(db,req.params.teamId,req.user.id,['owner','admin'],true);active(t);
    const p=(await db.query('SELECT id,created_by,team_id FROM projects WHERE id=$1 FOR UPDATE',[validId(req.params.projectId)])).rows[0];
    if(!p||p.team_id||p.created_by!==req.user.id) throw new ApiError(404,'Project unavailable');
    const links=(await db.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE r.team_id IS DISTINCT FROM $2)::int AS outside_team
      FROM project_rooms pr JOIN rooms r ON r.id=pr.room_id WHERE pr.project_id=$1`,[p.id,t.id])).rows[0];
    if(!links.total) throw new ApiError(409,'Add at least one team room before moving this project');
    if(links.outside_team) throw new ApiError(409,'Move linked rooms into this team first');
    try {
      return (await db.query('UPDATE projects SET team_id=$2 WHERE id=$1 RETURNING id,team_id',[p.id,t.id])).rows[0];
    } catch (error) {
      throw projectNameConflict(error) || error;
    }});
  return ok(res,result);
}));

module.exports=router;
