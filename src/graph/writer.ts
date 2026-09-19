import { Pool, type PoolClient } from 'pg';
import { poolConfig, withDatabasePool } from '../db.js';

// Hash collisions conservatively serialize unrelated projects.
const GRAPH_WRITER_NAMESPACE = 1735553392;

export class GraphWriterBusyError extends Error {
  constructor() {
    super('Another graph build/update is running for this project; retry after it completes.');
    this.name = 'GraphWriterBusyError';
  }
}

function lostWriter(): never {
  process.stderr.write('Graph writer lease lost; stopping this process. Retry the graph command.\n');
  process.exit(1);
}

/** The private pool's sole session owns both the lease and every brain write.
 * A silent disconnect therefore fences writes at PostgreSQL immediately. */
export async function withGraphWriter<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  const pool = new Pool(poolConfig({
    application_name: 'mai-graph-writer',
    max: 1,
    idleTimeoutMillis: 0,
    maxLifetimeSeconds: 0,
    maxUses: Infinity,
  }));
  let phase: 'acquiring' | 'held' | 'closing' = 'acquiring';
  let lost = false;
  let owner: PoolClient | undefined;
  let checkout: PoolClient | undefined;
  let ended: Promise<void> = Promise.resolve();
  const onLost = (): void => {
    lost = true;
    if (phase === 'held') lostWriter();
  };
  pool.on('error', onLost);
  pool.on('connect', (client) => {
    // pg emits connect before delivering a new session to any query caller.
    // max:1 alone would allow reconnection after the original session vanished.
    if (owner) lostWriter();
    owner = client;
    ended = new Promise(resolve => client.once('end', resolve));
    client.on('error', onLost);
    client.on('end', onLost);
  });
  try {
    let held: boolean;
    try {
      checkout = await pool.connect();
      const acquisition = {
        text: 'SELECT pg_try_advisory_lock($1::integer, hashtext($2)) AS held',
        values: [GRAPH_WRITER_NAMESPACE, projectId.toLowerCase()],
        query_timeout: 3_000,
      };
      const result = await checkout.query<{ held: boolean }>(acquisition);
      held = result.rows[0]?.held === true;
      if (lost) throw new Error('connection lost');
    } catch {
      throw new Error('Cannot acquire graph writer lease; check the brain database and retry.');
    }
    if (!held) throw new GraphWriterBusyError();
    checkout.release();
    checkout = undefined;
    phase = 'held';
    return await withDatabasePool(pool, work);
  } finally {
    phase = 'closing';
    checkout?.release();
    await pool.end();
    // Pool.end may finish before the physical session has finished closing.
    await ended;
  }
}
