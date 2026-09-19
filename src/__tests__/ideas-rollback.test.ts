import { describe, expect, it, vi } from 'vitest';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const testDbUrl = requireDisposableTestDbUrl();
process.env.MAI_TEST_DB_URL = testDbUrl;
process.env.MAI_DB_URL = testDbUrl;

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock('../db.js', () => ({
  getPool: () => ({ connect: mocks.connect }),
  getProjectId: vi.fn(),
}));

import { ideaOperatorReorder } from '../ideas.js';

describe('ideaOperatorReorder rollback handling', () => {
  it('preserves the original operation error when rollback also fails', async () => {
    const original = new Error('lock query lost its connection');
    const query = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(original)
      .mockRejectedValueOnce(new Error('rollback connection already closed'));
    const release = vi.fn();
    mocks.connect.mockResolvedValueOnce({ query, release });
    const id = '11111111-2222-3333-4444-555555555555';

    await expect(ideaOperatorReorder({
      ideaId: id,
      status: 'planned',
      scope: 'project',
      includeClosed: false,
      expectedIds: [],
      orderedIds: [id],
      projectId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })).rejects.toBe(original);

    expect(query).toHaveBeenNthCalledWith(3, 'ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
