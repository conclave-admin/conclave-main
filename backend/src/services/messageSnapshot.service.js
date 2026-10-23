const {pool}=require('../config/db');
const ApiError=require('../utils/ApiError');
async function snapshots(roomId,viewerId,ids){
  const db=await pool.connect();
  try{
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if(!(await db.query('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2',[roomId,viewerId])).rowCount)throw new ApiError(403,'You are not a member of this room');
    const result=await db.query(`SELECT m.id,m.encrypted_payload,m.state_version,m.client_id,m.album_id,m.forwarded,m.room_sequence,m.room_id,m.sender_id,
      u.profile_version AS sender_profile_version,u.display_name AS sender_name,u.avatar_url AS sender_avatar,
      CASE WHEN m.deleted_at IS NOT NULL THEN NULL ELSE m.content END AS content,
      m.deleted_at IS NOT NULL AS is_deleted,m.reply_to_id,m.edited_at,m.deleted_at,m.created_at,
      COALESCE((SELECT json_agg(json_build_object('id',a.id,'filename',a.filename,'size',a.size_bytes,'mime_type',a.file_type,'url',a.file_url,'width',a.width,'height',a.height,'preview_url',a.preview_url,'duration',a.duration)) FROM attachments a WHERE a.message_id=m.id),'[]') AS attachments,
      COALESCE((SELECT json_agg(mm.user_id) FROM message_mentions mm WHERE mm.message_id=m.id),'[]') AS mentioned_user_ids
      FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.room_id=$1 AND m.id=ANY($2::uuid[]) ORDER BY m.room_sequence`,[roomId,ids]);
    let rows=await require('./reaction.service').attachReactions(result.rows,viewerId,{db});
    rows=await require('./messagePin.service').attachPins(rows,viewerId,{db});
    rows=await require('./poll.service').attachPolls(rows,{db});
    rows=await require('./messageReceipt.service').attachReceiptSummaries(rows,db);
    await db.query('COMMIT');
    return {messages:rows,missingIds:ids.filter(id=>!rows.some(row=>row.id===id)),nextCursor:null};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
module.exports={snapshots};
