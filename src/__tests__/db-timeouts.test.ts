/** DB/git stall bounds — the mai_prime freeze fix (2026-07-14).
 * Every external wait must be bounded: a wedged Docker port-forward or a lock
 * held by another session must surface as a fast, explained error — never a
 * silent multi-minute hang (observed: 4.5 min in a Codex session). */
import { describe, it, expect } from 'vitest';
import { poolConfig, beginBulkTransaction, dbErrorHint } from '../db.js';
import { execBounded, GIT_EXEC_TIMEOUT_MS } from '../git/repo.js';

describe('poolConfig', () => {
  it('bounds every wait: connect, server statement, client query backstop, idle-in-tx', () => {
    const cfg = poolConfig();
    expect(cfg.connectionTimeoutMillis).toBe(5_000);
    expect(cfg.keepAlive).toBe(true);
    expect(cfg.statement_timeout).toBe(60_000);
    // Client-side backstop MUST outlast the server-side bound — it exists for
    // the dead-connection case where the server never gets to enforce anything.
    expect(cfg.query_timeout).toBe(300_000);
    expect(cfg.idle_in_transaction_session_timeout).toBe(120_000);
  });

  it('accepts overrides (remote consumer DBs) while keeping the bounds it does not override', () => {
    const cfg = poolConfig({ connectionString: 'postgresql://ro@example.com/x', max: 2 });
    expect(cfg.connectionString).toBe('postgresql://ro@example.com/x');
    expect(cfg.max).toBe(2);
    expect(cfg.connectionTimeoutMillis).toBe(5_000);
    expect(cfg.statement_timeout).toBe(60_000);
  });
});

describe('beginBulkTransaction', () => {
  it('opens the transaction then relaxes the server-side bounds LOCALLY (bulk graph/ingest work)', async () => {
    const ran: string[] = [];
    const stub = {
      query: async (text: string): Promise<unknown> => {
        ran.push(text);
        return undefined;
      },
    };
    await beginBulkTransaction(stub);
    expect(ran[0]).toBe('BEGIN');
    // SET LOCAL (not SET): the relaxation must die with the transaction so a
    // returned pool client never carries unbounded settings to the next caller.
    expect(ran.slice(1)).toEqual([
      'SET LOCAL statement_timeout = 0',
      'SET LOCAL idle_in_transaction_session_timeout = 0',
    ]);
  });
});

describe('dbErrorHint', () => {
  it('maps connect-timeout and stall errors to an actionable brain-DB message', () => {
    for (const msg of [
      'timeout exceeded when trying to connect',
      'Connection terminated due to connection timeout',
      'connect ECONNREFUSED 127.0.0.1:54334',
      'Query read timeout',
      'canceling statement due to statement timeout',
    ]) {
      const hint = dbErrorHint(new Error(msg));
      expect(hint).toContain('mai-brain-pg');
      expect(hint).toContain('54334');
    }
  });

  it('stays silent for non-DB errors (no misleading hints on validation failures)', () => {
    expect(dbErrorHint(new Error("Project not found for pinned slug 'x'"))).toBeNull();
    expect(dbErrorHint('plain string error')).toBeNull();
  });
});

describe('execBounded', () => {
  it('defaults to a bounded git timeout', () => {
    expect(GIT_EXEC_TIMEOUT_MS).toBe(60_000);
  });

  it('kills a hung subprocess at the configured bound instead of waiting forever', async () => {
    const started = Date.now();
    await expect(execBounded('sleep', ['30'], { timeout: 200 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
