import { getPool } from './db.js';

// Two-key PostgreSQL advisory namespace. hashtext collisions only
// over-serialize unrelated slugs; they can never weaken mutual exclusion.
const PROJECTION_LOCK_NAMESPACE = 31031;

export async function withProjectProjectionLocks<T>(
  slugs: readonly string[], work: () => Promise<T>
): Promise<T> {
  const ordered = [...new Set(slugs)].sort();
  const client = await getPool().connect();
  const acquired: string[] = [];
  let releaseFailure: Error | undefined;
  try {
    for (const slug of ordered) {
      await client.query(
        `SELECT pg_advisory_lock($1::integer, hashtext($2))`,
        [PROJECTION_LOCK_NAMESPACE, slug]
      );
      acquired.push(slug);
    }
    return await work();
  } finally {
    for (const slug of acquired.reverse()) {
      try {
        const unlocked = await client.query<{ ok: boolean }>(
          `SELECT pg_advisory_unlock($1::integer, hashtext($2)) AS ok`,
          [PROJECTION_LOCK_NAMESPACE, slug]
        );
        if (unlocked.rows[0]?.ok !== true) {
          releaseFailure ??= new Error(`projection lock was not held for '${slug}'`);
        }
      } catch (err) {
        releaseFailure ??= err instanceof Error ? err : new Error(String(err));
      }
    }
    // Passing an error destroys the pool client, guaranteeing a failed unlock
    // can never return a session-level lock to the pool.
    client.release(releaseFailure);
    if (releaseFailure !== undefined) throw releaseFailure;
  }
}

export function withProjectProjectionLock<T>(
  slug: string, work: () => Promise<T>
): Promise<T> {
  return withProjectProjectionLocks([slug], work);
}
