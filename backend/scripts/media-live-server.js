// Disposable database + real R2. This never uses the application's existing DB
// for test rows. Each uploaded object is removed when this process shuts down.
const { Client } = require('pg');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const fs = require('node:fs/promises');
const env = require('../src/config/env');
const r2 = require('../src/config/r2');
const root = path.resolve(__dirname, '..');
const database = `conclave_browser_${randomBytes(12).toString('hex')}`;
const url = new URL(env.databaseUrl); url.pathname = `/${database}`;
const admin = new Client({ connectionString: env.databaseUrl });
let child; let created = false; let stopping = false;
async function cleanup(code = 0) {
  if (stopping) return; stopping = true;
  if (child && child.exitCode === null) {
    const stopped = once(child, 'exit').catch(() => {}); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000); timer.unref(); await stopped; clearTimeout(timer);
  }
  if (created) {
    const db = new Client({ connectionString: url.toString() }); const remaining = [];
    try {
      await db.connect();
      const files = await db.query("SELECT DISTINCT public_id FROM file_uploads WHERE resource_type='r2' AND public_id IS NOT NULL");
      for (const row of files.rows) {
        let deleted = false;
        for (let attempt = 0; attempt < 3 && !deleted; attempt++) { try { await r2.deleteObject(row.public_id); deleted = true; } catch {} }
        if (!deleted) remaining.push(row.public_id);
      }
      const sessions = await db.query('SELECT object_key, upload_id FROM media_upload_sessions');
      for (const row of sessions.rows) await r2.abortMultipart(row.object_key,row.upload_id).catch(() => {});
      if (remaining.length) {
        const manifest = `/tmp/${database}-storage-cleanup.json`;
        await fs.writeFile(manifest, JSON.stringify({ bucket: r2.bucket, keys: remaining },null,2));
        console.error(`Storage cleanup needs retry: ${manifest}`); code = 1;
      }
    } catch (error) { console.error('Live cleanup failed', { code: error.code || error.name }); code = 1; }
    finally { await db.end().catch(() => {}); }
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[database]);
    await admin.query(`DROP DATABASE ${database}`);
  }
  await admin.end().catch(() => {}); process.exit(code);
}
process.on('SIGTERM', () => cleanup()); process.on('SIGINT', () => cleanup());
(async () => {
  if (!r2.isConfigured()) throw new Error('Real R2 credentials are required');
  await admin.connect(); await admin.query(`CREATE DATABASE ${database}`); created = true;
  const childEnv = { ...process.env, RATE_LIMIT_KEY_PREFIX: database, DATABASE_URL: url.toString(), PORT: '7100', CLIENT_ORIGIN: 'http://localhost:5177', NODE_ENV: 'test', R2_DIRECT_UPLOADS_ENABLED: 'false' };
  const migration = spawn(process.execPath,['database/migrate.js'],{cwd:root,env:childEnv,stdio:['ignore','ignore','inherit']});
  const [exit] = await once(migration,'exit'); if (exit !== 0) throw new Error('Live smoke migration failed');
  child = spawn(process.execPath,['src/server.js'],{cwd:root,env:childEnv,stdio:['ignore','inherit','inherit']});
  child.once('exit',(code) => { if (!stopping) cleanup(code || 1); });
})().catch(error => { console.error('Live smoke startup failed',{code:error.code || error.name}); cleanup(1); });
