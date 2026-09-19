import { Client } from 'pg';
import { poolConfig } from '../../db.js';

export interface WorkerLease { close(): Promise<void> }
export async function acquireLease(onLost: () => never, lane: 1 | 2 = 1): Promise<WorkerLease|null> {
  const connection = new Client(poolConfig({connectionTimeoutMillis:1000,statement_timeout:750,query_timeout:1000}));
  let closing=false, checking=false;
  const lost=()=>{if(!closing)onLost();};
  connection.on('error',lost);connection.on('end',lost);
  try {
    await connection.connect();
    const lock=await connection.query<{held:boolean}>('SELECT pg_try_advisory_lock(1936026977,$1) AS held',[lane]);
    if (!lock.rows[0]?.held) { closing=true;await connection.end();return null; }
  } catch (error) {closing=true;await connection.end().catch(()=>{});throw error;}
  const timer=setInterval(()=>{
    if(checking||closing)return;
    checking=true;
    void connection.query('SELECT 1').catch(lost).finally(()=>{checking=false;});
  },500);
  return {close:async()=>{closing=true;clearInterval(timer);await connection.end();}};
}
export function terminateInference(): never {
  process.kill(process.pid,'SIGKILL');
  throw new Error('SIGKILL did not terminate semantic worker');
}
