'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

// Every run owns a randomly named database. Never run the cutover against the
// database in DATABASE_URL: it is used only to create the disposable one.
test('migration purges populated encrypted rooms and preserves other data', { timeout: 120000 }, async () => {
  const adminUrl = process.env.DATABASE_URL || 'postgres://app:app@127.0.0.1:5432/postgres';
  const name = `conclave_cutover_${randomBytes(12).toString('hex')}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  const admin = new Client({ connectionString: adminUrl });
  let db, created = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    db = new Client({ connectionString: url.toString() }); await db.connect();
    const dir = path.join(__dirname, '../database/migrations');
    for (const file of fs.readdirSync(dir).filter(x => /^\d+.*\.sql$/.test(x) && x < '061').sort()) {
      await db.query('BEGIN');
      try { await db.query(fs.readFileSync(path.join(dir, file), 'utf8')); await db.query('COMMIT'); }
      catch (error) { await db.query('ROLLBACK'); throw new Error(`${file}: ${error.message}`, { cause: error }); }
    }
    const user = randomUUID(), plain = randomUUID(), v1 = randomUUID(), v2 = randomUUID(), team = randomUUID(), mixedTeam = randomUUID(), mixedGeneral = randomUUID(), mixedSurvivor = randomUUID(), plainMessage = randomUUID(), encryptedMessage = randomUUID(), device = randomUUID(), object = randomUUID();
    await db.query(`INSERT INTO users(id,email,password_hash,display_name) VALUES($1,'cutover@example.test','hash','Owner')`, [user]);
    const tokenId = randomUUID();
    await db.query(`INSERT INTO account_tokens(id,user_id,purpose,token_hash,expires_at) VALUES($1,$2,'reset_password','mail-token-hash',NOW()+INTERVAL '1 hour')`,[tokenId,user]);
    await db.query(`INSERT INTO account_mail_jobs(token_id,encrypted_payload) VALUES($1,'{"ciphertext":"keep-mail"}')`,[tokenId]);
    await db.query(`INSERT INTO teams(id,name,created_by,owner_id) VALUES($1,'Unrelated team',$2,$2)`, [team,user]);
    await db.query(`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'owner')`, [team,user]);
    await db.query(`INSERT INTO rooms(id,name,type,created_by,slug,encryption_mode,team_id) VALUES
      ($1,'Plain','group',$4,'plain-room','none',$5),($2,'V1','private',$4,'encrypted-one','e2ee-v1',NULL),($3,'V2','group',$4,'encrypted-two','e2ee-v2',NULL)`, [plain,v1,v2,user,team]);
    await db.query('UPDATE teams SET general_room_id=$2 WHERE id=$1', [team,plain]);
    await db.query(`INSERT INTO teams(id,name,created_by,owner_id) VALUES($1,'Mixed team',$2,$2)`, [mixedTeam,user]);
    await db.query(`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'owner')`, [mixedTeam,user]);
    await db.query(`INSERT INTO rooms(id,name,type,created_by,slug,encryption_mode,team_id) VALUES
      ($1,'Encrypted general','group',$3,'mixed-old','e2ee-v1',$4),
      ($2,'Surviving room','group',$3,'mixed-survivor','none',$4)`,[mixedGeneral,mixedSurvivor,user,mixedTeam]);
    await db.query(`INSERT INTO room_members(room_id,user_id,role,team_owner_grant) VALUES($1,$3,'admin',TRUE),($2,$3,'admin',TRUE)`,[mixedGeneral,mixedSurvivor,user]);
    await db.query('UPDATE teams SET general_room_id=$2,archived_at=NOW() WHERE id=$1',[mixedTeam,mixedGeneral]);
    await db.query(`INSERT INTO room_members(room_id,user_id,role,team_owner_grant) VALUES($1,$4,'admin',TRUE),($2,$4,'admin',FALSE),($3,$4,'admin',FALSE)`, [plain,v1,v2,user]);
    await db.query(`INSERT INTO messages(id,room_id,sender_id,content,encrypted_payload) VALUES($1,$3,$5,'keep',NULL),($2,$4,$5,'[Encrypted message]', '{"ciphertext":"opaque"}')`, [plainMessage,encryptedMessage,plain,v1,user]);
    await db.query(`UPDATE messages SET reply_to_id=$2,thread_root_id=$2 WHERE id=$1`,[plainMessage,encryptedMessage]);
    await db.query(`INSERT INTO attachments(message_id,filename,file_url,file_type,public_id,resource_type) VALUES
      ($1,'cipher.bin','r2://bucket/enc','application/vnd.conclave.encrypted','encrypted-attachment','r2'),
      ($2,'plain.txt','r2://bucket/plain','text/plain','plain-attachment','r2')`, [encryptedMessage,plainMessage]);
    await db.query(`INSERT INTO file_uploads(uploader_id,file_url,filename,mime_type,attached_message_id,public_id,resource_type) VALUES
      ($1,'r2://bucket/enc','cipher.bin','application/vnd.conclave.encrypted',$2,'encrypted-attachment','r2'),
      ($1,'r2://bucket/plain','plain.txt','text/plain',$3,'plain-attachment','r2')`, [user,encryptedMessage,plainMessage]);
    await db.query(`INSERT INTO encryption_v2_devices(id,user_id,credential) VALUES($1,$2,'\\x01')`, [device,user]);
    const eventId = randomUUID();
    await db.query(`INSERT INTO encryption_v2_mls_rooms(room_id,group_id) VALUES($1,$2)`,[v2,randomUUID()]);
    await db.query(`INSERT INTO encryption_v2_mls_events(id,room_id,sender_device_id,recipient_device_id,epoch,sequence,kind,payload,request_digest)
      VALUES($1,$2,$3,$3,0,1,'welcome','\\x01',decode(repeat('cd',32),'hex'))`,[eventId,v2,device]);
    await db.query(`INSERT INTO encryption_v2_device_grants(room_id,device_id,user_id,start_sequence,state,welcome_id) VALUES($1,$2,$3,0,'active',$4)`,[v2,device,user,eventId]);
    await db.query(`INSERT INTO encryption_v2_objects(id,room_id,sender_device_id,object_key,digest,size_bytes) VALUES($1,$2,$3,'encrypted-v2-object',decode(repeat('ab',32),'hex'),17)`, [object,v2,device]);
    await db.query(`INSERT INTO media_upload_sessions(uploader_id,room_id,client_id,object_key,upload_id,filename,mime_type,size_bytes,status) VALUES
      ($1,$2,$3,'encrypted-pending','upload-1','x','application/vnd.conclave.encrypted',25,'uploading'),
      ($1,$4,$5,'plain-pending','upload-2','x','text/plain',25,'uploading')`, [user,v1,randomUUID(),plain,randomUUID()]);
    await db.query(`INSERT INTO media_upload_sessions(uploader_id,room_id,client_id,object_key,upload_id,filename,mime_type,size_bytes,status) VALUES($1,$2,$3,'encrypted-completed','upload-3','x','application/vnd.conclave.encrypted',25,'completed')`,[user,v1,randomUUID()]);
    await db.query(`INSERT INTO file_uploads(uploader_id,file_url,filename,mime_type,public_id,resource_type) VALUES($1,'r2://bucket/unclaimed','x','application/vnd.conclave.encrypted','encrypted-completed','r2')`,[user]);
    await db.query(`INSERT INTO file_uploads(uploader_id,file_url,filename,mime_type,public_id,resource_type) VALUES($1,'r2://bucket/single','x','application/vnd.conclave.encrypted','encrypted-single','r2')`,[user]);
    await db.query(`INSERT INTO attachments(message_id,filename,file_url,file_type,public_id,resource_type) VALUES
      ($1,'shared','r2://bucket/shared','text/plain','shared-object','r2'),
      ($2,'shared','r2://bucket/shared','application/vnd.conclave.encrypted','shared-object','r2')`,[plainMessage,encryptedMessage]);
    await db.query(`INSERT INTO tasks(room_id,source_message_id,title,created_by) VALUES($1,$2,'Protected task',$3)`, [v1,encryptedMessage,user]);
    const migration = fs.readFileSync(path.join(dir, '061_remove_message_e2ee.sql'),'utf8');
    // A failed cutover must roll back schema changes, room deletion, queued
    // jobs and trigger state together before the runner may safely retry.
    await db.query('BEGIN');
    await db.query(migration);
    await assert.rejects(db.query('SELECT 1/0'), error => error.code === '22012');
    await db.query('ROLLBACK');
    assert.equal((await db.query('SELECT 1 FROM rooms WHERE id=$1',[v1])).rowCount,1);
    assert.equal((await db.query('SELECT 1 FROM storage_deletion_jobs')).rowCount,0);
    assert.equal((await db.query("SELECT tgenabled FROM pg_trigger WHERE tgname='encryption_v2_mode_guard'")).rows[0].tgenabled,'O');
    await db.query('BEGIN');
    try { await db.query(migration); await db.query('COMMIT'); }
    catch (error) { await db.query('ROLLBACK'); throw error; }
    const rooms = await db.query('SELECT id FROM rooms ORDER BY id');
    assert.equal(rooms.rowCount, 3);
    assert.ok(rooms.rows.some(x => x.id===plain));
    assert.ok(rooms.rows.some(x => x.id===mixedSurvivor));
    const kept = (await db.query('SELECT content,reply_to_id,thread_root_id FROM messages WHERE id=$1',[plainMessage])).rows[0];
    assert.deepEqual(kept,{content:'keep',reply_to_id:null,thread_root_id:null});
    assert.equal((await db.query('SELECT 1 FROM teams WHERE id=$1 AND general_room_id=$2',[team,plain])).rowCount,1);
    assert.equal((await db.query('SELECT encrypted_payload FROM account_mail_jobs WHERE token_id=$1',[tokenId])).rows[0].encrypted_payload.ciphertext,'keep-mail');
    const jobs = (await db.query('SELECT object_key,upload_id FROM storage_deletion_jobs ORDER BY object_key,upload_id')).rows;
    const replacement = await db.query(`SELECT r.id FROM teams t JOIN rooms r ON r.id=t.general_room_id
      JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=t.owner_id AND rm.role='admin'
      WHERE t.id=$1 AND t.archived_at IS NOT NULL AND r.name='general'`,[mixedTeam]);
    assert.equal(replacement.rowCount,1);
    assert.deepEqual(jobs, [{object_key:'encrypted-attachment',upload_id:''},{object_key:'encrypted-completed',upload_id:''},{object_key:'encrypted-pending',upload_id:''},{object_key:'encrypted-pending',upload_id:'upload-1'},{object_key:'encrypted-single',upload_id:''},{object_key:'encrypted-v2-object',upload_id:''}]);
    const uploads = (await db.query('SELECT public_id,retired_at,attached_message_id FROM file_uploads ORDER BY public_id')).rows;
    assert.ok(uploads[0].retired_at); assert.equal(uploads[0].attached_message_id,null);
    assert.ok(uploads[1].retired_at); assert.equal(uploads[1].attached_message_id,null);
    assert.ok(uploads[2].retired_at); assert.equal(uploads[2].attached_message_id,null);
    assert.equal(uploads[3].retired_at,null); assert.equal(uploads[3].attached_message_id,plainMessage);
    assert.equal((await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='rooms' AND column_name='encryption_mode'")).rowCount,0);
    assert.equal((await db.query("SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'encryption%'")).rowCount,0);
    const triggers = await db.query(`SELECT tgname,tgenabled FROM pg_trigger WHERE tgname IN ('team_message_change_guard','team_task_change_guard','team_decision_change_guard','team_room_membership_archive_guard','team_owner_room_guard')`);
    assert.equal(triggers.rowCount,5); assert.ok(triggers.rows.every(row => row.tgenabled === 'O'));
    await db.query(`INSERT INTO messages(room_id,sender_id,content) VALUES($1,$2,'after cutover')`,[plain,user]);
    await assert.rejects(db.query(`INSERT INTO messages(room_id,sender_id,content) VALUES($1,$2,'orphan')`,[randomUUID(),user]), error => error.code === '23503');
    await assert.rejects(db.query(`INSERT INTO messages(room_id,sender_id,content) VALUES($1,$2,'archived')`,[mixedSurvivor,user]), error => error.code === '23514');
    process.env.DATABASE_URL = url.toString();
    const r2 = require('../src/config/r2');
    const deleted = [], aborted = [];
    r2.isConfigured = () => true;
    r2.deleteObject = async key => { deleted.push(key); };
    r2.abortMultipart = async (key,uploadId) => { aborted.push([key,uploadId]); };
    const cleanup = require('../src/services/storageCleanup.service');
    const pool = require('../src/config/db').pool;
    try {
      const result = await cleanup.runStorageCleanup();
      assert.equal(result.failed,0); assert.equal(result.completed,6);
      assert.deepEqual(aborted,[['encrypted-pending','upload-1']]);
      assert.deepEqual(deleted.sort(),['encrypted-attachment','encrypted-completed','encrypted-pending','encrypted-single','encrypted-v2-object']);
      assert.equal((await db.query('SELECT 1 FROM storage_deletion_jobs')).rowCount,0);
    } finally { await pool.end(); }
  } finally {
    if (db) await db.end().catch(() => {});
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
