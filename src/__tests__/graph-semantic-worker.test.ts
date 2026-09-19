import { afterAll, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';
const dbUrl=requireDisposableTestDbUrl();process.env.MAI_DB_URL=dbUrl;
const admin=new Pool({connectionString:dbUrl});
const children:ChildProcessWithoutNullStreams[]=[];
function probe(){
  const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/semantic-worker-probe.mjs',import.meta.url))],{stdio:'pipe'});
  children.push(child);return child;
}
function firstLine(child:ChildProcessWithoutNullStreams):Promise<string>{
  return new Promise((resolve,reject)=>{
    let buffer='';const timer=setTimeout(()=>reject(new Error('probe did not reply')),5000);
    child.stdout.on('data',(chunk:Buffer)=>{buffer+=chunk.toString();if(buffer.includes('\n')){clearTimeout(timer);resolve(buffer.split('\n')[0]);}});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
  });
}
afterAll(async()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');await admin.end();});
it('excludes a second process and terminates the first when its lock connection is lost',async()=>{
  const first=probe();expect(await firstLine(first)).toBe('acquired');
  const second=probe();expect(await firstLine(second)).toBe('busy');
  const leases=await admin.query<{pid:number}>(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=1936026977 AND objid=1
    AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND granted`);
  expect(leases.rows).toHaveLength(1);
  const exited=once(first,'exit');
  await admin.query('SELECT pg_terminate_backend($1)',[leases.rows[0].pid]);
  const timer=new Promise((_,reject)=>setTimeout(()=>reject(new Error('old inference owner survived lock loss')),2000));
  await Promise.race([exited,timer]);expect(first.signalCode).toBe('SIGKILL');
  const replacement=probe();expect(await firstLine(replacement)).toBe('acquired');replacement.kill('SIGKILL');
},10000);
it('bounds initial DB statements and fresh lexical fallback while both are blocked',async()=>{
  const name='mai_plan23_semdeadline_'+randomUUID().replaceAll('-','');
  const stalled=new URL(dbUrl);stalled.pathname='/'+name;
  await admin.query('CREATE DATABASE "'+name+'"');
  const isolated=new Pool({connectionString:stalled.toString()});
  const lock=await isolated.connect();
  try{
    await isolated.query(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'));
    await lock.query('BEGIN');await lock.query('LOCK TABLE graph_nodes IN ACCESS EXCLUSIVE MODE');
    process.env.MAI_DB_URL=stalled.toString();
    const {scopedSearch}=await import('../graph/semantic/service.js');const started=performance.now();
    const result=await scopedSearch({projectId:'00000000-0000-4000-8000-000000000001'},{query:'anything',limit:1});
    expect(result.reasons).toEqual(['database_unavailable']);expect(result.nodes).toEqual([]);expect(performance.now()-started).toBeLessThan(25000);
  }finally{
    process.env.MAI_DB_URL=dbUrl;await lock.query('ROLLBACK');lock.release();await isolated.end();
    await admin.query('DROP DATABASE "'+name+'" WITH (FORCE)');
  }
},35000);
