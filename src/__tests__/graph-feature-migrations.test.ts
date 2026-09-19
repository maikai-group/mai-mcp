import { it,expect } from 'vitest';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { requireDisposableTestDbUrl } from './test-db-url.js';
it('replays and rolls back lesson migration without changing semantic schema',async()=>{
  const url=requireDisposableTestDbUrl(),admin=new Pool({connectionString:url});
  const name='mai_plan23_schema_'+randomBytes(6).toString('hex');
  const testUrl=new URL(url);testUrl.pathname='/'+name;let db:Pool|null=null;
  try{
    await admin.query(`CREATE DATABASE "${name}"`);db=new Pool({connectionString:testUrl.href});
    await db.query(await readFile('db/schema.sql','utf8'));
    const catalog=async()=>db?(await db.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'graph_code_%' ORDER BY table_name,ordinal_position")).rows:[];
    const before=await catalog();expect(before.length).toBeGreaterThan(0);
    const up=await readFile('db/migrations/2026-09-08-graph-node-lessons.sql','utf8');
    const down=await readFile('db/migrations/2026-09-08-graph-node-lessons.rollback.sql','utf8');
    await db.query(up);await db.query(up);
    await db.query(down);await db.query(down);
    expect((await db.query("SELECT to_regclass('graph_lesson_attachments') a,to_regclass('graph_lesson_attachment_events') e")).rows[0]).toEqual({a:null,e:null});
    expect(await catalog()).toEqual(before);
    await db.query(up);await db.query(up);
    expect((await db.query("SELECT to_regclass('graph_lesson_attachments')::text a,to_regclass('graph_lesson_attachment_events')::text e")).rows[0]).toEqual({a:'graph_lesson_attachments',e:'graph_lesson_attachment_events'});
    expect(await catalog()).toEqual(before);
  }finally{if(db)await db.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();}
},30000);
